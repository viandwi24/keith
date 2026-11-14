import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import type { UIMessage } from 'ai'
import { createFakeProtocols } from '../../testing/fake-protocols.ts'
import { task } from '../../testing/fixtures.ts'
import { chatReady, frameUntil, pressUntil, typeLine } from '../../testing/ink.ts'
import { setupApp, stopCores } from '../../testing/setup-app.tsx'

afterEach(stopCores)
setDefaultTimeout(40_000)

const user = (id: string, text: string): UIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
})
const assistant = (id: string, parts: unknown[], metadata?: unknown): UIMessage =>
  ({ id, role: 'assistant', parts, ...(metadata === undefined ? {} : { metadata }) }) as UIMessage

const shell = (state: string, extra: Record<string, unknown> = {}, command = 'df -h') => ({
  type: 'tool-motor_remote',
  toolCallId: `c-${state}-${command}`,
  state,
  input: { node: 'laptop-e', capability: 'shell.exec', input: { command } },
  ...extra,
})

describe('the conversation', () => {
  test('an empty conversation shows three muted lines and no banner', async () => {
    const { lastFrame, unmount } = await setupApp()
    const frame = await frameUntil(lastFrame, (f) => f.includes('Talk to keith.'))
    expect(frame).toContain('It can run tasks in the background and act on your nodes.')
    expect(frame).toContain('/tasks shows what runs, /help lists the commands.')
    unmount()
  })

  test('no model set: a warning notice tops the conversation with the keith-core command', async () => {
    const { lastFrame, unmount } = await setupApp()
    const frame = await frameUntil(lastFrame, (f) => f.includes('No model is set yet.'))
    expect(frame).toContain('keith-core model set front <provider/model>')
    expect(frame).toContain('! No model is set yet.')
    unmount()
    stopCores()

    const set = await setupApp({
      rpc: { 'models/roles/get': () => ({ front: 'openrouter/x/y', cortex: null }) },
    })
    await frameUntil(set.lastFrame, (f) => f.includes('type a message'))
    await Bun.sleep(200) // the roles answered: nothing to warn about
    expect(set.lastFrame()).not.toContain('No model is set yet.')
    set.unmount()
  })

  test('tool calls render under their message, in order, with the state at the right', async () => {
    const history = [
      user('u1', 'whats using my disk?'),
      assistant('a1', [
        { type: 'text', text: 'Let me check.' },
        shell('output-available', {
          output: { ok: true, output: 'l1\nl2\nl3\nl4\nl5\nl6', exitCode: 0 },
        }),
        shell('approval-requested', {}, 'rm -rf ~/Library/Caches/*'),
        shell(
          'output-available',
          { output: { ok: true, output: 'denied by fs', exitCode: 1 } },
          'du -sh /',
        ),
        {
          type: 'tool-memory_recall',
          toolCallId: 'm1',
          state: 'output-available',
          input: { path: '/memories/profile.md' },
          output: { found: true },
        },
        { type: 'text', text: 'Your main volume is at 91 %.' },
      ]),
    ]
    const { lastFrame, unmount } = await setupApp({ history, columns: 99, rows: 40 }) // no sidebar: the rows are the whole width
    const f = await frameUntil(lastFrame, (frame) => frame.includes('91 %'))
    const rows = f.split('\n').map((r) => r.slice(0, 99).trimEnd())
    const at = (needle: string) => rows.findIndex((r) => r.includes(needle))
    expect(at('Let me check.')).toBeLessThan(at('laptop-e $ df -h'))
    expect(at('laptop-e $ df -h')).toBeLessThan(at('Your main volume'))
    expect(rows[at('laptop-e $ df -h')]).toMatch(/^ {4}› laptop-e \$ df -h\s+✓$/)
    // at most 3 output lines under the │ gutter, then how many more
    expect(
      rows.slice(at('laptop-e $ df -h') + 1, at('laptop-e $ df -h') + 5).map((r) => r.trim()),
    ).toEqual(['│ l1', '│ l2', '│ l3', '│ … 3 more lines'])
    expect(f).toMatch(/‖ laptop-e \$ rm -rf ~\/Library\/Caches\/\*\s+waiting for approval/)
    expect(f).toMatch(/› laptop-e \$ du -sh \/\s+✕ exit 1/)
    expect(f).toMatch(/› memory_recall \/memories\/profile\.md\s+✓/)
    // the text after the tools starts under the dot column, not at the margin
    expect(rows[at('Your main volume')]).toMatch(/^ {4}Your main volume/)
    unmount()
  })

  test('a delegated task shows its glyph, name, description and the elapsed time of its task', async () => {
    const history = [
      assistant('a1', [
        { type: 'text', text: 'On it.' },
        {
          type: 'tool-agent',
          toolCallId: 'd1',
          state: 'output-available',
          input: { agent: 'cortex.research', description: 'find disk usage on laptop-e' },
          output: 'Started background subagent agent-1',
        },
      ]),
    ]
    const { lastFrame, unmount } = await setupApp({
      history,
      rpc: {
        'tasks/list': () => [
          task({
            agent: 'cortex.research',
            description: 'find disk usage on laptop-e',
            createdAt: Date.now() - 42_000,
          }),
        ],
      },
    })
    const f = await frameUntil(lastFrame, (frame) =>
      /◐ research find disk usage on laptop-e\s+00:4\d/.test(frame),
    )
    expect(f).toContain('On it.')
    unmount()
  })

  test('stored notices keep their place and level: a notice is a glyph-led row: ✕ error, · info, ! warning', async () => {
    const note = (id: string, level: string, message: string) =>
      assistant(id, [{ type: 'data-eh.notice', data: { level, message } }])
    const { lastFrame, unmount } = await setupApp({
      history: [
        user('u', 'hi'),
        note('n1', 'error', 'Provider failed'),
        note('n2', 'info', 'A hint'),
        note('n3', 'warning', 'Careful'),
      ],
    })
    const f = await frameUntil(lastFrame, (frame) => frame.includes('Careful'))
    expect(f).toContain('✕ Provider failed')
    expect(f).toContain('· A hint')
    expect(f).toContain('! Careful')
    expect(f.indexOf('Provider failed')).toBeLessThan(f.indexOf('A hint'))
    unmount()
  })

  test('a message stopped by Esc ends with ■ stopped', async () => {
    const { lastFrame, unmount } = await setupApp({
      history: [
        user('u', 'long job'),
        assistant('a', [{ type: 'text', text: 'Half an answ' }], { eharness: { stop: 'aborted' } }),
      ],
    })
    const f = await frameUntil(lastFrame, (frame) => frame.includes('Half an answ'))
    expect(f).toContain('■ stopped')
    unmount()
  })

  test('an interrupted turn: one warning line, no command hints', async () => {
    const { lastFrame, unmount } = await setupApp({
      history: [
        user('u', 'long job'),
        assistant('a', [{ type: 'text', text: 'partial' }], { eharness: { stop: 'interrupted' } }),
      ],
    })
    const f = await frameUntil(lastFrame, (frame) => frame.includes('was interrupted'))
    expect(f).toContain(
      'The previous turn was interrupted: its process stopped before it finished.',
    )
    expect(f).not.toContain('/retry to redo')
    expect(f).not.toContain('/continue to resume')
    unmount()
  })

  test('the turn shows thinking… before the first words, then the answer', async () => {
    const { lastFrame, frames, stdin, unmount } = await setupApp({ reply: 'Here you go.' })
    await chatReady(lastFrame)
    await typeLine(stdin, 'hello')
    await frameUntil(lastFrame, (f) => f.includes('● Here you go.'))
    // the pulsing glyph of a test frame is the static ✳: it showed while the turn ran
    expect(frames.some((f) => f.includes('✳ thinking…'))).toBe(true)
    expect(lastFrame()).not.toContain('thinking…')
    unmount()
  })

  test('a long conversation sticks to the bottom; pgup scrolls back and says when something arrives', async () => {
    const history: UIMessage[] = []
    for (let i = 1; i <= 30; i++)
      history.push(
        user(`u${i}`, `question ${i}`),
        assistant(`a${i}`, [{ type: 'text', text: `answer ${i}` }]),
      )
    const { lastFrame, stdin, core, unmount } = await setupApp({
      history,
      rows: 20,
      columns: 100,
      reply: 'fresh answer',
    })
    const bottom = await frameUntil(lastFrame, (f) => f.includes('answer 30'))
    expect(bottom).not.toContain('question 1\n')
    for (let i = 0; i < 3; i++)
      await pressUntil(stdin, lastFrame, '\u001b[5~', (f) => !f.includes('answer 30') || i > 0)
    await Bun.sleep(60)
    expect(lastFrame()).not.toContain('answer 30')
    expect(core.chats).toEqual([])
    stdin.write('\u001b[F') // end
    await frameUntil(lastFrame, (f) => f.includes('answer 30'))
    unmount()
  })

  test('sending a message while scrolled up jumps back to the bottom', async () => {
    const history: UIMessage[] = []
    for (let i = 1; i <= 30; i++)
      history.push(
        user(`u${i}`, `question ${i}`),
        assistant(`a${i}`, [{ type: 'text', text: `answer ${i}` }]),
      )
    const { lastFrame, stdin, unmount } = await setupApp({
      history,
      rows: 20,
      columns: 100,
      reply: 'fresh answer',
    })
    await frameUntil(lastFrame, (f) => f.includes('answer 30'))
    await pressUntil(stdin, lastFrame, '\u001b[5~', (f) => !f.includes('answer 30'))
    await typeLine(stdin, 'hello again')
    await frameUntil(lastFrame, (f) => f.includes('● fresh answer'))
    unmount()
  })
})

describe('the input band', () => {
  test('a / draft lists the matching commands; tab completes when one matches; enter runs it', async () => {
    const { lastFrame, stdin, unmount } = await setupApp()
    await chatReady(lastFrame)
    stdin.write('/')
    const all = await frameUntil(lastFrame, (f) => f.includes('/tasks') && f.includes('/nodes'))
    expect(all).toContain('/brain trace')
    expect(all).toContain('/whoami')
    for (const ch of 'ta') stdin.write(ch)
    await frameUntil(lastFrame, (f) => /^\s+\/ta\s*(│.*)?$/m.test(f) && !f.includes('/nodes  '))
    await pressUntil(
      stdin,
      lastFrame,
      '\t', // the draft row and the single matching hint row both read /tasks once the draft is completed
      (f) => (f.match(/^\s+\/tasks\s*(│.*)?$/gm) ?? []).length >= 2,
    )
    await pressUntil(stdin, lastFrame, '\r', (f) => f.includes('No tasks yet'))
    unmount()
  })

  test('ctrl+j and backslash+enter make a multi-line message, sent whole', async () => {
    const { lastFrame, stdin, core, unmount } = await setupApp()
    await chatReady(lastFrame)
    for (const ch of 'first') stdin.write(ch)
    stdin.write('\n')
    for (const ch of 'second\\') stdin.write(ch)
    await Bun.sleep(40)
    stdin.write('\r')
    for (const ch of 'third') stdin.write(ch)
    await frameUntil(lastFrame, (f) => f.includes('third'))
    expect(core.chats).toEqual([])
    stdin.write('\r')
    await frameUntil(lastFrame, (f) => core.chats.length === 1 && f.includes('● Hello from Keith.'))
    expect(core.chats[0]?.text).toBe('first\nsecond\nthird')
    const rows = (lastFrame() ?? '').split('\n').map((r) => r.slice(0, 40).trimEnd())
    const at = rows.indexOf('  › first')
    expect(rows.slice(at, at + 3)).toEqual(['  › first', '    second', '    third'])
    unmount()
  })

  test('a long paste is sent whole but shown as 10 lines and … +n lines', async () => {
    const { lastFrame, stdin, core, unmount } = await setupApp()
    await chatReady(lastFrame)
    const text = Array.from({ length: 15 }, (_, i) => `pasted ${i + 1}`).join('\n')
    stdin.write(`\u001b[200~${text}\u001b[201~`)
    await frameUntil(lastFrame, (f) => f.includes('pasted 15')) // the band scrolls to the last rows
    expect(core.chats).toEqual([]) // never sent on paste
    stdin.write('\r')
    // the row renders before the request reaches the fake core: wait for both
    const f = await frameUntil(
      lastFrame,
      (frame) => frame.includes('… +5 lines') && core.chats.length === 1,
    )
    expect(f).toContain('pasted 10')
    expect(f).not.toContain('pasted 11')
    expect(core.chats[0]?.text).toBe(text)
    unmount()
  })

  test('the placeholder says esc to stop while the answer runs', async () => {
    const { lastFrame, frames, stdin, unmount } = await setupApp()
    await chatReady(lastFrame)
    await typeLine(stdin, 'hello')
    await frameUntil(lastFrame, (f) => f.includes('● Hello from Keith.'))
    expect(frames.some((f) => f.includes('  esc to stop'))).toBe(true)
    expect(lastFrame()).toContain('type a message, or /help')
    unmount()
  })
})

describe('a protocol question', () => {
  test('an ask of a run is a card in the chat with its options, and its answer is a chat reply', async () => {
    const history = [
      {
        id: 'q1',
        role: 'user',
        parts: [
          {
            type: 'data-eh.event',
            data: {
              name: 'protocol.ask',
              text: 'Water the plants today?',
              data: { runId: 'run-7', step: 'ask-water', options: ['yes', 'later'] },
            },
          },
        ],
      },
    ] as UIMessage[]
    const { lastFrame, unmount } = await setupApp({ history, columns: 99, rows: 40 })
    const frame = await frameUntil(lastFrame, (f) => f.includes('tab to answer'))
    // the newest question with options is the card that takes keys
    expect(frame).toContain('Keith asks')
    expect(frame).toContain('tab to answer')
    unmount()
  })
})

describe('answering a protocol question in the chat', () => {
  const ask = (runId: string) =>
    [
      {
        id: 'q1',
        role: 'user',
        parts: [
          {
            type: 'data-eh.event',
            data: {
              name: 'protocol.ask',
              text: 'Water the plants today?',
              data: { runId, step: 'ask-water', options: ['yes', 'later'] },
            },
          },
        ],
      },
    ] as UIMessage[]

  test.each([80, 120])(
    'tab gives the keys to the card; a number answers it and the card says so (%i columns)',
    async (columns) => {
      const fake = createFakeProtocols({ waitingAsk: true })
      const { lastFrame, stdin, unmount } = await setupApp({
        history: ask('run-7'),
        rpc: fake.rpc,
        columns,
        rows: 40,
      })
      const card = await frameUntil(lastFrame, (f) => f.includes('tab to answer'))
      expect(card).toContain('Keith asks')
      expect(card).toContain('Water the plants today?')
      expect(card).toContain('1  yes')
      expect(card).toContain('2  later')
      await pressUntil(stdin, lastFrame, '\t', (f) => !f.includes('tab to answer'))
      await pressUntil(stdin, lastFrame, '2', (f) => f.includes('answered: later'))
      expect(fake.inputs('protocols/answer')).toEqual([{ runId: 'run-7', option: 'later' }])
      // the card takes no keys any more: its options are gone, the answer stays
      expect(lastFrame()).not.toContain('1  yes')
      expect(lastFrame()).not.toContain('tab to answer')
      stdin.write('1')
      await Bun.sleep(100)
      expect(fake.inputs('protocols/answer')).toHaveLength(1)
      unmount()
    },
  )

  test('enter answers the highlighted option; a closed question says question closed', async () => {
    const fake = createFakeProtocols({ waitingAsk: true })
    const { lastFrame, stdin, unmount } = await setupApp({
      history: ask('run-closed'),
      rpc: fake.rpc,
      columns: 80,
      rows: 40,
    })
    await frameUntil(lastFrame, (f) => f.includes('tab to answer'))
    await pressUntil(stdin, lastFrame, '\t', (f) => !f.includes('tab to answer'))
    await pressUntil(stdin, lastFrame, '\r', (f) => f.includes('question closed'))
    expect(fake.inputs('protocols/answer')).toEqual([{ runId: 'run-closed', option: 'yes' }])
    expect(lastFrame()).not.toContain('1  yes')
    unmount()
  })

  test('two enters in one burst answer the question once, not twice', async () => {
    const fake = createFakeProtocols({ waitingAsk: true })
    const { lastFrame, stdin, unmount } = await setupApp({
      history: ask('run-burst'),
      rpc: fake.rpc,
      columns: 80,
      rows: 40,
    })
    await frameUntil(lastFrame, (f) => f.includes('tab to answer'))
    await pressUntil(stdin, lastFrame, '\t', (f) => !f.includes('tab to answer'))
    stdin.write('\r')
    stdin.write('\r')
    await frameUntil(lastFrame, (f) => f.includes('1  yes') || f.includes('question closed'))
    await Bun.sleep(100)
    expect(fake.inputs('protocols/answer')).toEqual([{ runId: 'run-burst', option: 'yes' }])
    unmount()
  })

  test('a chat message does not answer the question: the keys stay with the input until tab', async () => {
    const fake = createFakeProtocols({ waitingAsk: true })
    const { lastFrame, stdin, unmount } = await setupApp({
      history: ask('run-7'),
      rpc: fake.rpc,
      columns: 80,
      rows: 40,
    })
    await frameUntil(lastFrame, (f) => f.includes('tab to answer'))
    await typeLine(stdin, '1')
    await Bun.sleep(100)
    expect(fake.inputs('protocols/answer')).toEqual([])
    unmount()
  })
})
