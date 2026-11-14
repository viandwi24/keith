/**
 * P31 step P31.3.6: a member's worker asks for a screenshot through a node that announces the `desktop` driver. The
 * approval is routed to the owner (the member sees it and cannot answer), the image lands only in the member's
 * workspace folder (`people/<member>/`), and the owner's worker never sees it. Real core and socket, scripted models, a
 * test node whose executor returns the image (docs/specs/node-drivers.md, "Driver desktop"; ADR-0020 §3, ADR-0021 §2).
 * The desktop specs are built into the core (contracts `CAPABILITIES`), so no `CoreOptions.nodeCapabilities` is needed.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createKeithClient } from '@keith/client'
import type { NodeManifest } from '@keith/contracts'
import { personWorkspaceDir } from './platform/workspace-paths.ts'
import { cleanup, tasksOf } from './testing/core-harness.ts'
import { issueOwnerToken } from './testing/owner-token.ts'
import {
  answerApproval,
  ask,
  type Booted,
  baseUrl,
  motorCall,
  scenario,
  waitForAttention,
} from './testing/scenario-harness.ts'
import { until } from './testing/wait.ts'

afterAll(cleanup)

const PASS = `quartz ${Bun.hash('p31desk')} rivers hum softly`
const PIN = '615243'
/** The image bytes the fake desktop driver returns (a JPEG is not checked by the core beyond its MIME type). */
const JPEG = Buffer.from(`fake-jpeg-${Bun.hash('p31-image')}`)
const B64 = JPEG.toString('base64')

/** A v2 manifest that announces the desktop driver with its screenshot (and info) capability, as `driver add` would. */
const DESKTOP_MANIFEST: NodeManifest = {
  manifestVersion: 2,
  name: 'laptop-e',
  os: 'testos',
  arch: 'x64',
  version: '0.0.0-test',
  policy: { allowShell: false },
  drivers: [
    {
      name: 'system',
      version: '0.0.0-test',
      capabilities: [{ id: 'system.info', schemaVersion: 1 }],
    },
    {
      name: 'shell',
      version: '0.0.0-test',
      capabilities: [{ id: 'shell.exec', schemaVersion: 1 }],
    },
    {
      name: 'desktop',
      version: '0.1.0',
      capabilities: [
        { id: 'desktop.info', schemaVersion: 1 },
        { id: 'desktop.screenshot', schemaVersion: 1 },
      ],
    },
  ],
}

/** Answers `desktop.screenshot` with the image; anything else is refused (the test node is a desktop node only). */
const screenExecutor = async ({ invoke }: { invoke: { capability: string } }) =>
  invoke.capability === 'desktop.screenshot'
    ? {
        ok: true as const,
        output: { data: B64, mimeType: 'image/jpeg', width: 4, height: 4, scale: 1 },
      }
    : {
        ok: false as const,
        error: { code: 'unknown-capability' as const, message: `no ${invoke.capability}` },
      }

/** Every file under a folder, relative paths (the folder may not exist yet). */
function filesUnder(dir: string): string[] {
  try {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...filesUnder(path))
      else if (statSync(path).isFile()) out.push(path)
    }
    return out
  } catch {
    return []
  }
}

async function setup() {
  const s = await scenario({
    nodes: [{ name: 'laptop-e', manifest: DESKTOP_MANIFEST, executor: screenExecutor }],
    front: [
      // member turn: delegate, acknowledge, report
      {
        toolCalls: [
          {
            toolName: 'agent',
            toolCallId: 'c1',
            input: {
              subagent_type: 'cortex.general',
              description: 'screen',
              prompt: 'Look at the screen.',
              run_in_background: true,
            },
          },
        ],
      },
      { text: 'Okay, I will look.' },
      { text: 'Done: the screen was checked.' },
      // owner turn: the same shape, a second worker
      {
        toolCalls: [
          {
            toolName: 'agent',
            toolCallId: 'c2',
            input: {
              subagent_type: 'cortex.general',
              description: 'desk',
              prompt: 'Check the owner desk.',
              run_in_background: true,
            },
          },
        ],
      },
      { text: 'Okay, I will check.' },
      { text: 'Done: nothing to do on the desk.' },
    ],
    worker: [
      { toolCalls: [motorCall('d1', 'laptop-e', 'desktop.screenshot', {})] },
      { text: 'I can see the screen.' },
      { text: 'Nothing to do on the desk.' },
    ],
  })
  const base = baseUrl(s.r)
  const ana = await s.r.client.rpc.admin.people.add({ username: 'ana' })
  await s.r.client.rpc.admin.people.setPassword({ person: 'ana', password: PASS })
  await s.r.client.rpc.admin.people.setPin({ person: 'owner', pin: PIN })
  const login = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'ana', password: PASS }),
  })
  const member = ((await login.json()) as { credential: string }).credential
  const cold = await issueOwnerToken(
    { dataDir: s.dataDir, dbFile: `${s.dataDir}/keith.db` } as never,
    'cold',
    { elevated: false },
  )
  return { s, base, ana, member, cold, session: `front:${ana.id}` }
}

describe('a member asks a desktop node for a screenshot', () => {
  test('the owner answers; the image lands only in the member folder; the owner worker never sees it', async () => {
    const t = await setup()
    const memberClient = createKeithClient({ baseUrl: t.base, token: t.member })

    // the member asks; the worker's motor_remote call waits for the owner
    for await (const _ of memberClient.reply('take a screenshot of the laptop', t.session)) {
      // drain: the stream ends with the turn
    }
    const mine = await until(
      'the member sees the waiting item',
      async () => {
        const res = await fetch(`${t.base}/attention`, {
          headers: { authorization: `Bearer ${t.member}` },
        })
        return (
          (
            (await res.json()) as {
              items?: Array<{ id: string; sessionId: string; extra?: Record<string, unknown> }>
            }
          ).items ?? []
        )
      },
      (items) => items.length >= 1,
    )
    expect(mine[0]?.extra).toMatchObject({ waitingFor: 'owner' })

    // the member cannot approve it: refused, and the node was never asked
    const refused = await fetch(`${t.base}/attention/${mine[0]?.id}/answer`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.member}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: mine[0]?.sessionId,
        answer: { kind: 'approval', approved: true },
      }),
    })
    expect(refused.status).toBe(403)
    expect(t.s.nodes['laptop-e']?.invokes.map((i) => i.capability)).not.toContain(
      'desktop.screenshot',
    )

    // the owner sees who asked and what for; the owner answers
    const [item] = await waitForAttention(t.s.r)
    expect(item).toMatchObject({
      kind: 'approval',
      toolName: 'motor_remote',
      input: { node: 'laptop-e', capability: 'desktop.screenshot' },
    })
    expect((await answerApproval(t.s.r as Booted, item as never, { approved: true })).status).toBe(
      'resumed',
    )
    await until(
      'the member task is done',
      () => tasksOf(memberClient),
      (tasks) => tasks.length >= 1 && tasks.every((task) => task.status === 'done'),
      20_000,
    )
    expect(t.s.nodes['laptop-e']?.invokes.map((i) => i.capability)).toContain('desktop.screenshot')

    // the member's worker saw the image; the image file is in the member's folder only
    const memberPrompts = t.s.workerPrompts().join('\n')
    expect(memberPrompts).toContain(B64)
    const memberFiles = filesUnder(personWorkspaceDir(t.s.dataDir, t.ana.id))
    const memberImages = memberFiles.filter((file) => readFileSync(file).equals(JPEG))
    expect(memberImages.length).toBeGreaterThanOrEqual(1)
    const ownerFiles = filesUnder(personWorkspaceDir(t.s.dataDir, 'owner'))
    expect(ownerFiles.filter((file) => readFileSync(file).equals(JPEG))).toEqual([])

    // the owner's own worker runs after that; it never sees the image, its path or its bytes
    const before = t.s.workerPrompts().length
    await ask(t.s.r, 'check my desk')
    await until(
      'the owner worker ran',
      async () => t.s.workerPrompts().length,
      (n) => n > before,
      20_000,
    )
    const ownerPrompts = t.s.workerPrompts().slice(before).join('\n')
    expect(ownerPrompts).not.toContain(B64)
    expect(ownerPrompts).not.toContain(t.ana.id)
    expect(
      filesUnder(personWorkspaceDir(t.s.dataDir, 'owner')).filter((file) =>
        readFileSync(file).equals(JPEG),
      ),
    ).toEqual([])
  }, 90_000)
})
