// `undo_last` (ADR-0036 §4): the person's own newest reversible change in this chat, taken back once; it records no undo of its own.
import { describe, expect, test } from 'bun:test'
import type { HarnessContext } from 'eharness'
import { resolvePlugin } from 'eharness/testing'
import { createUndoLog, recordUndo } from '../../platform/undo-log.ts'
import { createUndoPlugin, UNDO_LAST_TOOL } from './undo.ts'

type Exec = { execute: (input: unknown, options: unknown) => Promise<Record<string, unknown>> }

const entry = (summary: string, ran: string[], ok = true) => ({
  tool: 'x',
  summary,
  undo: () => {
    ran.push(summary)
    return ok
      ? ({ ok: true, summary } as const)
      : ({ ok: false, reason: 'gone', message: 'it is gone' } as const)
  },
})

async function toolFor(log: ReturnType<typeof createUndoLog>, session: string, person?: string) {
  const resolved = await resolvePlugin(createUndoPlugin(log), {
    ctx: {
      session: { id: session },
      ...(person === undefined ? {} : { principal: { id: person } }),
    } as Partial<HarnessContext>,
  })
  return resolved.tools[UNDO_LAST_TOOL] as unknown as Exec & { metadata?: unknown }
}

describe('undo_last', () => {
  test('it is a trusted reversible write', async () => {
    const tool = await toolFor(createUndoLog(), 'front:ana', 'ana')
    expect(tool.metadata).toEqual({ risk: 'write', reversible: true, source: 'trusted' })
  })

  test('it takes the newest change back first, then the one before, then has nothing to undo', async () => {
    const log = createUndoLog()
    const ran: string[] = []
    recordUndo(
      log,
      { session: { id: 'front:ana' }, principal: { id: 'ana' } } as never,
      entry('first', ran),
    )
    recordUndo(
      log,
      { session: { id: 'front:ana' }, principal: { id: 'ana' } } as never,
      entry('second', ran),
    )
    const tool = await toolFor(log, 'front:ana', 'ana')
    expect(await tool.execute({}, {})).toEqual({ ok: true, summary: 'second' })
    expect(await tool.execute({}, {})).toEqual({ ok: true, summary: 'first' })
    expect(await tool.execute({}, {})).toMatchObject({ ok: false, reason: 'nothing-to-undo' })
    expect(ran).toEqual(['second', 'first'])
  })

  test("another person's change and another session's change are out of reach", async () => {
    const log = createUndoLog()
    const ran: string[] = []
    log.record('front:ana', 'ana', entry('ana change', ran))
    expect(await (await toolFor(log, 'front:ben', 'ben')).execute({}, {})).toMatchObject({
      reason: 'nothing-to-undo',
    })
    expect(await (await toolFor(log, 'front:ana:g1', 'ana')).execute({}, {})).toMatchObject({
      reason: 'nothing-to-undo',
    })
    expect(await (await toolFor(log, 'front:ana')).execute({}, {})).toMatchObject({
      reason: 'no-person',
    })
    expect(ran).toEqual([])
  })

  test('a refusal or a throw of the undo is an answer', async () => {
    const log = createUndoLog()
    log.record('s', 'ana', entry('gone', [], false))
    log.record('s', 'ana', {
      tool: 'x',
      summary: 'boom',
      undo: () => {
        throw new Error('disk full')
      },
    })
    const tool = await toolFor(log, 's', 'ana')
    expect(await tool.execute({}, {})).toMatchObject({
      ok: false,
      reason: 'undo-failed',
      message: 'disk full',
    })
    expect(await tool.execute({}, {})).toMatchObject({ ok: false, reason: 'gone' })
  })

  test('the log keeps the newest ten per person and session', () => {
    const log = createUndoLog()
    for (let i = 0; i < 12; i++) log.record('s', 'ana', entry(`c${i}`, []))
    expect(log.size('s', 'ana')).toBe(10)
    expect(log.take('s', 'ana')?.summary).toBe('c11')
  })
})
