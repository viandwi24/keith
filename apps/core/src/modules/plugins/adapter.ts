import type {
  ActorDirectory,
  Guard,
  GuardCall,
  KeithPlugin,
  ResolvedOperation,
  SessionFacts,
} from '@keith/host'
import { GuardError, harnessNameOf } from '@keith/host'
import { tool } from 'ai'
import {
  definePlugin,
  defineToolSource,
  type HarnessContext,
  type HarnessPlugin,
  type ToolRisk,
} from 'eharness'

export interface AdapterDeps {
  guard: Guard
  directory: ActorDirectory
}

/** Why the model is asked first before a `dangerous` operation. */
export const DANGEROUS_REASON = 'this operation is marked dangerous by its plugin'

const RISK: Record<ResolvedOperation['risk'], ToolRisk> = {
  read: 'read',
  write: 'write',
  dangerous: 'destructive',
}

/**
 * The facts of a call that comes from a turn, read from the live context when the tool runs: a worker
 * session has a parent, a wake turn is a `wake`. A chat turn is never elevated (a step-up is an HTTP fact).
 */
export function sessionFactsOf(ctx: HarnessContext): SessionFacts {
  const id = ctx.session.id
  const worker = ctx.session.parent !== undefined || id.includes(':agent:')
  return {
    id,
    kind: worker ? 'worker' : ctx.turn?.kind === 'wake' ? 'wake' : 'front',
    method: null,
    elevated: false,
  }
}

/**
 * Compiles a Keith plugin into one eharness plugin `k-<id>` with one tool source (docs/specs/plugins.md).
 *
 * - The source is listed **every turn** (`refresh: 'turn'`) and shows only what the person's facts allow
 *   (`guard.visible`: status, capabilities, audience, never ACL state), so the list is stable per person.
 * - `execute` reads `ctx.principal` **when the tool runs**; the guard re-reads the person and builds the
 *   context for that call. Nothing about a person is captured at listing time.
 * - `tool.approve` decides from the tool name, the static declaration and the session's principal kind (it is
 *   re-run on re-validation): a `dangerous` operation asks; an operation hidden from the AI (or, in a guest
 *   session, not marked `expose.guest`) is denied.
 */
export function compilePlugin(plugin: KeithPlugin, deps: AdapterDeps): HarnessPlugin {
  const byTool = new Map(plugin.operations.map((op) => [op.toolName, op]))

  const toolOf = (op: ResolvedOperation, ctx: HarnessContext) =>
    tool({
      description: op.description,
      inputSchema: op.input,
      metadata: { risk: RISK[op.risk], keithPlugin: plugin.id, keithOperation: op.name },
      execute: async (input: unknown, options) => {
        const call: GuardCall = {
          // live: eharness resolves this getter against the running turn
          principal: ctx.principal,
          session: sessionFactsOf(ctx),
          ...(options?.abortSignal === undefined ? {} : { signal: options.abortSignal }),
        }
        try {
          return await deps.guard.run(op, input, call)
        } catch (error) {
          // the model sees the guard's own safe message, nothing else
          if (error instanceof GuardError) throw new Error(error.message)
          throw new Error('the operation failed')
        }
      },
    })

  const source = defineToolSource({
    id: `keith:${plugin.id}`,
    refresh: 'turn',
    list: async (ctx) => {
      const principalId = ctx.principal?.id
      const facts =
        principalId === undefined || principalId === ''
          ? undefined
          : await deps.directory.resolve(principalId)
      const tools: Record<string, ReturnType<typeof toolOf>> = {}
      for (const op of plugin.operations) {
        if (deps.guard.visible(op, facts, 'ai')) tools[op.toolName] = toolOf(op, ctx)
      }
      return tools
    },
  })

  return definePlugin({
    name: harnessNameOf(plugin.id),
    ...(plugin.manifest.version === undefined ? {} : { version: plugin.manifest.version }),
    setup: () => ({
      tools: source,
      hooks: {
        'tool.approve': (ctx, e) => {
          const op = byTool.get(e.toolName)
          if (op === undefined) return
          // a guest session's principal is `guest:<id>` (set when the session is opened, never from live state):
          // its model is offered `expose.guest` operations; a person's model is offered `expose.ai` ones
          const guest = ctx.principal?.id.startsWith('guest:') === true
          if (!(guest ? op.expose.guest : op.expose.ai))
            return { type: 'denied' as const, reason: 'this operation is not offered to the model' }
          if (op.risk === 'dangerous')
            return { type: 'user-approval' as const, reason: DANGEROUS_REASON }
        },
      },
    }),
  })
}
