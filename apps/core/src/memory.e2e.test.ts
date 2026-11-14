/** M4 gate: Hippocampus. The owner's memory is a file on disk that survives a restart. */
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseBrainEvent } from '@keith/contracts'
import { boot, cleanup, connect, FAST, newDir, send, stop } from './testing/core-harness.ts'
import { ask, scenario } from './testing/scenario-harness.ts'
import { testProvider } from './testing/scripted-providers.ts'
import { until } from './testing/wait.ts'

afterAll(cleanup)

const FILE = '/memories/owner/profile.md'

const providers = (front: Parameters<typeof testProvider>[0]['models'][string]) => {
  const f = testProvider({ id: 'front-p', models: { f: front } })
  const w = testProvider({ id: 'cortex-p', models: { w: [{ text: 'x' }] } })
  return { f, defs: [f, w] as never[] }
}

const promptsOf = (p: ReturnType<typeof testProvider>): string[] =>
  (p.models.get('f')?.prompts ?? []).map((x) => JSON.stringify(x))

describe('M4: the owner is remembered', () => {
  test('a memory written in one process is in the prompt after a restart, and the regions light up', async () => {
    const config = newDir()
    const a = providers([
      {
        toolCalls: [
          {
            toolName: 'memory_create',
            toolCallId: 'mc1',
            input: { path: FILE, file_text: 'Owner vegetarian\n' },
          },
        ],
      },
      { text: 'I remember: you are vegetarian.' },
    ])
    const first = await boot(config, a.defs, undefined, FAST)
    await connect(first.client)
    await send(first.client, 'remember I am vegetarian')
    const onDisk = join(config.dataDir, 'memory', 'owner', 'profile.md')
    expect(existsSync(onDisk)).toBe(true)
    expect(readFileSync(onDisk, 'utf8')).toContain('Owner vegetarian')
    // the discipline is in the prompt: preferences yes, secrets and system state no
    const protocol = promptsOf(a.f)[0] ?? ''
    expect(protocol).toContain('API keys')
    expect(protocol).toContain('Never store system state')
    const token = first.token
    await stop(first)

    const b = providers([
      {
        toolCalls: [
          { toolName: 'memory_view', toolCallId: 'mv1', input: { path: '/memories/owner' } },
        ],
      },
      { text: 'You are vegetarian.' },
    ])
    const second = await boot(config, b.defs, token, FAST)
    await send(second.client, 'what should I eat?')
    // the pinned profile is in the first model call of the new process
    expect(promptsOf(b.f)[0]).toContain('vegetarian')

    const events = await until(
      'hippocampus events',
      async () => (await second.client.harness.activity.page({ after: 0, limit: 500 })).events,
      (list) =>
        list.some((e) => e.type === 'brain.hippocampus.recall') &&
        list.some((e) => e.type === 'brain.hippocampus.write'),
    )
    const write = events.find((e) => e.type === 'brain.hippocampus.write')
    const recall = events.find((e) => e.type === 'brain.hippocampus.recall')
    expect(parseBrainEvent(write as never)?.payload).toMatchObject({ op: 'create', path: FILE })
    expect(parseBrainEvent(recall as never)?.payload).toMatchObject({ path: '/memories/owner' })
    // memory tools never light the motor
    const motor = events.filter((e) => e.type === 'brain.motor.act')
    expect(
      motor.filter((e) =>
        String((e.payload as { toolName: string }).toolName).startsWith('memory_'),
      ),
    ).toEqual([])
    await stop(second)
  })

  test('a worker cannot write memory, and its file tools cannot see /memories', async () => {
    const s = await scenario({
      worker: [
        {
          toolCalls: [
            {
              toolName: 'memory_create',
              toolCallId: 'w1',
              input: { path: '/memories/owner/laptop.md', file_text: 'Office laptop: laptop-e\n' },
            },
          ],
        },
        { toolCalls: [{ toolName: 'list_files', toolCallId: 'w2', input: { path: '/' } }] },
        { text: 'Done.' },
      ],
    })
    await ask(s.r)
    await until('worker done', () => s.workerPrompts().length >= 3)
    expect(existsSync(join(s.dataDir, 'memory', 'owner', 'laptop.md'))).toBe(false)
    const events = (await s.r.client.harness.activity.page({ after: 0, limit: 500 })).events
    expect(events.some((e) => e.type === 'brain.hippocampus.write')).toBe(false)
    const last = (s.worker.models.get('w')?.prompts.at(-1) ?? []) as unknown as Array<{
      role: string
      content: Array<{ toolCallId?: string; output?: unknown }>
    }>
    const outputOf = (id: string) =>
      JSON.stringify(
        last
          .filter((m) => m.role === 'tool')
          .flatMap((m) => m.content)
          .find((part) => part.toolCallId === id)?.output,
      )
    expect(outputOf('w1')).toContain('read-only')
    const listed = outputOf('w2')
    expect(listed).not.toContain('memories')
    expect(listed).not.toContain('laptop.md')
  })

  test('a memory write that looks like a secret is refused; a preference still saves', async () => {
    const config = newDir()
    // built at runtime: gitleaks flags key-shaped literals
    const fakeKey = ['sk', 'or', 'v1', 'a1B2c3D4e5F6g7H8i9J0'].join('-')
    const a = providers([
      {
        toolCalls: [
          {
            toolName: 'memory_create',
            toolCallId: 's1',
            input: { path: '/memories/owner/keys.md', file_text: `key ${fakeKey}\n` },
          },
        ],
      },
      {
        toolCalls: [
          {
            toolName: 'memory_create',
            toolCallId: 's2',
            input: { path: FILE, file_text: 'Owner likes coffee without sugar\n' },
          },
        ],
      },
      { text: 'I did not save the key.' },
    ])
    const r = await boot(config, a.defs, undefined, FAST)
    await connect(r.client)
    await send(r.client, 'remember this key')
    const dir = join(config.dataDir, 'memory', 'owner')
    expect(existsSync(join(dir, 'keys.md'))).toBe(false)
    expect(readFileSync(join(dir, 'profile.md'), 'utf8')).toContain('coffee without sugar')
    const sent = promptsOf(a.f).at(-1) ?? ''
    expect(sent).toContain('Refused')
    await stop(r)
  })
})
