import {
  JoinRequestSchema,
  type JoinResponse,
  NODE_CHANGED,
  type PairingCode,
} from '@keith/contracts'
import type { JoinResult, NodesRepo, PairingRepo } from '@keith/db'
import type { ActivityStore } from 'eharness/activity'
import {
  generatePairingCode,
  hashPairingCode,
  normalizePairingCode,
  PAIRING_ALPHABET,
  pairingGuard,
} from 'eharness/identity'
import { hashToken, newToken } from '../auth/index.ts'
import { emit } from '../brain-events/index.ts'
import { CORE_NODE_ID } from './core-node.ts'
import type { NodeRegistry } from './types.ts'

/** A pairing code lives this long (P4 decisions). */
export const PAIRING_TTL_MS = 600_000
/** Prefix of a node token (the owner token is `keith_`). */
const NODE_TOKEN_PREFIX = 'keith_node_'

/** A new node token in clear (only its hash is stored). Used by join and by rotation. */
export function newNodeToken(): string {
  return `${NODE_TOKEN_PREFIX}${newToken().slice('keith_'.length)}`
}

/** Largest accepted `POST /nodes/join` body (the route is open before authentication). */
export const JOIN_BODY_MAX = 16_384

export class PairingLimitError extends Error {}

export interface PairingOptions {
  pairing: PairingRepo
  nodes: NodesRepo
  /** Read the registry for the node list (a name must be free before a code is spent). */
  registry: NodeRegistry
  store: ActivityStore
  ttlMs?: number
  heartbeatMs: number
  /** URL nodes use to reach core, for the join command. */
  publicUrl: () => string
  /** Failed joins allowed per client key inside the window (default 5 per hour). */
  maxFailures?: number
  failureWindowMs?: number
  /** A node joined: audit it (never throws into the join). */
  onPaired?: (info: { nodeId: string; name: string; ip: string }) => void
  now?: () => number
  warn?: (message: string) => void
}

export interface Pairing {
  /** A new code for `createdBy`; throws `PairingLimitError` when 3 are already active. */
  issue(createdBy: string): Promise<PairingCode>
  /** `POST /nodes/join`: exchange a code for a node token. `clientKey` identifies the caller. */
  join(request: Request, clientKey: string): Promise<Response>
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
const refuse = (status: number, code: string, message: string): Response =>
  json(status, { error: { code, message } })

/** `ABCD-EFGH`. */
const formatCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`

function wellFormed(code: string): boolean {
  return code.length === 8 && [...code].every((c) => PAIRING_ALPHABET.includes(c))
}

/** Pairing: codes for the owner, `POST /nodes/join` for the machine that joins. */
export function createPairing(options: PairingOptions): Pairing {
  const now = options.now ?? Date.now
  const guard = pairingGuard({
    maxFailures: options.maxFailures ?? 5,
    windowMs: options.failureWindowMs ?? 3_600_000,
  })

  return {
    async issue(createdBy) {
      const code = normalizePairingCode(generatePairingCode())
      const created = options.pairing.create({
        hash: await hashPairingCode(code),
        createdBy,
        ttlMs: options.ttlMs ?? PAIRING_TTL_MS,
      })
      if (!created.ok) {
        throw new PairingLimitError(
          'three pairing codes are already waiting: use one or wait for it to expire',
        )
      }
      const shown = formatCode(code)
      return {
        code: shown,
        expiresAt: created.expiresAt,
        joinCommand: `bun apps/node/src/main.ts join --core ${options.publicUrl()} --code ${shown}`,
      }
    },
    async join(request, clientKey) {
      if (!guard.allowed(clientKey, now())) {
        return refuse(429, 'TOO_MANY_ATTEMPTS', 'too many failed pairing attempts: try again later')
      }
      const failure = (status: number, code: string, message: string): Response => {
        guard.failure(clientKey, now())
        return refuse(status, code, message)
      }
      const declared = Number(request.headers.get('content-length') ?? 0)
      if (declared > JOIN_BODY_MAX) return refuse(413, 'TOO_LARGE', 'the join request is too large')
      let body: unknown
      try {
        const text = await request.text()
        if (text.length > JOIN_BODY_MAX)
          return refuse(413, 'TOO_LARGE', 'the join request is too large')
        body = JSON.parse(text)
      } catch {
        return refuse(400, 'BAD_REQUEST', 'the body must be JSON')
      }
      const parsed = JoinRequestSchema.safeParse(body)
      if (!parsed.success) {
        return refuse(400, 'BAD_REQUEST', `invalid join request: ${parsed.error.message}`)
      }
      const { manifest } = parsed.data
      const code = normalizePairingCode(parsed.data.code)
      if (!wellFormed(code)) return failure(400, 'INVALID_CODE', 'that is not a pairing code')
      const token = newNodeToken()
      // one transaction: code checked, name checked, node created, code spent (ADR-0027 §13)
      let outcome: JoinResult
      try {
        outcome = options.nodes.joinWithCode({
          codeHash: await hashPairingCode(code),
          reserved: manifest.name === CORE_NODE_ID,
          node: {
            name: manifest.name,
            os: manifest.os,
            arch: manifest.arch,
            version: manifest.version,
            manifest,
            allowShell: manifest.policy.allowShell,
            tokenHash: await hashToken(token),
          },
        })
      } catch (error) {
        options.warn?.(
          `join: could not create node: ${error instanceof Error ? error.message : error}`,
        )
        return failure(409, 'NAME_TAKEN', 'could not pair: that name may already be in use')
      }
      if (!outcome.ok) {
        if (outcome.reason === 'name-taken') {
          return failure(
            409,
            'NAME_TAKEN',
            `a node named "${manifest.name}" exists: pick another --name`,
          )
        }
        const message = {
          unknown: 'unknown pairing code',
          used: 'that pairing code was already used: ask for a new one with /pair',
          expired: 'that pairing code expired: ask for a new one with /pair',
        }[outcome.reason]
        return failure(400, `CODE_${outcome.reason.toUpperCase()}`, message)
      }
      guard.success(clientKey)
      const node = outcome.node
      const view = options.registry.find(node.id)
      if (view !== undefined)
        emit(options.store, NODE_CHANGED, null, null, { node: view }, options.warn)
      try {
        options.onPaired?.({ nodeId: node.id, name: manifest.name, ip: clientKey })
      } catch {
        // the join already succeeded
      }
      const reply: JoinResponse = { nodeId: node.id, token, heartbeatMs: options.heartbeatMs }
      return json(200, reply)
    },
  }
}
