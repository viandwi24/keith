import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '@keith/cli'
import { fakeIo } from '@keith/cli/testing'
import { resolveTheme } from '@keith/ui'
import type { UIMessage } from 'ai'
import { keithCommands } from '../commands.tsx'
import { hasColour, stripAnsi } from './ansi.ts'
import { approval, askedByApproval, node, task, waitingApproval } from './fixtures.ts'
import { frameUntil, pressUntil, typeLine } from './ink.ts'
import { type SetupOptions, setupApp, stopCores } from './setup-app.tsx'

/**
 * The gate frames of tui-design section 8: the screens at 100 x 30 as text files, once in the dark
 * theme with truecolor (escape codes kept) and once without colour (`*.plain.txt`).
 *
 *   FORCE_COLOR=3 KEITH_FRAMES_DIR=/some/dir bun test ./apps/tui/src/testing/frames.test.ts
 *
 * Skipped unless `KEITH_FRAMES_DIR` is set (it is a review aid, not part of `bun run check`).
 */
const dir = Bun.env.KEITH_FRAMES_DIR
afterEach(stopCores)

const now = Date.now()
const history = [
  {
    id: 'u1',
    role: 'user',
    parts: [{ type: 'text', text: "what's using my disk on the laptop?" }],
  },
  {
    id: 'a1',
    role: 'assistant',
    parts: [
      { type: 'text', text: 'Let me check on laptop-e.' },
      {
        type: 'tool-motor_remote',
        toolCallId: 'c1',
        state: 'output-available',
        input: { node: 'laptop-e', capability: 'shell.exec', input: { command: 'df -h' } },
        output: {
          ok: true,
          node: 'laptop-e',
          capability: 'shell.exec',
          output: [
            '/dev/disk3s1  460Gi  401Gi  41Gi  91%  /System/Volumes/Data',
            '/dev/disk3s3  460Gi  5.1Gi  41Gi  12%  /System/Volumes/Preboot',
            '/dev/disk3s2  460Gi  2.3Gi  41Gi   6%  /System/Volumes/VM',
            '/dev/disk3s4  460Gi  1.2Gi  41Gi   3%  /System/Volumes/Update',
            'map auto_home    0Bi    0Bi   0Bi   -   /System/Volumes/Data/home',
          ].join('\n'),
          exitCode: 0,
        },
      },
      {
        type: 'tool-agent',
        toolCallId: 'c2',
        state: 'output-available',
        input: { agent: 'cortex.research', description: 'find disk usage on laptop-e' },
        output: 'Started background subagent agent-1',
      },
      {
        type: 'text',
        text: 'Your main volume is at **91 %**. Most of it is under `~/Library/Caches` (38 GB).\n\n- ~/Library/Caches 38 GB\n- ~/Downloads 21 GB\n\nWant me to look deeper?',
      },
    ],
  },
  {
    id: 'a2',
    role: 'assistant',
    parts: [
      { type: 'data-keith.proactive', data: {} },
      { type: 'text', text: 'research finished: three folders hold 72 % of the space.' },
    ],
  },
] as unknown as UIMessage[]

const tasks = () => [
  task({ id: 't1', description: 'find disk usage on laptop-e', createdAt: now - 42_000 }),
  task({
    id: 't2',
    agent: 'cortex.news',
    description: 'morning brief',
    status: 'waiting',
    createdAt: now - 65_000,
  }),
  task({
    id: 't3',
    description: 'compare laptop prices under $800',
    status: 'done',
    createdAt: now - 400_000,
    finishedAt: now - 210_000,
    summary: 'Three laptops fit the budget.',
  }),
  task({
    id: 't4',
    description: 'read the router admin page',
    status: 'failed',
    createdAt: now - 500_000,
    finishedAt: now - 488_000,
    error: 'the page needs a login',
  }),
]
const nodes = () => [
  node({ id: 'n1', name: 'laptop-e', os: 'darwin', arch: 'arm64', version: '0.9.0' }),
  node({
    id: 'n2',
    name: 'pi-garage',
    os: 'linux',
    arch: 'arm64',
    version: '0.9.0',
    status: 'offline',
    allowShell: false,
    capabilities: ['system.info'],
    lastSeenAt: now - 7_200_000,
  }),
]

const ana = {
  personId: 'ana-id',
  name: 'Ana',
  username: 'ana',
  role: 'member' as const,
  via: 'tcp' as const,
  credentialKind: 'device' as const,
  elevated: false,
}
const rpcOf = (who: object = {}): NonNullable<SetupOptions['rpc']> => ({
  'health/get': () => ({ status: 'ok', version: '0.9.0', sha: 'a1b2c3d', boot: 'b' }),
  'models/roles/get': () => ({ front: 'openrouter/anthropic/claude-sonnet-4.5', cortex: null }),
  'tasks/list': tasks,
  'nodes/list': nodes,
  'auth/whoami': () => ({
    personId: 'owner',
    name: 'vian',
    username: 'vian',
    role: 'owner',
    via: 'tcp',
    credentialKind: 'device',
    elevated: false,
    ...who,
  }),
})
const base = (): SetupOptions => ({
  columns: 100,
  rows: 30,
  history,
  attention: [],
  rpc: rpcOf(),
  budget: { spentUsd: 3.21, limitUsd: 20 },
})

function save(name: string, color: string, plain: string): void {
  if (dir === undefined) return
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.txt`), `${color}\n`)
  // the plain file is for reading: bold and dim escapes are stripped too
  writeFileSync(join(dir, `${name}.plain.txt`), `${stripAnsi(plain)}\n`)
}

type Frames = { lastFrame(): string | undefined; stdin: { write(s: string): void } }
interface Scene {
  name: string
  options?: Partial<SetupOptions>
  /** Drive the app to the screen that is photographed. */
  drive(app: Frames & { core: Awaited<ReturnType<typeof setupApp>>['core'] }): Promise<string>
}

const scenes: Scene[] = [
  {
    name: 'chat',
    async drive({ lastFrame, core }) {
      await frameUntil(lastFrame, (f) => f.includes('pi-garage') && f.includes('morning bri'))
      core.emit({
        type: 'brain.cortex.start',
        payload: {
          region: 'cortex',
          taskId: 't1',
          agent: 'cortex.research',
          description: 'find disk usage on laptop-e',
        },
      })
      core.emit({
        type: 'brain.motor.act',
        payload: { region: 'motor', toolName: 'motor_remote', ok: true },
      })
      return frameUntil(
        lastFrame,
        (f) => f.includes('Cortex ×1') && f.includes('motor motor_remote'),
      )
    },
  },
  {
    name: 'approval-unfocused',
    options: {
      attention: [
        approval({
          id: 'ap1',
          command: 'rm -rf ~/Library/Caches/*',
          description: 'find disk usage on laptop-e',
          agent: 'cortex.research',
        }),
      ],
    },
    drive: ({ lastFrame }) => frameUntil(lastFrame, (f) => f.includes('tab to answer')),
  },
  {
    name: 'approval-focused',
    options: {
      attention: [
        approval({
          id: 'ap1',
          command: 'rm -rf ~/Library/Caches/*',
          description: 'find disk usage on laptop-e',
          agent: 'cortex.research',
        }),
        approval({ id: 'ap2', createdAt: 2000 }),
      ],
    },
    drive: ({ lastFrame, stdin }) =>
      pressUntil(stdin, lastFrame, '\t', (f) => f.includes('[y] allow')),
  },
  {
    name: 'tasks',
    async drive({ lastFrame, stdin }) {
      await frameUntil(lastFrame, (f) => f.includes('morning bri'))
      await typeLine(stdin, '/tasks')
      return frameUntil(lastFrame, (f) => f.includes('4 tasks') && f.includes('[enter] open'))
    },
  },
  {
    name: 'nodes',
    async drive({ lastFrame, stdin }) {
      await frameUntil(lastFrame, (f) => f.includes('pi-garage'))
      await typeLine(stdin, '/nodes')
      return frameUntil(lastFrame, (f) => f.includes('shell allowed'))
    },
  },
  {
    name: 'brain-trace',
    async drive({ lastFrame, stdin, core }) {
      core.emit({
        type: 'brain.thalamus.routed',
        payload: { region: 'thalamus', sessionId: 'front:p1', preview: 'hi' },
      })
      core.emit({
        type: 'brain.cortex.step',
        payload: {
          region: 'cortex',
          taskId: 't1',
          agent: 'cortex.research',
          description: 'x',
          stepIndex: 0,
        },
      })
      core.emit({
        type: 'brain.motor.act',
        payload: { region: 'motor', toolName: 'motor_remote', ok: true },
      })
      core.emit({
        type: 'brain.amygdala.wait',
        payload: { region: 'amygdala', toolName: 'motor_remote', sessionId: 's', count: 1 },
      })
      await frameUntil(lastFrame, (f) => f.includes('› amygdala waits'))
      await typeLine(stdin, '/brain trace')
      return frameUntil(lastFrame, (f) => f.includes('Brain trace'))
    },
  },
  {
    name: 'stepup',
    options: {
      rpc: rpcOf(ana),
      stepUp: { required: true },
      attention: [
        approval({ id: 'ap1', command: 'rm -rf ~/Library/Caches/*', agent: 'cortex.research' }),
      ],
    },
    async drive({ lastFrame, stdin }) {
      await frameUntil(lastFrame, (f) => f.includes('tab to answer'))
      await pressUntil(stdin, lastFrame, '\t', (f) => f.includes('[y] allow'))
      await pressUntil(stdin, lastFrame, 'y', (f) => f.includes("Confirm it's you"))
      await Bun.sleep(150)
      for (const ch of '12') stdin.write(ch)
      return frameUntil(lastFrame, (f) => f.includes('••'))
    },
  },
  {
    name: 'member-waiting',
    options: {
      rpc: rpcOf(ana),
      budget: { scope: 'person:ana-id', limitUsd: 5, spentUsd: 1.5 },
      attention: [
        waitingApproval({
          command: 'rm -rf ~/Library/Caches/*',
          description: 'free some disk space',
        }),
      ],
    },
    drive: ({ lastFrame }) =>
      frameUntil(lastFrame, (f) => f.includes('Waiting for the owner to approve')),
  },
  {
    name: 'owner-asked-by',
    options: {
      attention: [askedByApproval({ command: 'rm -rf ~/Library/Caches/*' })],
    },
    drive: ({ lastFrame }) =>
      frameUntil(lastFrame, (f) => f.includes('asks to run a shell command')),
  },
  {
    name: 'budget-owner',
    options: {
      budget: {
        spentUsd: 4,
        people: [
          {
            personId: 'owner',
            username: 'vian',
            name: 'Vian',
            limitUsd: null,
            spentUsd: 2.5,
            reservedUsd: 0,
            remainingUsd: null,
          },
          {
            personId: 'ana-id',
            username: 'ana',
            name: 'Ana',
            limitUsd: 5,
            spentUsd: 1.5,
            reservedUsd: 0,
            remainingUsd: 3.5,
          },
        ],
      },
    },
    async drive({ lastFrame, stdin }) {
      await frameUntil(lastFrame, (f) => f.includes('type a message'))
      await typeLine(stdin, '/budget')
      return frameUntil(lastFrame, (f) => f.includes('People'))
    },
  },
  {
    name: 'budget-member',
    options: {
      rpc: rpcOf(ana),
      budget: { scope: 'person:ana-id', limitUsd: 5, spentUsd: 1.5 },
    },
    async drive({ lastFrame, stdin }) {
      await frameUntil(lastFrame, (f) => f.includes('type a message'))
      await typeLine(stdin, '/budget')
      return frameUntil(lastFrame, (f) => f.includes('Your cap'))
    },
  },
  {
    name: 'logged-out',
    async drive({ lastFrame, core }) {
      await frameUntil(lastFrame, (f) => f.includes('type a message'))
      core.revoke()
      return frameUntil(
        lastFrame,
        (f) => f.includes('keith reconnects') || f.includes('Keith reconnects'),
      )
    },
  },
]

describe.skipIf(dir === undefined)('gate frames', () => {
  for (const scene of scenes) {
    test(scene.name, async () => {
      const shots: string[] = []
      for (const depth of ['truecolor', 'none'] as const) {
        const app = await setupApp({
          ...base(),
          ...scene.options,
          theme: resolveTheme({ theme: 'dark', depth }),
        })
        await Bun.sleep(150)
        shots.push(await scene.drive(app))
        await Bun.sleep(150)
        shots[shots.length - 1] = app.rawFrame() ?? ''
        app.unmount()
        stopCores()
      }
      const [color = '', plain = ''] = shots
      // the colour pass needs chalk on: FORCE_COLOR=3
      expect(hasColour(color)).toBe(true)
      expect(hasColour(plain)).toBe(false)
      save(scene.name, color, plain)
    }, 60_000)
  }

  test('login', async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname
        if (path === '/auth/device/start')
          return Response.json({
            code: 'KTPW-4C7M',
            requestId: 'r1',
            expiresAt: Date.now() + 600_000,
            pollSecret: 'ps',
          })
        if (path === '/auth/device/poll')
          return Response.json({ status: 'approved', credential: 'keith_s_fake' })
        if (path === '/rpc/auth/whoami')
          return Response.json({
            json: {
              personId: 'owner',
              name: 'vian',
              role: 'owner',
              via: 'tcp',
              credentialKind: 'device',
            },
          })
        return new Response('not found', { status: 404 })
      },
    })
    const home = mkdtempSync(join(tmpdir(), 'keith-frames-'))
    const io = fakeIo()
    const core = `http://localhost:${server.port}`
    await runCli({
      program: 'keith',
      version: '0',
      commands: keithCommands({
        configPath: join(home, 'client.json'),
        dataDir: home,
        startChat: async () => 0,
        pollMs: 5,
        probe: async () => false,
      }),
      argv: ['login', '--core', core, '--label', 'laptop'],
      io,
    })
    server.stop(true)
    rmSync(home, { recursive: true, force: true })
    const out = io.out()
    expect(out).toContain('keith-core devices approve KTPW-4C7M')
    save('login', out, out)
  })
})
