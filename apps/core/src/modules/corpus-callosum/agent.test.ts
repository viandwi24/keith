// The room agent (P30.3.1): its tools and plugins equal an exact allowlist, and its file tools cannot leave the room folder
// (`..`, an absolute path, a symlink). The approval hook never approves and refuses what the room does not offer.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inMemoryMessages, inMemoryState } from 'eharness/storage/memory'
import { resolvePlugin } from 'eharness/testing'
import {
  createRoomAgent,
  ROOM_AGENT_PLUGIN_NAMES,
  ROOM_AGENT_TOOL_NAMES,
  ROOM_FILE_TOOLS,
  ROOM_INSTRUCTIONS,
  ROOM_STEPS,
  roomApproval,
  roomFileSystem,
} from './agent.ts'
import { roomWorld } from './fixtures.ts'
import { createRoomTurnSeqs } from './handoff.ts'
import { createRoomTools, ROOM_TOOLS } from './tools.ts'
import { createRoomWorkspace, roomWorkspaceDir } from './workspace.ts'

const ROOM = '0190f5e2-0000-7000-8000-000000000001'
const session = (roomId = ROOM) => `room:${roomId}:g0`

let dataDir: string
let outside: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'keith-room-agent-'))
  outside = mkdtempSync(join(tmpdir(), 'keith-room-outside-'))
  createRoomWorkspace(dataDir, ROOM)
})
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

/** The agent under test, built with the real room collaborators over a fixture store. */
function agentUnderTest() {
  const w = roomWorld(dataDir)
  const agent = createRoomAgent({
    providers: { catalog: () => [] } as never,
    storage: { messages: inMemoryMessages(), state: inMemoryState() },
    dataDir,
    tools: {
      rooms: w.rooms,
      service: w.svc,
      presence: { disclosedFor: async () => ({ level: 'none', line: null }) },
      transport: { sayLine: async () => 0 },
      people: { get: async () => ({ name: 'x' }) as never },
      handoff: { hand: async () => ({ status: 'handed' }) },
      turnSeqs: createRoomTurnSeqs(),
    },
    context: {
      rooms: w.rooms,
      disclosedFor: async () => ({ line: null }),
      listWorkspace: () => [],
      now: () => w.now(),
      name: (id) => id,
    },
  })
  return { agent, w }
}

/** A refusal: the write threw, or the adapter answered `ok: false`. */
async function refused(write: () => Promise<{ ok: boolean } | unknown>): Promise<boolean> {
  try {
    const out = (await write()) as { ok?: boolean } | undefined
    return out?.ok === false
  } catch {
    return true
  }
}

describe('room agent: allowlist', () => {
  test('the tools are exactly the seven room tools and the four file tools', () => {
    expect([...ROOM_AGENT_TOOL_NAMES]).toEqual([
      'room_say',
      'room_presence',
      'room_activity',
      'room_leave',
      'room_request_remove',
      'room_request_end',
      'room_handoff',
      'list_files',
      'read_file',
      'write_file',
      'edit_file',
    ])
    expect([...ROOM_FILE_TOOLS]).toEqual(['list_files', 'read_file', 'write_file', 'edit_file'])
  })

  test('the system text names room_handoff for anything personal', () => {
    expect(ROOM_INSTRUCTIONS).toContain('call room_handoff')
  })

  test('the room tools factory offers the same names as the allowlist', () => {
    const w = roomWorld(dataDir)
    const names = Object.keys(
      createRoomTools({
        rooms: w.rooms,
        service: w.svc,
        presence: { disclosedFor: async () => ({ level: 'none', line: null }) },
        transport: { sayLine: async () => 0 },
        people: { get: async () => ({ name: 'x' }) as never },
        handoff: { hand: async () => ({ status: 'handed' }) },
        turnSeqs: createRoomTurnSeqs(),
      }),
    )
    expect(names).toEqual([...ROOM_TOOLS])
  })

  test('the agent has exactly the allowlisted plugins: no memory, motor, subagent, plugin, protocol or shell', () => {
    const { agent } = agentUnderTest()
    const plugins = (agent.config as unknown as { plugins: readonly { name: string }[] }).plugins
    expect(plugins.map((p) => p.name)).toEqual([...ROOM_AGENT_PLUGIN_NAMES])
    for (const forbidden of [
      'hippocampus',
      'motor',
      'subagent',
      'shell',
      'protocol',
      'keith-plugins',
    ]) {
      expect(plugins.some((p) => p.name.includes(forbidden))).toBe(false)
    }
  })

  test('the agent has the front role model, a step cap of six, and keeps the last two turns', () => {
    const { agent } = agentUnderTest()
    const config = agent.config as unknown as {
      loop?: { maxSteps?: number }
      compaction?: { keepLast?: number }
    }
    expect(ROOM_STEPS).toBe(6)
    expect(config.loop?.maxSteps).toBe(6)
    expect(config.compaction?.keepLast).toBe(2)
  })
})

describe('room agent: the room folder', () => {
  test('a file tool writes inside rooms/<id>/', async () => {
    const fs = roomFileSystem(dataDir, session())
    const result = await fs.write('/notes/plan.txt', 'dinner at seven')
    expect(result.ok).toBe(true)
    expect(readFileSync(join(roomWorkspaceDir(dataDir, ROOM), 'notes/plan.txt'), 'utf8')).toBe(
      'dinner at seven',
    )
  })

  test('`..` cannot leave the room folder', async () => {
    const fs = roomFileSystem(dataDir, session())
    expect(await refused(() => fs.write('/../../escape.txt', 'x'))).toBe(true)
    expect(await refused(() => fs.write('/../escape.txt', 'x'))).toBe(true)
    expect(await Bun.file(join(dataDir, 'escape.txt')).exists()).toBe(false)
    expect(await Bun.file(join(dataDir, 'workspace', 'escape.txt')).exists()).toBe(false)
  })

  test('an absolute path names no file outside the room folder', async () => {
    const fs = roomFileSystem(dataDir, session())
    const target = join(outside, 'absolute.txt')
    await refused(() => fs.write(target, 'x')).catch(() => undefined)
    expect(await Bun.file(target).exists()).toBe(false)
  })

  test('a symlink in the room folder that points outside is not written through', async () => {
    const victim = join(outside, 'victim.txt')
    writeFileSync(victim, 'original')
    mkdirSync(roomWorkspaceDir(dataDir, ROOM), { recursive: true })
    symlinkSync(victim, join(roomWorkspaceDir(dataDir, ROOM), 'link.txt'))
    const fs = roomFileSystem(dataDir, session())
    expect(await refused(() => fs.write('/link.txt', 'HACKED', {}))).toBe(true)
    expect(readFileSync(victim, 'utf8')).toBe('original')
  })

  test('a session that names no room gets no file system', () => {
    expect(() => roomFileSystem(dataDir, 'front:ana')).toThrow()
  })
})

describe('room agent: approval', () => {
  type Event = { toolName: string; risk?: string }
  /** The approval hook of the room agent, run the way the core runs it (`resolvePlugin` resolves it). */
  const decide = async (event: Event) => {
    const resolved = await resolvePlugin(roomApproval())
    return (await resolved.runHook('tool.approve', event as never)) as
      | { type: string; reason?: string }
      | undefined
  }

  test('a room tool or a file tool is not decided by the hook (no approval is asked)', async () => {
    expect(await decide({ toolName: 'room_say', risk: 'write' })).toBeUndefined()
    expect(await decide({ toolName: 'write_file' })).toBeUndefined()
  })

  test('a tool outside the room allowlist is denied', async () => {
    expect((await decide({ toolName: 'memory_search', risk: 'read' }))?.type).toBe('denied')
    expect((await decide({ toolName: 'motor_remote', risk: 'external' }))?.type).toBe('denied')
  })

  test('an external or destructive call is denied even on an offered name', async () => {
    expect((await decide({ toolName: 'room_say', risk: 'external' }))?.type).toBe('denied')
    expect((await decide({ toolName: 'write_file', risk: 'destructive' }))?.type).toBe('denied')
  })
})
