/** M4 gate: endless conversations stay healthy: compaction with a memory flush, output limits. */
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ScriptedCallOptions, ScriptedStep } from 'eharness/testing'
import { cleanup, messagesOf, send, tasksOf } from './testing/core-harness.ts'
import { ask, scenario } from './testing/scenario-harness.ts'
import { createGate } from './testing/scripted-providers.ts'
import { until } from './testing/wait.ts'

afterAll(cleanup)

const REPORT = 'WORKER-REPORT-OK'
const FILLER = `${'long notes about the day today '.repeat(180)}`

/** One scripted front model for every kind of call: reply, summary, memory flush, delegation. */
function frontModel(call: ScriptedCallOptions): ScriptedStep {
  // report the input a real provider would (about 4 characters a token): the estimate is calibrated on it
  const usage = { inputTokens: Math.ceil(JSON.stringify(call.prompt).length / 4), outputTokens: 5 }
  return { ...plan(call), usage }
}

function plan(call: ScriptedCallOptions): ScriptedStep {
  const prompt = call.prompt as Array<{ role: string; content: unknown }>
  const wire = JSON.stringify(prompt)
  // the turn reminder trails the request (turnPlacement 'end', wernicke-broca.md): skip it to find the newest real message
  const last = prompt.findLast((m) => !JSON.stringify(m.content).includes('<system-reminder>'))
  const lastText = JSON.stringify(last?.content ?? '')
  if (wire.includes('You summarize the earlier part of a conversation')) {
    return { text: 'SUMMARY: the owner asked for news research; the worker is working.' }
  }
  if (wire.includes('is about to be summarized')) {
    return last?.role === 'tool'
      ? { text: 'saved' }
      : {
          toolCalls: [
            {
              toolName: 'memory_create',
              toolCallId: 'flush1',
              input: { path: '/memories/owner/flushed.md', file_text: 'Owner likes tech news\n' },
            },
          ],
        }
  }
  if (last?.role === 'tool') return { text: 'Okay, I will do it.' }
  // the report is searched in the whole prompt: the report block (P33.4.4) adds a reminder after the event
  if (wire.includes(REPORT)) return { text: `Result from the worker: ${REPORT}` }
  if (lastText.includes('DELEGATE')) {
    return {
      toolCalls: [
        {
          toolName: 'agent',
          toolCallId: 'c1',
          input: {
            subagent_type: 'cortex.general',
            description: 'news research',
            prompt: 'Find the news.',
            run_in_background: true,
          },
        },
      ],
    }
  }
  return { text: 'Noted.' }
}

describe('M4: compaction and limits', () => {
  test('a long session compacts after a memory flush, and a delegation started before it is still reported', async () => {
    const gate = createGate()
    const s = await scenario({
      front: Array.from({ length: 60 }, () => frontModel),
      worker: [{ text: `Done. ${REPORT}` }],
      pricing: { input: 0.1, output: 0.1 },
      workerGate: gate,
      contextWindow: 30_000,
    })
    await ask(s.r, 'DELEGATE news research')
    await gate.whenStarted(1)
    for (let i = 0; i < 16; i++) await send(s.r.client, `${FILLER} ${i}`)

    const messages = await messagesOf(s.r.client)
    const kinds = messages.map((m) =>
      m.parts.map((p) => p.type).find((t) => t === 'data-eh.compaction' || t === 'data-eh.flush'),
    )
    const compacted = kinds.indexOf('data-eh.compaction')
    expect(compacted).toBeGreaterThan(-1)
    // the memory flush ran before the summary was written
    const flushed = kinds.indexOf('data-eh.flush')
    expect(flushed).toBeGreaterThan(-1)
    expect(flushed).toBeLessThan(compacted)
    const file = join(s.dataDir, 'memory', 'owner', 'flushed.md')
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('tech news')

    // the worker, started before the compaction, reports now and the front agent relays it
    gate.release()
    await until(
      'task done',
      () => tasksOf(s.r.client),
      (t) => t[0]?.status === 'done',
    )
    await until('report relayed', async () =>
      (await messagesOf(s.r.client)).some((m) =>
        m.parts.some(
          (p) => p.type === 'text' && p.text.includes(`Result from the worker: ${REPORT}`),
        ),
      ),
    )
  })

  test('a huge tool result is cut to 20 000 characters before the model sees it', async () => {
    const s = await scenario({
      worker: [
        {
          toolCalls: [
            {
              toolName: 'write_file',
              toolCallId: 'wf',
              input: { path: '/big.txt', content: `${'abcdefghij'.repeat(6000)}\n` },
            },
          ],
        },
        { toolCalls: [{ toolName: 'read_file', toolCallId: 'rf', input: { path: '/big.txt' } }] },
        { text: 'Done.' },
      ],
    })
    await ask(s.r)
    await until('worker read the file', () => s.workerPrompts().length >= 3)
    const last = (s.worker.models.get('w')?.prompts.at(-1) ?? []) as unknown as Array<{
      role: string
      content: Array<{ toolCallId?: string; output?: unknown }>
    }>
    const read = last
      .filter((m) => m.role === 'tool')
      .flatMap((m) => m.content)
      .find((part) => part.toolCallId === 'rf')
    const wire = JSON.stringify(read?.output)
    expect(wire.length).toBeLessThan(21_000)
    expect(wire.length).toBeGreaterThan(5_000)
    expect(wire.toLowerCase()).toContain('truncated')
  })

  test('a worker turn goes past the 20 base steps (stepBudget extends it) and still finishes', async () => {
    const steps = Array.from({ length: 24 }, (_, i) => ({
      toolCalls: [
        {
          toolName: 'write_file',
          toolCallId: `l${i}`,
          input: { path: `/f${i}.txt`, content: `file ${i}\n` },
        },
      ],
    }))
    const s = await scenario({ worker: [...steps, { text: 'Done after 24 steps.' }] })
    await ask(s.r)
    await until(
      'task finished',
      () => tasksOf(s.r.client),
      (t) => t[0] !== undefined && !['running', 'waiting'].includes(t[0].status),
    )
    expect(s.worker.models.get('w')?.calls.length).toBe(25)
  })
})
