import { afterEach, describe, expect, test } from 'bun:test'
import type { SignIn, SignInMethodItem, SignInState } from '@keith/client'
import { resolveTheme, ThemeProvider } from '@keith/ui'
import { cleanup, render } from '@keith/ui/testing'
import { stripAnsi } from '../../testing/ansi.ts'
import { frameUntil, pressUntil } from '../../testing/ink.ts'
import { type LoginResult, LoginScreen } from './index.ts'

afterEach(cleanup)

const ESC = '\u001b'
const ENTER = '\r'
const TAB = '\t'
const SHIFT_TAB = '\u001b[Z'
const CORE = 'https://keith.example.ts.net'
// built at runtime: fake secrets, never literals
const SECRET = `${'pw'}-${'q7'.repeat(5)}`

interface Fake extends SignIn {
  calls: string[]
  set(state: SignInState): void
}

function fakeSignIn(initial: SignInState): Fake {
  let state = initial
  let keep = false
  const listeners = new Set<(s: SignInState) => void>()
  const calls: string[] = []
  return {
    calls,
    set(next) {
      state = next
      for (const l of [...listeners]) l(next)
    },
    get: () => state,
    subscribe(l) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    async submitAddress(a) {
      calls.push(`address:${a}`)
    },
    async submitIdentifier(id) {
      calls.push(`identify:${id}`)
    },
    chooseMethod(m) {
      calls.push(`choose:${m}`)
    },
    async submitStep(answer) {
      // lengths only: the fake never keeps what was typed
      calls.push(
        `step:${Object.entries(answer)
          .map(([k, v]) => `${k}=${v.length}`)
          .join(',')}`,
      )
    },
    cancel() {
      calls.push('cancel')
    },
    back() {
      calls.push('back')
    },
    async retry() {
      calls.push('retry')
    },
    setRememberDevice(on) {
      calls.push(`remember:${on}`)
      keep = on
    },
    rememberDevice: () => keep,
    canRememberDevice: () =>
      state.step === 'flow' && state.method !== 'device' && state.method !== 'token',
    dispose() {},
  }
}

const INFO = { version: '0.4.1', sha: 'abc' }
const method = (
  id: string,
  label: string,
  fields: SignInMethodItem['firstStep']['fields'],
  extra: Partial<SignInMethodItem> = {},
): SignInMethodItem => ({
  id,
  label,
  available: true,
  assurance: 1,
  interaction: 'form',
  firstStep: { id, title: label, fields },
  ...extra,
})
const PIN_FIELD = [{ name: 'pin', label: 'PIN', kind: 'digits', mask: true }] as const
const PASSWORD_FIELD = [
  { name: 'password', label: 'Password', kind: 'secret', mask: true },
] as const
const DEVICE = method('device', 'Device code', [], { interaction: 'poll', assurance: 0 })
const PIN = method('pin', 'PIN', [...PIN_FIELD], { default: true })
const PASSWORD = method('password', 'Password', [...PASSWORD_FIELD], { assurance: 2 })
const TOKEN_M = method(
  'token',
  'Token',
  [{ name: 'token', label: 'Credential', kind: 'secret', mask: true }],
  { assurance: 0 },
)
const METHODS = [DEVICE, PIN, PASSWORD, TOKEN_M]

const flow = (over: Partial<Extract<SignInState, { step: 'flow' }>> = {}): SignInState => ({
  step: 'flow',
  core: CORE,
  info: INFO,
  identifier: 'ana',
  context: 'loopback',
  methods: METHODS,
  method: 'pin',
  current: PIN.firstStep,
  ...over,
})

function show(
  state: SignInState,
  props: Partial<Parameters<typeof LoginScreen>[0]> = {},
  columns = 100,
) {
  const signIn = fakeSignIn(state)
  const done: LoginResult[] = []
  const cancelled: string[] = []
  const view = render(
    <ThemeProvider theme={resolveTheme({ theme: 'dark', depth: 'none' })} spinner={false}>
      <LoginScreen
        signIn={signIn}
        columns={columns}
        onDone={(r) => done.push(r)}
        onCancel={() => cancelled.push('cancel')}
        {...props}
      />
    </ThemeProvider>,
    { columns },
  )
  const frame = (): string => stripAnsi(view.lastFrame() ?? '')
  const allFrames = (): string => view.frames.map(stripAnsi).join('\n')
  const until = (check: (f: string) => boolean) => frameUntil(frame, check, 3000)
  const press = (key: string, check: (f: string) => boolean) =>
    pressUntil(view.stdin, frame, key, check, { timeoutMs: 3000 })
  return { signIn, done, cancelled, view, frame, allFrames, until, press }
}

describe('address, socket and checking', () => {
  test('the address is prefilled, its problem shows, enter checks it', async () => {
    const t = show({ step: 'address', address: CORE, problem: 'cannot reach that core' })
    const f = await t.until((x) => x.includes('cannot reach') && x.includes('[esc] cancel'))
    expect(f).toContain('Sign in')
    expect(f).toContain(CORE)
    expect(f).toContain('✕ cannot reach that core')
    expect(f).toContain('[esc] cancel')
    t.view.stdin.write(ENTER)
    await Bun.sleep(30)
    expect(t.signIn.calls).toEqual([`address:${CORE}`])
  })

  test('initialCore fills an empty address and typing edits it', async () => {
    const t = show({ step: 'address', address: '' }, { initialCore: 'host:7420' })
    await t.until((x) => x.includes('host:7420'))
    t.view.stdin.write('1')
    await t.until((x) => x.includes('host:74201'))
    t.view.stdin.write(ENTER)
    await Bun.sleep(30)
    expect(t.signIn.calls).toEqual(['address:host:74201'])
  })

  test('[esc] on the address cancels the screen', async () => {
    const t = show({ step: 'address', address: CORE })
    await t.until((x) => x.includes('address'))
    await t.press(ESC, () => t.cancelled.length > 0)
    expect(t.cancelled).toEqual(['cancel'])
  })

  test('checking shows a spinner line and esc cancels the request', async () => {
    const t = show({ step: 'checking', core: CORE })
    const f = await t.until((x) => x.includes('asking the core ...') && x.includes('[esc] cancel'))
    expect(f).toContain('[esc] cancel')
    await t.press(ESC, () => t.signIn.calls.includes('cancel'))
  })

  test('the socket needs no login: enter continues with the socket address', async () => {
    const t = show({ step: 'socket', address: 'unix:/tmp/k.sock' })
    const f = await t.until((x) => x.includes('[enter] continue'))
    expect(f).toContain('needs no login')
    await t.press(ENTER, () => t.done.length > 0)
    expect(t.done).toEqual([{ core: 'unix:/tmp/k.sock' }])
  })
})

describe('identify', () => {
  const state: SignInState = { step: 'identify', core: CORE, info: INFO, identifier: '' }

  test('one box with the placeholder; enter sends what was typed', async () => {
    const t = show(state)
    const f = await t.until((x) => x.includes('[enter] next'))
    expect(f).toContain('Keith 0.4.1')
    expect(f).toContain('[enter] next')
    for (const ch of 'ana@home.test') t.view.stdin.write(ch)
    await t.until((x) => x.includes('ana@home.test'))
    t.view.stdin.write(ENTER)
    await Bun.sleep(30)
    expect(t.signIn.calls).toEqual(['identify:ana@home.test'])
  })

  test('a remembered identifier is pre-filled; a problem shows as one line', async () => {
    const t = show({
      ...state,
      identifier: 'ana',
      problem: { reason: 'expired', message: 'the sign-in timed out: enter your id again' },
    })
    const f = await t.until((x) => x.includes('timed out'))
    expect(f).toContain('ana')
    expect(f).toContain('✕ the sign-in timed out: enter your id again')
  })

  test('a throttled identify counts down', async () => {
    const clock = { t: 10_000 }
    const t = show(
      {
        ...state,
        problem: { reason: 'throttled', message: 'too many attempts', retryAt: clock.t + 2000 },
      },
      { now: () => clock.t, tickMs: 10 },
    )
    await t.until((x) => x.includes('try again in 2 s'))
    clock.t += 2500
    await t.until((x) => x.includes('you can try again now'))
  })

  test('esc goes back', async () => {
    const t = show(state)
    await t.until((x) => x.includes('[esc] back'))
    await t.press(ESC, () => t.signIn.calls.includes('back'))
  })
})

describe('flow', () => {
  test('shows the default method as the field, the others as tabs', async () => {
    const t = show(flow())
    const f = await t.until((x) => x.includes('[PIN]') && x.includes('[tab] method'))
    expect(f).toContain('ana')
    expect(f).toContain('Device code')
    expect(f).toContain('Password')
    expect(f).toContain('Token')
    expect(f).toContain('▸ PIN')
    expect(f).toContain('[tab] method')
    expect(f).toContain('[enter] sign in')
  })

  test('the PIN is masked, digits only, sent on enter and cleared', async () => {
    const t = show(flow())
    await t.until((x) => x.includes('[PIN]'))
    for (const ch of '48 15x92') t.view.stdin.write(ch)
    const typed = await t.until((x) => x.includes('••••••'))
    expect(typed).not.toContain('481592')
    t.view.stdin.write(ENTER)
    await Bun.sleep(30)
    expect(t.signIn.calls).toEqual(['step:pin=6'])
    await t.until((x) => !x.includes('•'))
    expect(t.allFrames()).not.toContain('481592')
  })

  test('the password is masked and never drawn', async () => {
    const t = show(flow({ method: 'password', current: PASSWORD.firstStep }))
    await t.until((x) => x.includes('[Password]'))
    for (const ch of SECRET) t.view.stdin.write(ch)
    const f = await t.until((x) => x.includes('•'.repeat(SECRET.length)))
    expect(f).not.toContain(SECRET)
    t.view.stdin.write(ENTER)
    await Bun.sleep(30)
    expect(t.signIn.calls).toEqual([`step:password=${SECRET.length}`])
    expect(t.allFrames()).not.toContain(SECRET)
  })

  test('remember is an opt-in, off by default, one line', async () => {
    const plain = show(flow())
    const f0 = await plain.until((x) => x.includes('[PIN]'))
    expect(f0).not.toContain('remember for 30 days')
    plain.view.unmount()

    const t = show(flow(), { offerRemember: true })
    const off = await t.until((x) => x.includes('[ctrl+r] remember'))
    expect(off).toContain('[ ] remember for 30 days')
    expect(off).toContain('[ctrl+r] remember')
    t.view.stdin.write('\u0012')
    const on = await t.until((x) => x.includes('[x] remember for 30 days'))
    expect(on).not.toContain('anyone using this account')
    expect(t.signIn.calls).toEqual(['remember:true'])
    t.view.stdin.write('\u0012')
    await t.until((x) => x.includes('[ ] remember for 30 days'))
    expect(t.signIn.calls).toEqual(['remember:true', 'remember:false'])
    // a device code and a pasted token cannot be remembered: no row
    const device = show(flow({ method: 'device', current: DEVICE.firstStep }), {
      offerRemember: true,
    })
    const fd = await device.until((x) => x.includes('[Device code]'))
    expect(fd).not.toContain('remember for 30 days')
  })

  test('an empty field sends nothing', async () => {
    const t = show(flow())
    await t.until((x) => x.includes('[PIN]'))
    t.view.stdin.write(ENTER)
    await Bun.sleep(30)
    expect(t.signIn.calls).toEqual([])
  })

  test('tab asks for the next method, shift+tab the previous one', async () => {
    const t = show(flow())
    await t.until((x) => x.includes('[PIN]'))
    await t.press(TAB, () => t.signIn.calls.includes('choose:password'))
    t.view.stdin.write(SHIFT_TAB)
    await t.until(() => t.signIn.calls.includes('choose:device'))
  })

  test('a method with no fields (a poll) asks for a code on enter', async () => {
    const t = show(flow({ method: 'device', current: DEVICE.firstStep }))
    const f = await t.until((x) => x.includes('[enter] ask for a code'))
    expect(f).toContain('[Device code]')
    await t.press(ENTER, () => t.signIn.calls.includes('step:'))
  })

  test('a method the core refused shows its reason and no field', async () => {
    const refused = method('pin', 'PIN', [...PIN_FIELD], {
      available: false,
      reason: 'not accepted from this network: use the password',
    })
    const t = show(flow({ methods: [DEVICE, refused, PASSWORD, TOKEN_M] }))
    const f = await t.until((x) => x.includes('not available here'))
    expect(f).toContain('not accepted from this network: use the password')
    expect(f).toContain('! PIN')
    expect(f).not.toContain('[enter] sign in')
  })

  test('a new method needs no code: its fields are drawn from the description', async () => {
    const totp = method('totp', 'Authenticator', [{ name: 'code', label: 'Code', kind: 'code' }], {
      help: 'Open your authenticator app.',
    } as never)
    const step = { id: 'code', help: 'Open your authenticator app.', fields: totp.firstStep.fields }
    const t = show(flow({ methods: [totp], method: 'totp', current: step }))
    const f = await t.until((x) => x.includes('[Authenticator]'))
    expect(f).toContain('Open your authenticator app.')
    for (const ch of '123456') t.view.stdin.write(ch)
    await t.until((x) => x.includes('123456'))
    t.view.stdin.write(ENTER)
    await Bun.sleep(30)
    expect(t.signIn.calls).toEqual(['step:code=6'])
  })

  test('the plain-HTTP warning shows on the lan next to a secret, and only there', async () => {
    const lan = show(flow({ context: 'lan' }))
    const f = await lan.until((x) => x.includes('plain HTTP'))
    expect(f).toContain('! plain HTTP on this network: others on it could read what you type')
    for (const context of ['loopback', 'tailscale', 'public'] as const) {
      const t = show(flow({ context }))
      const g = await t.until((x) => x.includes('[PIN]'))
      expect(g).not.toContain('plain HTTP')
    }
    // the device code has no secret to type: nothing to warn about
    const device = show(flow({ context: 'lan', method: 'device', current: DEVICE.firstStep }))
    const h = await device.until((x) => x.includes('[Device code]'))
    expect(h).not.toContain('plain HTTP')
  })

  test('a problem is one line, a throttle counts down', async () => {
    const clock = { t: 50_000 }
    const t = show(
      flow({
        problem: { reason: 'throttled', message: 'too many attempts', retryAt: clock.t + 3000 },
      }),
      { now: () => clock.t, tickMs: 10 },
    )
    const f = await t.until((x) => x.includes('try again in 3 s'))
    expect(f).toContain('✕ too many attempts')
    clock.t += 3500
    await t.until((x) => x.includes('you can try again now'))
    const bad = show(
      flow({
        problem: { reason: 'invalid', message: 'sign-in failed: check your id and what you typed' },
      }),
    )
    await bad.until((x) => x.includes('sign-in failed'))
  })

  test('esc goes back to the identifier', async () => {
    const t = show(flow())
    await t.until((x) => x.includes('[esc] back'))
    await t.press(ESC, () => t.signIn.calls.includes('back'))
  })
})

describe('device code', () => {
  test('shows the spaced code, the approve command and a live countdown', async () => {
    const clock = { t: 1_000_000 }
    const t = show(
      {
        step: 'device',
        core: CORE,
        code: 'KTPW-4C7M',
        expiresAt: clock.t + 600_000,
        polling: true,
      },
      { now: () => clock.t, tickMs: 10 },
    )
    const f = await t.until(
      (x) => x.includes('expires in 10 minutes') && x.includes('[esc] cancel'),
    )
    expect(f).toContain('K T P W - 4 C 7 M')
    expect(f).toContain('keith-core devices approve KTPW-4C7M --label <name>')
    expect(f).toContain('waiting for approval')
    clock.t += 570_000
    await t.until((x) => x.includes('expires in 30 s'))
    clock.t += 31_000
    await t.until((x) => x.includes('expired'))
  })

  test('without a code yet it asks for one; esc cancels', async () => {
    const t = show({
      step: 'device',
      core: CORE,
      code: undefined,
      expiresAt: undefined,
      polling: false,
    })
    await t.until((x) => x.includes('asking the core for a code'))
    await t.press(ESC, () => t.signIn.calls.includes('cancel'))
  })
})

describe('working, error, done', () => {
  test('working shows a line; esc cancels', async () => {
    const t = show({ step: 'working', core: CORE, method: 'pin' })
    await t.until((x) => x.includes('signing in ...'))
    await t.press(ESC, () => t.signIn.calls.includes('cancel'))
  })

  test('asking the core for the methods says so', async () => {
    const t = show({ step: 'working', core: CORE, method: undefined })
    await t.until((x) => x.includes('asking the core ...'))
  })

  test('an unreachable core offers enter to try again and esc to go back', async () => {
    const t = show({
      step: 'error',
      core: CORE,
      reason: 'unreachable',
      message: 'cannot reach the core',
      retryable: true,
    })
    const f = await t.until((x) => x.includes('[enter] try again'))
    expect(f).toContain('✕ cannot reach the core')
    await t.press(ENTER, () => t.signIn.calls.includes('retry'))
    await t.press(ESC, () => t.signIn.calls.includes('back'))
  })

  test('done names who signed in, then calls onDone once', async () => {
    const t = show(
      { step: 'done', core: CORE, person: { name: 'Ana', username: 'ana', role: 'member' } },
      { doneMs: 10 },
    )
    const f = await t.until((x) => x.includes('signed in as Ana (member)'))
    expect(f).toContain(`on ${CORE}`)
    await Bun.sleep(80)
    expect(t.done).toEqual([
      { core: CORE, person: { name: 'Ana', username: 'ana', role: 'member' } },
    ])
  })

  test('a live change of state moves the screen (address, checking, identify, flow)', async () => {
    const t = show({ step: 'address', address: CORE })
    await t.until((x) => x.includes('address'))
    t.signIn.set({ step: 'checking', core: CORE })
    await t.until((x) => x.includes('asking the core'))
    t.signIn.set({ step: 'identify', core: CORE, info: INFO, identifier: '' })
    await t.until((x) => x.includes('Keith 0.4.1'))
    t.signIn.set(flow())
    await t.until((x) => x.includes('[PIN]'))
  })
})

describe('widths and colour', () => {
  test('at 60 columns every line fits and a long core, tabs and a warning wrap', async () => {
    const longCore = `https://a-very-long-keith-core-name.tail1234567.ts.net:7420/some/path`
    const t = show(flow({ core: longCore, context: 'lan' }), {}, 60)
    const f = await t.until((x) => x.includes('plain HTTP'))
    for (const line of f.split('\n')) expect([...line].length).toBeLessThanOrEqual(60)
    const d = show(
      {
        step: 'device',
        core: longCore,
        code: 'KTPW-4C7M',
        expiresAt: Date.now() + 120_000,
        polling: true,
      },
      {},
      60,
    )
    const g = await d.until((x) => x.includes('waiting for approval'))
    for (const line of g.split('\n')) expect([...line].length).toBeLessThanOrEqual(60)
    expect(g).toContain('K T P W - 4 C 7 M')
  })

  test('colour off: the refused method, the error and the warning are words and glyphs', async () => {
    const t = show(
      flow({
        context: 'lan',
        problem: { reason: 'invalid', message: 'sign-in failed: check your id and what you typed' },
      }),
    )
    const f = await t.until((x) => x.includes('sign-in failed'))
    expect(f).toContain('✕ sign-in failed')
    expect(f).toContain('! plain HTTP')
    expect(t.view.lastFrame() ?? '').not.toContain('\u001b[')
  })
})
