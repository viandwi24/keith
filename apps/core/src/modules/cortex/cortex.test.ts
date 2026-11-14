import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Node } from '@keith/contracts'
import {
  migrateDatabase,
  openDatabase,
  settingsRepo,
  sqliteInbox,
  sqliteMessages,
  sqliteProfileStore,
  sqliteState,
  tasksRepo,
} from '@keith/db'
import { defineHarnessAgent, type HarnessAgent } from 'eharness'
import { inMemoryActivityStore } from 'eharness/activity'
import { sealedProfileStore } from 'eharness/providers'
import { type ScriptedModel, scriptedProvider } from 'eharness/testing'
import { silentLogger, toHarnessLogger } from '../../platform/logger.ts'
import { createVault, generateSecretKey } from '../../platform/vault.ts'
import {
  BUILTIN_CAPABILITY_SPECS,
  createNodeCapabilityRegistry,
  type NodeCapabilityRegistry,
  type NodeRegistry,
} from '../nodes/index.ts'
import { createProviderService } from '../providers/index.ts'
import { createCortex, WORKER_BUDGET, workspaceDir } from './index.ts'
import { migrateLegacyWorkspace, personWorkspaceDir } from './workspace.ts'

/** A registry without machines: enough for the workers' tool list. */
const noNodes: NodeRegistry = {
  list: () => [],
  find: () => undefined,
  invoke: async () => ({ ok: false, code: 'unknown-node', message: 'none' }),
  byCapability: () => [],
  revoke: () => undefined,
}

const KEY = ['sk', 'test', crypto.randomUUID().replaceAll('-', '')].join('-')
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** The machines a test gives the workers: the node registry and the capability registry they are accepted against. */
interface Machines {
  nodes?: NodeRegistry
  capabilities?: NodeCapabilityRegistry
}

async function setup(
  steps: Parameters<typeof scriptedProvider>[0]['models']['w'],
  openrouter: boolean | 'disabled' = false,
  machines: Machines = {},
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'keith-cortex-'))
  dirs.push(dataDir)
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  const { vault } = createVault(generateSecretKey(), '/unused')
  const scripted = scriptedProvider({ models: { w: steps } })
  const providers = createProviderService({
    store: sealedProfileStore({ inner: sqliteProfileStore(sqlite), vault }),
    settings: settingsRepo(sqlite),
    definitions: [scripted],
    catalogs: { offline: true },
  })
  await providers.ready()
  await providers.put({ providerId: 'scripted' })
  if (openrouter === 'disabled')
    await providers.put({ providerId: 'openrouter', settings: { apiKey: KEY }, enabled: false })
  else if (openrouter) await providers.put({ providerId: 'openrouter', settings: { apiKey: KEY } })
  await providers.setRole('cortex', 'scripted:w')
  const storage = {
    messages: sqliteMessages(sqlite),
    state: sqliteState(sqlite),
    inbox: sqliteInbox(sqlite),
  }
  const holder: { lead?: HarnessAgent } = {}
  const cortex = createCortex({
    providers,
    storage,
    store: inMemoryActivityStore(),
    tasks: tasksRepo(sqlite),
    logger: toHarnessLogger(silentLogger),
    lead: () => holder.lead as HarnessAgent,
    nodes: machines.nodes ?? noNodes,
    ...(machines.capabilities === undefined ? {} : { capabilities: machines.capabilities }),
    dataDir,
    timezone: 'UTC',
    inboxPollMs: 20,
  })
  holder.lead = defineHarnessAgent({
    id: 'front',
    model: scripted.create({}).languageModel('x'),
    contextWindow: 100_000,
    storage,
    logger: toHarnessLogger(silentLogger),
    plugins: [cortex.leadPlugin(() => holder.lead as HarnessAgent)] as never,
  })
  const model = scripted.created.get('w') as ScriptedModel | undefined
  const run = async (key: string, text: string, person = 'owner') => {
    const worker = cortex.worker(key) as HarnessAgent
    await worker
      .session(`front:${person}:agent:${key}`, {
        principal: { id: person },
        parent: {
          sessionId: `front:${person}`,
          turnId: 't',
          depth: 1,
          agent: key,
          description: text,
        },
      })
      .send(text).result
    return scripted.created.get('w') as ScriptedModel
  }
  const close = async () => {
    await holder.lead?.close()
    await cortex.close()
    await new Promise<void>((r) => setTimeout(r, 40))
    sqlite.close()
  }
  return { cortex, run, dataDir, close, model }
}

const toolNames = (model: ScriptedModel, call = 0): string[] =>
  (model.calls[call]?.tools ?? []).map((t) => (t as { name: string }).name).sort()

describe('cortex catalog', () => {
  test('two workers, none for an unknown key', async () => {
    const { cortex, close } = await setup([{ text: 'x' }])
    expect(cortex.worker('cortex.research')).toBeDefined()
    expect(cortex.worker('cortex.general')).toBeDefined()
    expect(cortex.worker('cortex.nope')).toBeUndefined()
    await close()
  })

  test('research has web_fetch only while no connection can search', async () => {
    const { run, close } = await setup([{ text: 'done' }])
    const model = await run('cortex.research', 'find A')
    expect(toolNames(model)).toEqual(['datetime', 'web_fetch'])
    await close()
  })

  test('with an OpenRouter connection web_search is offered too', async () => {
    const { run, close } = await setup([{ text: 'done' }], true)
    const model = await run('cortex.research', 'find A')
    expect(toolNames(model)).toEqual(['datetime', 'web_fetch', 'web_search'])
    await close()
  })

  test('a disabled OpenRouter connection does not offer web_search', async () => {
    const { run, close } = await setup([{ text: 'done' }], 'disabled')
    const model = await run('cortex.research', 'find A')
    expect(toolNames(model)).toEqual(['datetime', 'web_fetch'])
    await close()
  })

  test('general adds files in the workspace, todos and the machines (motor_remote), but cannot delete', async () => {
    const { run, dataDir, close } = await setup([
      {
        toolCalls: [
          {
            toolName: 'write_file',
            toolCallId: 'w1',
            input: { path: '/notes.md', content: 'content' },
          },
          { toolName: 'read_file', toolCallId: 'w2', input: { path: '/../../etc/hosts' } },
        ],
      },
      { text: 'done' },
    ])
    const model = await run('cortex.general', 'write a note')
    expect(toolNames(model)).toEqual(
      [
        'datetime',
        'edit_file',
        'glob',
        'grep',
        'list_files',
        'motor_remote',
        'nodes_status',
        'read_file',
        'todo_write',
        'web_fetch',
        'write_file',
      ].sort(),
    )
    expect(existsSync(join(personWorkspaceDir(dataDir, 'owner'), 'notes.md'))).toBe(true)
    expect(readFileSync(join(personWorkspaceDir(dataDir, 'owner'), 'notes.md'), 'utf8')).toBe(
      'content',
    )
    // the read outside the workspace did not read /etc/hosts
    expect(JSON.stringify(model.prompts.at(-1))).not.toContain('localhost')
    await close()
  })

  test('each person has their own workspace folder: a worker never sees another person file', async () => {
    const { run, dataDir, close } = await setup([
      {
        toolCalls: [
          {
            toolName: 'write_file',
            toolCallId: 'a1',
            input: { path: '/notes.md', content: 'OWNER-SECRET-9137' },
          },
        ],
      },
      { text: 'done' },
      { toolCalls: [{ toolName: 'list_files', toolCallId: 'b1', input: { path: '/' } }] },
      { toolCalls: [{ toolName: 'read_file', toolCallId: 'b2', input: { path: '/notes.md' } }] },
      { text: 'done' },
    ])
    await run('cortex.general', 'write', 'owner')
    const model = await run('cortex.general', 'read', 'ana')
    expect(JSON.stringify(model.prompts.at(-1))).not.toContain('OWNER-SECRET-9137')
    expect(existsSync(join(personWorkspaceDir(dataDir, 'ana'), 'notes.md'))).toBe(false)
    expect(readFileSync(join(personWorkspaceDir(dataDir, 'owner'), 'notes.md'), 'utf8')).toBe(
      'OWNER-SECRET-9137',
    )
    await close()
  })

  test('a run of no person, or an unsafe id, gets no workspace folder on disk', async () => {
    const { run, dataDir, close } = await setup([
      {
        toolCalls: [
          { toolName: 'write_file', toolCallId: 'a1', input: { path: '/x.md', content: 'x' } },
        ],
      },
      { text: 'done' },
    ])
    await run('cortex.general', 'write', '../evil')
    expect(existsSync(join(workspaceDir(dataDir), 'people'))).toBe(false)
    expect(existsSync(join(dataDir, 'x.md'))).toBe(false)
    await close()
  })

  test('the old shared workspace moves once to keith/legacy-shared, nothing is deleted', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'keith-cortex-'))
    dirs.push(dataDir)
    const root = workspaceDir(dataDir)
    mkdirSync(join(root, 'sub'), { recursive: true })
    mkdirSync(join(root, 'people', 'owner'), { recursive: true })
    writeFileSync(join(root, 'old.md'), 'old')
    writeFileSync(join(root, 'sub', 'deep.md'), 'deep')
    expect(migrateLegacyWorkspace(dataDir).sort()).toEqual(['old.md', 'sub'])
    const legacy = join(root, 'keith', 'legacy-shared')
    expect(readFileSync(join(legacy, 'old.md'), 'utf8')).toBe('old')
    expect(readFileSync(join(legacy, 'sub', 'deep.md'), 'utf8')).toBe('deep')
    expect(existsSync(join(root, 'old.md'))).toBe(false)
    expect(existsSync(join(root, 'people', 'owner'))).toBe(true)
    // a second run has nothing left to move
    expect(migrateLegacyWorkspace(dataDir)).toEqual([])
    expect(readFileSync(join(legacy, 'old.md'), 'utf8')).toBe('old')
  })

  test('workers run on the cortex role with the budget of the plan', async () => {
    expect(WORKER_BUDGET).toEqual({ maxTurnUsd: 1, maxSessionUsd: 3 })
    const { run, close } = await setup([{ text: 'done' }])
    const model = await run('cortex.research', 'find A')
    expect(model.calls.length).toBe(1)
    expect(JSON.stringify(model.prompts[0])).toContain('Cortex worker')
    await close()
  })
})

/** A node of the registry, with the capabilities it announces (a `desktop.*` one carries the desktop driver). */
const laptop = (capabilities: string[], status: Node['status'] = 'online'): Node => ({
  id: 'id-laptop-e',
  name: 'laptop-e',
  os: 'darwin',
  arch: 'arm64',
  version: '0.3.0',
  capabilities,
  drivers: capabilities.some((id) => id.startsWith('desktop.'))
    ? [{ name: 'desktop', version: '0.1.0' }]
    : [],
  refused: [],
  allowShell: false,
  status,
  lastSeenAt: null,
  createdAt: 1,
})

/** Machines whose screenshot answers with a PNG named by the call number (`shot`), and counts the calls. */
function screenNodes(list: Node[]): NodeRegistry {
  let shots = 0
  return {
    list: () => list,
    find: (ref) => list.find((n) => n.name === ref),
    invoke: async (_ref, capability) => {
      if (capability !== 'desktop.screenshot')
        return { ok: false, code: 'failed', message: 'not on this node' }
      const n = shots++
      return {
        ok: true,
        output: {
          data: Buffer.from(`pngbytes-${n}`).toString('base64'),
          mimeType: 'image/png',
          width: 1280,
          height: 800,
          scale: 2,
        },
      }
    },
    byCapability: () => [],
    revoke: () => undefined,
  }
}

/** The desktop screenshot without approval, so the test does not wait for the owner (`read` runs unasked). */
const readScreens = createNodeCapabilityRegistry(
  BUILTIN_CAPABILITY_SPECS.map((spec) =>
    spec.id === 'desktop.screenshot' ? { ...spec, risk: 'read' as const } : spec,
  ),
)

const shot = (i: number) => ({
  toolCalls: [
    {
      toolName: 'motor_remote',
      toolCallId: `shot${i}`,
      input: { node: 'laptop-e', capability: 'desktop.screenshot', input: {} },
    },
  ],
})

describe('cortex workers: images and desktop instructions', () => {
  test('only the newest three screenshots reach the model after five calls', async () => {
    const { run, close } = await setup([...[0, 1, 2, 3, 4].map(shot), { text: 'done' }], false, {
      nodes: screenNodes([laptop(['desktop.screenshot'])]),
      capabilities: readScreens,
    })
    const model = await run('cortex.general', 'look at the screen')
    const last = JSON.stringify(model.prompts.at(-1))
    const data = (i: number) => Buffer.from(`pngbytes-${i}`).toString('base64')
    for (const i of [2, 3, 4]) expect(last).toContain(data(i))
    for (const i of [0, 1]) expect(last).not.toContain(data(i))
    await close()
  })

  test('the screenshots are written under the calling person folder, never another person', async () => {
    const { run, dataDir, close } = await setup([shot(0), { text: 'done' }], false, {
      nodes: screenNodes([laptop(['desktop.screenshot'])]),
      capabilities: readScreens,
    })
    await run('cortex.general', 'look', 'owner')
    const media = join(personWorkspaceDir(dataDir, 'owner'), '.eharness', 'tool-media')
    expect(readdirSync(media).length).toBe(1)
    expect(existsSync(personWorkspaceDir(dataDir, 'ana'))).toBe(false)
    expect(existsSync(join(dataDir, 'workspace', 'people', 'owner', '.eharness'))).toBe(true)
    await close()
  })

  test('the desktop instructions are given only while an online node announces desktop.*', async () => {
    const marker = 'observe, act, observe'
    const withDesktop = await setup([{ text: 'done' }], false, {
      nodes: screenNodes([laptop(['system.info', 'desktop.screenshot'])]),
      capabilities: readScreens,
    })
    expect(JSON.stringify((await withDesktop.run('cortex.general', 'hi')).prompts[0])).toContain(
      marker,
    )
    await withDesktop.close()

    const noDesktop = await setup([{ text: 'done' }], false, {
      nodes: screenNodes([laptop(['system.info', 'shell.exec'])]),
      capabilities: readScreens,
    })
    const plain = await noDesktop.run('cortex.general', 'hi')
    expect(JSON.stringify(plain.prompts[0])).not.toContain(marker)
    expect(JSON.stringify(plain.prompts[0])).not.toContain('desktop.screenshot')
    await noDesktop.close()

    const offline = await setup([{ text: 'done' }], false, {
      nodes: screenNodes([laptop(['desktop.screenshot'], 'offline')]),
      capabilities: readScreens,
    })
    expect(JSON.stringify((await offline.run('cortex.general', 'hi')).prompts[0])).not.toContain(
      marker,
    )
    await offline.close()
  })
})
