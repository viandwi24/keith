import { describe, expect, test } from 'bun:test'
import type { UIMessage } from 'ai'
import { task } from '../../testing/fixtures.ts'
import { outputLinesOf, toolCallOf, toolLineOf } from './tool-view.ts'

type Part = UIMessage['parts'][number]
const call = (part: Record<string, unknown>) => {
  const found = toolCallOf(part as unknown as Part)
  if (found === undefined) throw new Error('not a tool part')
  return found
}
const remote = (state: string, extra: Record<string, unknown> = {}) =>
  call({
    type: 'tool-motor_remote',
    toolCallId: 'c1',
    state,
    input: { node: 'laptop-e', capability: 'shell.exec', input: { command: 'df -h' } },
    ...extra,
  })

describe('toolCallOf', () => {
  test('static and dynamic tool parts are calls, anything else is not', () => {
    expect(toolCallOf({ type: 'text', text: 'x' } as Part)).toBeUndefined()
    expect(toolCallOf({ type: 'data-eh.notice', data: {} } as unknown as Part)).toBeUndefined()
    expect(
      call({ type: 'tool-memory_recall', toolCallId: 'a', state: 'input-available', input: {} })
        .name,
    ).toBe('memory_recall')
    expect(
      call({
        type: 'dynamic-tool',
        toolName: 'search',
        toolCallId: 'b',
        state: 'input-available',
        input: {},
      }).name,
    ).toBe('search')
  })
})

describe('toolLineOf', () => {
  test('motor_remote: the node, $ command, › glyph and a ✓ when done', () => {
    const line = toolLineOf(
      remote('output-available', { output: { ok: true, output: 'ok', exitCode: 0 } }),
      [],
      0,
    )
    expect(line).toMatchObject({
      glyph: '›',
      label: 'laptop-e',
      summary: '$ df -h',
      state: { text: '✓' },
    })
  })

  test('shows at most 3 output lines and counts the rest', () => {
    const output = { ok: true, output: ['a', 'b', 'c', 'd', 'e', ''].join('\n'), exitCode: 0 }
    const line = toolLineOf(remote('output-available', { output }), [], 0)
    expect(line.output).toEqual(['a', 'b', 'c'])
    expect(line.more).toBe(2)
    const exact = toolLineOf(
      remote('output-available', { output: { ok: true, output: 'a\nb\nc' } }),
      [],
      0,
    )
    expect(exact.output).toEqual(['a', 'b', 'c'])
    expect(exact.more).toBeUndefined()
  })

  test('JSON results are not shown, only their state', () => {
    const line = toolLineOf(
      call({
        type: 'tool-memory_recall',
        toolCallId: 'm',
        state: 'output-available',
        input: { path: '/memories/profile.md' },
        output: { found: true, content: { a: 1 } },
      }),
      [],
      0,
    )
    expect(line).toMatchObject({
      label: 'memory_recall',
      summary: '/memories/profile.md',
      state: { text: '✓' },
    })
    expect(line.output).toBeUndefined()
  })

  test('running shows the spinner, an approval wait shows ‖ and the warning text', () => {
    expect(toolLineOf(remote('input-available'), [], 0).state).toMatchObject({ spinner: true })
    const waiting = toolLineOf(remote('approval-requested'), [], 0)
    expect(waiting).toMatchObject({
      glyph: '‖',
      state: { text: 'waiting for approval', tone: 'warning' },
    })
  })

  test('a non-zero exit, a failed result, an error and a denial are ✕ with the reason', () => {
    const exit = toolLineOf(
      remote('output-available', { output: { ok: true, output: 'nope', exitCode: 1 } }),
      [],
      0,
    )
    expect(exit.state).toMatchObject({ text: '✕ exit 1', tone: 'danger' })
    expect(exit.output).toEqual(['nope'])
    const failed = toolLineOf(
      remote('output-available', {
        output: { ok: false, code: 'shell-off', error: 'node does not allow shell' },
      }),
      [],
      0,
    )
    expect(failed.state).toMatchObject({ text: '✕ node does not allow shell' })
    expect(toolLineOf(remote('output-error', { errorText: 'boom' }), [], 0).state).toMatchObject({
      text: '✕ boom',
    })
    expect(
      toolLineOf(
        remote('output-denied', { approval: { id: 'x', approved: false, reason: 'not now' } }),
        [],
        0,
      ).state,
    ).toMatchObject({
      text: '✕ denied · not now',
    })
  })

  test('a delegation takes the glyph and the elapsed time of its task on the board', () => {
    const delegated = call({
      type: 'tool-agent',
      toolCallId: 'd',
      state: 'output-available',
      input: { agent: 'cortex.research', description: 'find disk usage' },
      output: 'Started background subagent agent-1',
    })
    const running = task({ agent: 'cortex.research', description: 'find disk usage', createdAt: 0 })
    const line = toolLineOf(delegated, [running], 42_000)
    expect(line).toMatchObject({
      glyph: '◐',
      label: 'research',
      summary: 'find disk usage',
      state: { text: '00:42' },
    })
    const done = task({ ...running, status: 'done', finishedAt: 65_000 })
    expect(toolLineOf(delegated, [done], 99_000)).toMatchObject({
      glyph: '✓',
      state: { text: '01:05' },
    })
    // no task on the board yet: the call itself says it started
    expect(toolLineOf(delegated, [], 0)).toMatchObject({ glyph: '◐', label: 'research' })
  })
})

describe('outputLinesOf', () => {
  test('strings, {stdout, stderr}, a nested output; nothing else', () => {
    expect(outputLinesOf('a\r\nb\n\n')).toEqual(['a', 'b'])
    expect(outputLinesOf({ stdout: 'out', stderr: 'err' })).toEqual(['out', 'err'])
    expect(outputLinesOf({ ok: true, output: 'x' })).toEqual(['x'])
    expect(outputLinesOf({ count: 3 })).toEqual([])
    expect(outputLinesOf(undefined)).toEqual([])
  })
})
