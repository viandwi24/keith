import { afterEach, describe, expect, test } from 'bun:test'
import type { UIMessage } from 'ai'
import { hasColour } from './testing/ansi.ts'
import { createFakeAdmin } from './testing/fake-admin.ts'
import { MEMBER } from './testing/fake-core.ts'
import { launch, stopPty, until } from './testing/pty.ts'

const ptySupported = process.platform !== 'win32'

/** Above bun's 5 s default: starting the CLI is slow on emulated CI machines. */
const TEST_TIMEOUT = 90_000

afterEach(stopPty)

/** Type a line, press Enter and wait for the streamed reply. */
async function chatInPty(
  history: UIMessage[],
  ready: string[] = [],
  { cols = 100, brain = false }: { cols?: number; brain?: boolean } = {},
): Promise<void> {
  const { cli: app, core: fake } = await launch({ history }, ready, cols)
  const screen = app.screen
  if (brain) {
    // the feed has no history: push once the stream is open, then the panel must show it
    await until(() => fake.streams() !== 0, 20_000, 'the activity stream', screen)
    fake.emit({
      type: 'brain.thalamus.routed',
      payload: { region: 'thalamus', sessionId: 'front:p1', preview: 'tes' },
    })
    fake.emit({
      type: 'task-changed',
      payload: { task: pushedTask },
    })
    if (cols < 100) {
      // no sidebar below 100 columns: the activity strip counts the task, ctrl+b shows the panels
      await until(() => screen().includes('1 task running'), 20_000, 'the activity strip', screen)
      app.proc.terminal?.write('\u0002')
    }
    await until(
      () => screen().includes('thalamus') && screen().includes('pty-find'),
      20_000,
      'the brain trail in the header and the task in the sidebar',
      screen,
    )
  }
  app.proc.terminal?.write('tes')
  await until(() => /^\s+tes\s*(│.*)?$/m.test(screen()), 20_000, 'the typed text', screen)
  app.proc.terminal?.write('\r')
  await until(() => screen().includes('Hello from Keith.'), 20_000, 'the streamed reply', screen)
  expect(fake.seen).toContain('POST /sessions/front%3Aowner/chat')
}

/** A shell approval of a worker, as `GET /attention` lists it. */
const approvalItem = {
  id: 'ap1',
  kind: 'approval',
  sessionId: 'task-1',
  parentSessionId: 'front:p1',
  rootSessionId: 'front:p1',
  description: 'check disk space',
  toolCallId: 'c1',
  toolName: 'motor_remote',
  input: { node: 'laptop-e', capability: 'shell.exec', input: { command: 'df -h' } },
  risk: 'external',
  messageId: 'm1',
  createdAt: 1,
  answeredWaiting: 0,
}

/**
 * An approval waits in /attention: the dialog shows it, Tab gives it the keys, `y` sends the
 * approved answer (read from the fake core, not from the screen).
 */
async function approveInPty(): Promise<void> {
  const { cli: app, core: fake } = await launch(
    {
      attention: [approvalItem],
    },
    ['Approval needed', 'wants to run a shell command on laptop-e', '$ df -h'],
  )
  // a Tab sent before the bar's key handler is attached is dropped: write it again, but only
  // while the focused hint was never drawn (a handled Tab would toggle the focus back)
  const start = Date.now()
  let lastTab = 0
  while (!app.screen().includes('[y] allow')) {
    if (Date.now() - start > 20_000)
      throw new Error(`the bar never got the keys; screen:\n${app.screen()}`)
    if (Date.now() - lastTab > 1500) {
      app.proc.terminal?.write('\t')
      lastTab = Date.now()
    }
    await Bun.sleep(20)
  }
  app.proc.terminal?.write('y')
  await until(() => fake.answers.length > 0, 20_000, 'the approval answer', app.screen)
  expect(fake.answers).toEqual([
    {
      id: 'ap1',
      body: { sessionId: 'task-1', answer: { kind: 'approval', approved: true } },
    },
  ])
  await until(() => !fake.attention.length, 5_000, 'the item to leave the core')
}

/**
 * A member's remote answer is refused until a step-up: the PIN prompt opens, the PIN is typed
 * masked, and the answer is sent once more and accepted; the header then counts the elevation.
 */
async function memberStepUpInPty(): Promise<void> {
  const { cli: app, core: fake } = await launch(
    { whoami: MEMBER, stepUp: { required: true }, attention: [approvalItem] },
    ['Approval needed'],
  )
  const start = Date.now()
  let lastKey = 0
  while (!app.screen().includes("Confirm it's you")) {
    if (Date.now() - start > 30_000) throw new Error(`no step-up prompt:\n${app.screen()}`)
    if (Date.now() - lastKey > 1500) {
      app.proc.terminal?.write(app.screen().includes('[y] allow') ? 'y' : '\t')
      lastKey = Date.now()
    }
    await Bun.sleep(20)
  }
  await Bun.sleep(300)
  app.proc.terminal?.write('1234')
  await until(() => app.screen().includes('PIN › ••••'), 20_000, 'the masked PIN', app.screen)
  expect(app.screen()).not.toContain('1234')
  app.proc.terminal?.write('\r')
  await until(() => fake.answers.length >= 2, 20_000, 'the retried answer', app.screen)
  await until(() => fake.attention.length === 0, 5_000, 'the item to leave the core')
  await until(() => app.screen().includes('elevated 9:'), 20_000, 'the elevated header', app.screen)
  expect(fake.stepUps).toEqual([{ pin: '1234' }])
}

/**
 * The connection drops in the middle of the answer: the TUI re-attaches (the core replays the
 * answer on `GET /chat/stream`) and the full answer ends up on the screen.
 */
async function droppedAnswerInPty(): Promise<void> {
  const { cli: app, core: fake } = await launch({ reply: 'satu dua tiga empat lima enam' })
  const screen = app.screen
  // the cut waits for the first words on screen: see `dropNextAnswer`
  fake.dropNextAnswer(2, () => /^\s+\S\s+satu\b/m.test(screen()))
  app.proc.terminal?.write('tes')
  await until(() => /^\s+tes\s*(│.*)?$/m.test(screen()), 20_000, 'the typed text', screen)
  app.proc.terminal?.write('\r')
  await until(
    () => screen().includes('satu dua tiga empat lima enam'),
    30_000,
    'the full answer after the drop',
    () => `${screen()}\ncore saw: ${JSON.stringify(fake.seen)}`,
  )
  expect(fake.seen).toContain('GET /sessions/front%3Aowner/chat/stream')
}

/** The cut lands before any word reached the client: eharness calls it a failed send. */
async function droppedBeforeWordsInPty(): Promise<void> {
  const { cli: app, core: fake } = await launch({ reply: 'satu dua tiga empat lima enam' })
  const screen = app.screen
  fake.dropNextAnswer(0)
  app.proc.terminal?.write('tes')
  await until(() => /^\s+tes\s*(│.*)?$/m.test(screen()), 20_000, 'the typed text', screen)
  app.proc.terminal?.write('\r')
  await until(
    () => screen().includes('satu dua tiga empat lima enam'),
    30_000,
    'the full answer after the early drop',
    () => `${screen()}\ncore saw: ${JSON.stringify(fake.seen)}`,
  )
  expect(fake.seen).toContain('GET /sessions/front%3Aowner/chat/stream')
}

/**
 * The whole flow under NO_COLOR: send and stream, an approval answered with Tab and y, `/tasks`
 * and Esc. Chalk is forced on (FORCE_COLOR) so only the theme can keep the colour out; the
 * screen must hold no colour code (bold, dim and inverse are fine) and every state must still be
 * readable as text and glyphs.
 */
async function noColorFlowInPty(): Promise<void> {
  const { cli: app, core: fake } = await launch(
    { attention: [approvalItem], rpc: { 'tasks/list': () => [pushedTask] } },
    ['Approval needed', 'wants to run a shell command on laptop-e'],
    100,
    { NO_COLOR: '1', FORCE_COLOR: '3' },
  )
  const screen = app.screen
  app.proc.terminal?.write('tes')
  await until(() => /^\s+tes\s*(│.*)?$/m.test(screen()), 20_000, 'the typed text', screen)
  app.proc.terminal?.write('\r')
  await until(() => screen().includes('● Hello from Keith.'), 20_000, 'the streamed reply', screen)
  // the approval dialog is the one bordered element without colour
  expect(screen()).toContain('╭')
  expect(screen()).toContain('tab to answer')
  let lastTab = 0
  const start = Date.now()
  while (!screen().includes('[y] allow')) {
    if (Date.now() - start > 20_000) throw new Error(`the dialog never got the keys:\n${screen()}`)
    if (Date.now() - lastTab > 1500) {
      app.proc.terminal?.write('\t')
      lastTab = Date.now()
    }
    await Bun.sleep(20)
  }
  app.proc.terminal?.write('y')
  await until(() => fake.answers.length > 0, 20_000, 'the approval answer', screen)
  await until(() => fake.attention.length === 0, 5_000, 'the item to leave the core')
  // /tasks and back: the input band is gone on the screen and returns after esc
  const lines = ['/', 't', 'a', 's', 'k', 's']
  for (const ch of lines) app.proc.terminal?.write(ch)
  await until(
    () => (screen().match(/^\s+\/tasks\s*(│.*)?$/gm) ?? []).length >= 2,
    20_000,
    'the command typed',
    screen,
  )
  app.proc.terminal?.write('\r')
  await until(
    () => screen().includes('[↑↓] select    [enter] open'),
    20_000,
    'the tasks screen',
    screen,
  )
  expect(screen()).toContain('pty-find')
  app.proc.terminal?.write('\u001b')
  await until(
    () => screen().includes('type a message') && !screen().includes('[↑↓] select'),
    20_000,
    'the chat after esc',
    screen,
  )
  // chalk was on (bold shows) and still no colour reached the terminal
  expect(app.raw()).toContain(String.fromCharCode(27, 91, 49, 109))
  expect(hasColour(app.raw())).toBe(false)
}

/** The same screen in truecolor: the dark theme colours the accent, the frames and the status, and paints no background. */
async function truecolorInPty(): Promise<void> {
  const { cli: app } = await launch({}, [], 100, {
    NO_COLOR: undefined,
    COLORTERM: 'truecolor',
    FORCE_COLOR: '3',
    COLORFGBG: '15;0',
  })
  const raw = app.raw()
  const SGR = (code: string): string => `${String.fromCharCode(27)}[${code}m`
  // accent #8ab4f8, border #363b47 for the sidebar frames; the only background is the user-message fill
  expect(raw).toContain(SGR('38;2;138;180;248'))
  expect(raw).toContain(SGR('38;2;54;59;71'))
  // 48;2;34;37;44 is the user-message fill (#22252c): no other background is painted
  const backgrounds = [
    ...raw.matchAll(new RegExp(`${String.fromCharCode(27)}\\[48;[0-9;]*m`, 'g')),
  ].map((m) => m[0])
  for (const b of backgrounds) expect(b).toBe(`${String.fromCharCode(27)}[48;2;34;37;44m`)
  expect(raw).toContain(SGR('38;2;140;207;154')) // success: the connection glyph
}

const pushedTask = {
  id: 't1',
  parentSessionId: 'front:p1',
  agent: 'cortex.research',
  description: 'pty-find',
  status: 'running',
  steps: 0,
  summary: null,
  error: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  finishedAt: null,
}

const part = (text: string): UIMessage['parts'] => [{ type: 'text', text }]

describe.skipIf(!ptySupported)('cli in a real pseudo-terminal', () => {
  test(
    'typing a line and pressing Enter sends it and shows the streamed reply',
    async () => {
      await chatInPty([])
    },
    TEST_TIMEOUT,
  )

  test(
    'the same with a stored history (user, empty assistant, notice)',
    async () => {
      await chatInPty(
        [
          { id: 'u1', role: 'user', parts: part('hello') },
          { id: 'a1', role: 'assistant', parts: [] },
          {
            id: 'n1',
            role: 'assistant',
            parts: [{ type: 'data-eh.notice', data: { level: 'info', message: 'hint' } }],
          } as unknown as UIMessage,
        ],
        ['hello', 'hint'],
      )
    },
    TEST_TIMEOUT,
  )

  test(
    'with the sidebar (120 columns): a pushed brain event and task show, and the chat still works',
    async () => {
      await chatInPty([], [], { cols: 120, brain: true })
    },
    TEST_TIMEOUT,
  )

  test(
    'at 80 columns the activity strip counts the task and ctrl+b shows the sidebar',
    async () => {
      await chatInPty([], [], { cols: 80, brain: true })
    },
    TEST_TIMEOUT,
  )

  test(
    '/quit leaves the alternate screen and exits 0',
    async () => {
      const { cli: app } = await launch({})
      app.proc.terminal?.write('/quit')
      await until(
        () => (app.screen().match(/^\s+\/quit\s*(│.*)?$/gm) ?? []).length >= 2,
        20_000,
        'the command typed',
        app.screen,
      )
      app.proc.terminal?.write('\r')
      expect(await app.proc.exited).toBe(0)
      const esc = String.fromCharCode(27)
      expect(app.raw()).toContain(`${esc}[?1049h`)
      expect(app.raw()).toContain(`${esc}[?1049l`)
    },
    TEST_TIMEOUT,
  )

  test('the whole flow under NO_COLOR draws no colour', noColorFlowInPty, TEST_TIMEOUT)

  test('the dark theme paints in truecolor', truecolorInPty, TEST_TIMEOUT)

  test(
    'an answer cut off in the middle is recovered and shown in full',
    droppedAnswerInPty,
    TEST_TIMEOUT,
  )

  test(
    'an answer cut before the first words is re-attached and shown in full',
    droppedBeforeWordsInPty,
    TEST_TIMEOUT,
  )

  test(
    'a revoked credential shows the logged-out state',
    async () => {
      const { cli: app, core: fake } = await launch({})
      await until(() => fake.streams() !== 0, 20_000, 'the activity stream', app.screen)
      fake.revoke()
      await until(
        // the panel wraps at the width of the left column (63 columns at 100): match the first words
        () => app.screen().includes('This device is logged out or its credential was'),
        20_000,
        'the logged-out state',
        app.screen,
      )
    },
    TEST_TIMEOUT,
  )

  test(
    'an approval shows in the dialog and Tab then y sends the approved answer',
    approveInPty,
    TEST_TIMEOUT,
  )

  test(
    'a member steps up with the PIN and the refused answer goes through',
    memberStepUpInPty,
    TEST_TIMEOUT,
  )

  test(
    'keith manage opens the Manage screen with no chat, lists the sections, and Esc quits',
    async () => {
      const { cli: app, core: fake } = await launch(
        { rpc: createFakeAdmin().rpc },
        ['Manage', 'Overview', 'Audit'],
        120,
        undefined,
        ['manage'],
      )
      expect(app.screen()).not.toContain('type a message')
      // a key written before the handler is attached is dropped: write Esc again until the process ends
      const exited = app.proc.exited
      let done = false
      void exited.then(() => {
        done = true
      })
      const start = Date.now()
      while (!done) {
        if (Date.now() - start > 20_000)
          throw new Error(`manage did not quit on Esc; screen:\n${app.screen()}`)
        app.proc.terminal?.write('\u001b')
        await Bun.sleep(500)
      }
      expect(await exited).toBe(0)
      expect(fake.seen.some((l) => l.includes('/sessions/'))).toBe(false)
    },
    TEST_TIMEOUT,
  )
})
