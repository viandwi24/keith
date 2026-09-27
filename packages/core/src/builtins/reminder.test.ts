// Tests for the `reminder.*` built-ins: the specs (names, input schemas, `minTier`, registration)
// and the behavior against a real ReminderService over the scheduler's fake repos.

import { describe, expect, test } from 'bun:test'
import type { Tool, ToolRunContext } from '@keith/sdk'
import { createFakeClock, createMemoryLogger, type FakeClock } from '@keith/sdk/testing'
import { z } from 'zod'
import type { KeithConfig } from '../config/types.ts'
import { createEventBus } from '../events/index.ts'
import { createServiceRegistry } from '../plugins/services.ts'
import { createToolRegistry } from '../plugins/tools.ts'
import { createReminderService } from '../scheduler/reminders.ts'
import {
  createFakeIds,
  createFakeRepos,
  createTestConfig,
  type FakeRepos,
  seedPerson,
} from '../scheduler/testing/fakes.ts'
import type { ReminderService } from '../scheduler/types.ts'
import type { Ids, PersonDto, TaskId, ThreadId } from '../shared/types.ts'
import { type BuiltinDeps, registerBuiltins } from './index.ts'
import {
  createReminderTools,
  formatReminderTime,
  parseReminderAt,
  REMINDER_MESSAGES,
  REMINDER_TOOL_NAMES,
  type ReminderToolsDeps,
} from './reminder.ts'

const service: ReminderService = {
  set: async () => {
    throw new Error('unused')
  },
  cancel: async () => false,
  listFor: async () => [],
  fireDue: async () => 0,
}

const reminderDeps: ReminderToolsDeps = {
  service,
  config: {
    mind: {
      name: 'Keith',
      timezone: 'Asia/Jakarta',
      turn: { maxSteps: 8, stallMs: 120_000 },
      task: { maxSteps: 20, maxPerPerson: 3, timeoutMs: 1_800_000 },
      commitment: { ttlMs: 604_800_000 },
      arrival: { awayAfterMinutes: 30, briefing: 'on-greeting', holdMs: 120_000, graceMs: 1_500 },
      context: { recentMessages: 40 },
      reminder: { maxPerPerson: 50 },
    },
  },
  clock: createFakeClock(1_700_000_000_000),
}

function byName(tools: Tool[]): Map<string, Tool> {
  return new Map(tools.map((t) => [t.name, t]))
}

function builtinDeps(extra: Partial<BuiltinDeps> = {}): { deps: BuiltinDeps; registered: string[] } {
  const registered: string[] = []
  const deps: BuiltinDeps = {
    tasks: {} as BuiltinDeps['tasks'],
    memory: {} as BuiltinDeps['memory'],
    persons: { list: async () => [] },
    skills: { get: () => undefined, list: () => [], registerDefault: () => {} },
    tools: { registerBuiltin: (tool) => registered.push(tool.name) },
    ...extra,
  }
  return { deps, registered }
}

describe('reminder.* specs', () => {
  const tools = byName(createReminderTools(reminderDeps))

  test('three tools with the fixed names, all minTier member', () => {
    expect([...tools.keys()]).toEqual([...REMINDER_TOOL_NAMES])
    for (const tool of tools.values()) expect(tool.minTier).toBe('member')
  })

  test('reminder.set takes text and exactly one of at or inMinutes', () => {
    const input = tools.get('reminder.set')?.input
    if (!input) throw new Error('missing reminder.set')
    expect(input.safeParse({ text: 'Call Pepper', inMinutes: 90 }).success).toBe(true)
    expect(input.safeParse({ text: 'Call Pepper', at: '2026-10-01T09:00' }).success).toBe(true)
    expect(input.safeParse({ text: 'Call Pepper', at: '2026-10-01T09:00:00+02:00' }).success).toBe(true)
    expect(input.safeParse({ text: 'Call Pepper', at: '2026-10-01T07:00:00.000Z' }).success).toBe(true)

    const both = input.safeParse({ text: 'Call Pepper', at: '2026-10-01T09:00', inMinutes: 5 })
    expect(both.success).toBe(false)
    expect(both.error?.issues[0]?.message).toBe(REMINDER_MESSAGES.bothOrNeither)
    const neither = input.safeParse({ text: 'Call Pepper' })
    expect(neither.success).toBe(false)
    expect(neither.error?.issues[0]?.message).toBe(REMINDER_MESSAGES.bothOrNeither)
  })

  test('reminder.set rejects empty or long text, a bad at and a non-positive inMinutes', () => {
    const input = tools.get('reminder.set')?.input
    if (!input) throw new Error('missing reminder.set')
    expect(input.safeParse({ text: '   ', inMinutes: 5 }).success).toBe(false)
    expect(input.safeParse({ text: 'x'.repeat(501), inMinutes: 5 }).success).toBe(false)
    expect(input.safeParse({ text: 'x'.repeat(500), inMinutes: 5 }).success).toBe(true)
    expect(input.safeParse({ text: 'Call', at: 'tomorrow at 9' }).success).toBe(false)
    expect(input.safeParse({ text: 'Call', at: '2026-10-01' }).success).toBe(false)
    expect(input.safeParse({ text: 'Call', inMinutes: 0 }).success).toBe(false)
    expect(input.safeParse({ text: 'Call', inMinutes: -5 }).success).toBe(false)
  })

  test('every input schema converts to JSON Schema for the model', () => {
    for (const tool of tools.values()) expect(() => z.toJSONSchema(tool.input)).not.toThrow()
    const set = z.toJSONSchema(tools.get('reminder.set')?.input ?? z.never()) as { properties?: object }
    expect(Object.keys(set.properties ?? {})).toEqual(['text', 'at', 'inMinutes'])
  })

  test('reminder.list takes no arguments; reminder.cancel takes a reminder id', () => {
    expect(tools.get('reminder.list')?.input.safeParse({}).success).toBe(true)
    const cancel = tools.get('reminder.cancel')?.input
    if (!cancel) throw new Error('missing reminder.cancel')
    expect(cancel.safeParse({ id: 'rem_01J8ZQ3K4M5N6P7Q8R9S0T1V31' }).success).toBe(true)
    expect(cancel.safeParse({ id: 'tsk_01J8ZQ3K4M5N6P7Q8R9S0T1V31' }).success).toBe(false)
    expect(cancel.safeParse({}).success).toBe(false)
  })
})

describe('registerBuiltins and reminders', () => {
  test('without reminders, no reminder.* tool is registered', () => {
    const { deps, registered } = builtinDeps()
    registerBuiltins(deps)
    expect(registered.filter((n) => n.startsWith('reminder.'))).toEqual([])
    expect(registered).toContain('task.start')
  })

  test('with reminders, the three tools are registered', () => {
    const { deps, registered } = builtinDeps({ reminders: reminderDeps })
    registerBuiltins(deps)
    expect(registered.filter((n) => n.startsWith('reminder.'))).toEqual([...REMINDER_TOOL_NAMES])
  })
})

// Behavior

const MINUTE = 60_000
const DAY = 86_400_000
/** Sunday 2026-09-27 12:00Z. */
const NOW = Date.UTC(2026, 8, 27, 12, 0)

type World = {
  config: KeithConfig
  clock: FakeClock
  ids: Ids
  repos: FakeRepos
  service: ReminderService
  tools: Record<'set' | 'list' | 'cancel', Tool>
}

function world(opts: { timezone?: string; maxPerPerson?: number } = {}): World {
  const config = createTestConfig()
  config.mind.timezone = opts.timezone ?? 'Asia/Jakarta'
  if (opts.maxPerPerson !== undefined) config.mind.reminder = { maxPerPerson: opts.maxPerPerson }
  const clock = createFakeClock(NOW)
  const ids = createFakeIds()
  const repos = createFakeRepos()
  const service = createReminderService({
    config,
    repos,
    deliveries: {
      enqueue: async () => {
        throw new Error('unused')
      },
    },
    ids,
    clock,
    log: createMemoryLogger(),
  })
  const [set, list, cancel] = createReminderTools({ service, config, clock })
  if (!set || !list || !cancel) throw new Error('missing tools')
  return { config, clock, ids, repos, service, tools: { set, list, cancel } }
}

function ctx(person: PersonDto, threadId: ThreadId | null, taskId: TaskId | null = null): ToolRunContext {
  return {
    person,
    participants: [person],
    threadId,
    taskId,
    signal: new AbortController().signal,
    log: createMemoryLogger(),
    services: {
      get: () => {
        throw new Error('no services in this test')
      },
      find: () => undefined,
    },
  }
}

/** Parses input with the tool's schema (as the registry does), then runs it. */
async function call(tool: Tool, raw: unknown, t: ToolRunContext) {
  return tool.run(tool.input.parse(raw), t)
}

async function tonyIn(w: World) {
  const seeded = await seedPerson(w.repos, w.ids, { name: 'Tony' })
  const person: PersonDto = { id: seeded.personId, name: 'Tony', tier: 'owner' }
  return { person, threadId: seeded.threadId, t: ctx(person, seeded.threadId) }
}

function onlyReminder(w: World) {
  const rows = [...w.repos.reminderRows.values()]
  expect(rows).toHaveLength(1)
  return rows[0]
}

describe('reminder.set', () => {
  test('inMinutes: 90 is due now + 90 minutes, in the current thread', async () => {
    const w = world()
    const tony = await tonyIn(w)
    const result = await call(w.tools.set, { text: 'Call Pepper', inMinutes: 90 }, tony.t)
    expect(result.error).toBeUndefined()
    const r = onlyReminder(w)
    expect(r).toMatchObject({ dueAt: NOW + 90 * MINUTE, threadId: tony.threadId, text: 'Call Pepper' })
    expect(result.content).toBe(
      `Reminder ${r?.id} set for Sunday, 2026-09-27 20:30 (Asia/Jakarta): Call Pepper`,
    )
  })

  test('at without an offset is a wall-clock time in mind.timezone', async () => {
    const w = world({ timezone: 'Asia/Jakarta' })
    const tony = await tonyIn(w)
    const result = await call(w.tools.set, { text: 'Call Pepper', at: '2026-10-01T09:00' }, tony.t)
    expect(onlyReminder(w)?.dueAt).toBe(Date.UTC(2026, 9, 1, 2, 0))
    expect(result.content).toContain('set for Thursday, 2026-10-01 09:00 (Asia/Jakarta): Call Pepper')
  })

  test('at with an offset or Z is that instant', async () => {
    const w = world()
    const tony = await tonyIn(w)
    await call(w.tools.set, { text: 'a', at: '2026-10-01T09:00+02:00' }, tony.t)
    await call(w.tools.set, { text: 'b', at: '2026-10-01T09:00:30.5Z' }, tony.t)
    await call(w.tools.set, { text: 'c', at: '2026-10-01T09:00-05:30' }, tony.t)
    const due = Object.fromEntries([...w.repos.reminderRows.values()].map((r) => [r.text, r.dueAt]))
    expect(due).toEqual({
      a: Date.UTC(2026, 9, 1, 7, 0),
      b: Date.UTC(2026, 9, 1, 9, 0, 30, 500),
      c: Date.UTC(2026, 9, 1, 14, 30),
    })
  })

  test('a past time and 400 days ahead are tool errors; 366 days is allowed', async () => {
    const w = world()
    const tony = await tonyIn(w)
    const past = await call(w.tools.set, { text: 'x', at: '2026-09-27T12:00Z' }, tony.t)
    expect(past).toEqual({ content: REMINDER_MESSAGES.past, error: true })
    const far = await call(w.tools.set, { text: 'x', inMinutes: (400 * DAY) / MINUTE }, tony.t)
    expect(far).toEqual({ content: REMINDER_MESSAGES.tooFar, error: true })
    const farAt = await call(w.tools.set, { text: 'x', at: '2027-11-01T09:00' }, tony.t)
    expect(farAt).toEqual({ content: REMINDER_MESSAGES.tooFar, error: true })
    expect(w.repos.reminderRows.size).toBe(0)
    const edge = await call(w.tools.set, { text: 'x', inMinutes: (366 * DAY) / MINUTE }, tony.t)
    expect(edge.error).toBeUndefined()
  })

  test('a date or time that does not exist is a tool error', async () => {
    const w = world()
    const tony = await tonyIn(w)
    for (const at of ['2026-02-30T09:00', '2026-13-01T09:00', '2026-10-01T24:00', '2026-10-01T09:60']) {
      expect(await call(w.tools.set, { text: 'x', at }, tony.t)).toEqual({
        content: REMINDER_MESSAGES.invalidTime,
        error: true,
      })
    }
  })

  test('inside a task (threadId null) the reminder targets the main thread', async () => {
    const w = world()
    const tony = await tonyIn(w)
    await call(w.tools.set, { text: 'x', inMinutes: 5 }, ctx(tony.person, null, w.ids.next('tsk')))
    expect(onlyReminder(w)?.threadId).toBeNull()
  })

  test('over the per-person limit is a tool error', async () => {
    const w = world({ maxPerPerson: 1 })
    const tony = await tonyIn(w)
    await call(w.tools.set, { text: 'one', inMinutes: 5 }, tony.t)
    expect(await call(w.tools.set, { text: 'two', inMinutes: 5 }, tony.t)).toEqual({
      content: REMINDER_MESSAGES.limit(1),
      error: true,
    })
  })

  test('a guest caller is refused by minTier', async () => {
    const w = world()
    const log = createMemoryLogger()
    const clock = createFakeClock(NOW)
    const registry = createToolRegistry({
      log,
      clock,
      services: createServiceRegistry({ winners: {}, log }),
      events: createEventBus({ log, clock }),
    })
    for (const tool of Object.values(w.tools)) registry.registerBuiltin(tool)
    const guest: PersonDto = { id: w.ids.next('per'), name: 'Happy', tier: 'guest' }
    const invocation = {
      toolCallId: 'call_1',
      person: guest,
      participants: [guest],
      threadId: null,
      taskId: null,
      signal: new AbortController().signal,
    }
    for (const name of REMINDER_TOOL_NAMES) {
      const result = await registry.invoke(name, { text: 'x', inMinutes: 5 }, invocation)
      expect(result.error).toBe(true)
      expect(result.content).toStartWith('TIER_INSUFFICIENT')
    }
    expect(registry.list({ tier: 'guest' }).filter((r) => r.tool.name.startsWith('reminder.'))).toEqual([])
    expect(w.repos.reminderRows.size).toBe(0)
  })
})

describe('reminder.list and reminder.cancel', () => {
  test('reminder.list shows id, local time and text, soonest first; "No reminders." when empty', async () => {
    const w = world({ timezone: 'Asia/Jakarta' })
    const tony = await tonyIn(w)
    expect(await call(w.tools.list, {}, tony.t)).toEqual({ content: REMINDER_MESSAGES.none })
    await call(w.tools.set, { text: 'Later', at: '2026-10-02T18:30' }, tony.t)
    await call(w.tools.set, { text: 'Call Pepper', at: '2026-10-01T09:00' }, tony.t)
    const [later, sooner] = [...w.repos.reminderRows.values()]
    const result = await call(w.tools.list, {}, tony.t)
    expect(result.content).toBe(
      [
        `${sooner?.id}: Thursday, 2026-10-01 09:00 (Asia/Jakarta) — Call Pepper`,
        `${later?.id}: Friday, 2026-10-02 18:30 (Asia/Jakarta) — Later`,
      ].join('\n'),
    )
  })

  test("reminder.list shows only the caller's reminders", async () => {
    const w = world()
    const tony = await tonyIn(w)
    const pepper = await seedPerson(w.repos, w.ids, { name: 'Pepper' })
    const pepperPerson: PersonDto = { id: pepper.personId, name: 'Pepper', tier: 'member' }
    await call(w.tools.set, { text: 'Tony only', inMinutes: 5 }, tony.t)
    expect(await call(w.tools.list, {}, ctx(pepperPerson, pepper.threadId))).toEqual({
      content: REMINDER_MESSAGES.none,
    })
  })

  test('reminder.cancel cancels the caller\'s own reminder, then says "No such reminder."', async () => {
    const w = world()
    const tony = await tonyIn(w)
    await call(w.tools.set, { text: 'x', inMinutes: 5 }, tony.t)
    const id = onlyReminder(w)?.id
    expect(await call(w.tools.cancel, { id }, tony.t)).toEqual({ content: REMINDER_MESSAGES.cancelled })
    expect(w.repos.reminderRows.get(id ?? '')?.status).toBe('cancelled')
    expect(await call(w.tools.cancel, { id }, tony.t)).toEqual({
      content: REMINDER_MESSAGES.notFound,
      error: true,
    })
  })

  test('reminder.cancel with another person\'s id says "No such reminder." and changes nothing', async () => {
    const w = world()
    const tony = await tonyIn(w)
    const pepper = await seedPerson(w.repos, w.ids, { name: 'Pepper' })
    const pepperPerson: PersonDto = { id: pepper.personId, name: 'Pepper', tier: 'member' }
    await call(w.tools.set, { text: 'x', inMinutes: 5 }, tony.t)
    const id = onlyReminder(w)?.id
    const pepperCtx = ctx(pepperPerson, pepper.threadId)
    const unknown = await call(w.tools.cancel, { id: w.ids.next('rem') }, pepperCtx)
    const others = await call(w.tools.cancel, { id }, pepperCtx)
    expect(others).toEqual(unknown)
    expect(others.content).toBe(REMINDER_MESSAGES.notFound)
    expect(w.repos.reminderRows.get(id ?? '')?.status).toBe('pending')
  })
})

describe('time zone conversion', () => {
  test('DST in Europe/Berlin: a skipped or repeated wall-clock time resolves to the later instant', () => {
    // 2026-03-29 02:30 does not exist (02:00 CET jumps to 03:00 CEST): the later reading, 03:30 CEST.
    expect(parseReminderAt('2026-03-29T02:30', 'Europe/Berlin')).toBe(Date.UTC(2026, 2, 29, 1, 30))
    // 2026-10-25 02:30 exists twice (03:00 CEST falls back to 02:00 CET): the later one, 02:30 CET.
    expect(parseReminderAt('2026-10-25T02:30', 'Europe/Berlin')).toBe(Date.UTC(2026, 9, 25, 1, 30))
    // Near a transition, unambiguous times keep their own offset.
    expect(parseReminderAt('2026-10-24T23:00', 'Europe/Berlin')).toBe(Date.UTC(2026, 9, 24, 21, 0))
    expect(parseReminderAt('2026-10-25T12:00', 'Europe/Berlin')).toBe(Date.UTC(2026, 9, 25, 11, 0))
    expect(parseReminderAt('2026-03-29T01:30', 'Europe/Berlin')).toBe(Date.UTC(2026, 2, 29, 0, 30))
    expect(parseReminderAt('2026-03-29T03:30', 'Europe/Berlin')).toBe(Date.UTC(2026, 2, 29, 1, 30))
  })

  test('formatReminderTime shows the local wall clock', () => {
    expect(formatReminderTime(Date.UTC(2026, 9, 25, 1, 30), 'Europe/Berlin')).toBe(
      'Sunday, 2026-10-25 02:30 (Europe/Berlin)',
    )
    expect(formatReminderTime(Date.UTC(2026, 9, 1, 2, 0), 'UTC')).toBe('Thursday, 2026-10-01 02:00 (UTC)')
  })
})
