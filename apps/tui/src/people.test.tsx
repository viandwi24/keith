import { afterEach, describe, expect, test } from 'bun:test'
import { MEMBER } from './testing/fake-core.ts'
import { approval, askedByApproval, node, waitingApproval } from './testing/fixtures.ts'
import { frameUntil, pressUntil, scrollUntil, typeLine } from './testing/ink.ts'
import { type SetupOptions, setupApp, stopCores } from './testing/setup-app.tsx'

afterEach(stopCores)

const member = { whoami: MEMBER, budget: { scope: 'person:ana-id', limitUsd: 5, spentUsd: 1.5 } }

async function type(stdin: { write(d: string): void }, text: string) {
  for (const ch of text) {
    stdin.write(ch)
    await Bun.sleep(3)
  }
}

describe('role in the header and /whoami', () => {
  test('the person is not in the header any more: /whoami names a member with the role, the owner as owner', async () => {
    const m = await setupApp(member)
    const header = (await frameUntil(m.lastFrame, (f) => f.includes('online'))).split('\n')[1] ?? ''
    expect(header).not.toContain('ana')
    await typeLine(m.stdin, '/whoami')
    expect(await frameUntil(m.lastFrame, (f) => f.includes('via'))).toContain('· Ana  member')
    m.unmount()
    const o = await setupApp()
    await frameUntil(o.lastFrame, (f) => f.includes('online'))
    await typeLine(o.stdin, '/whoami')
    expect(await frameUntil(o.lastFrame, (f) => f.includes('via'))).toContain('· Owner  owner')
    o.unmount()
  })

  test('/whoami shows username, name, role, via, credential kind and elevated', async () => {
    const { lastFrame, stdin, unmount } = await setupApp({
      whoami: { ...MEMBER, credentialKind: 'device' },
    })
    await typeLine(stdin, '/whoami')
    const frame = await frameUntil(lastFrame, (f) => f.includes('login ana'))
    expect(frame).toContain('Ana  member')
    expect(frame).toContain('device credential')
    expect(frame).toContain('elevated  no')
    unmount()
  })
})

describe('step-up', () => {
  const pending = (): SetupOptions => ({
    attention: [approval({ id: 'ap1' })],
    stepUp: { required: true, pin: '1234' },
    whoami: MEMBER,
  })
  const openDialog = async (options = pending()) => {
    const app = await setupApp(options)
    await frameUntil(app.lastFrame, (f) => f.includes('Approval needed'))
    await pressUntil(app.stdin, app.lastFrame, '\t', (f) => f.includes('[y] allow'))
    await pressUntil(app.stdin, app.lastFrame, 'y', (f) => f.includes("Confirm it's you"))
    await Bun.sleep(150) // Ink attaches the dialog's input handler in an effect
    return app
  }

  test('a refused answer opens the prompt; the PIN is masked; one retry answers; the header counts down', async () => {
    const { lastFrame, stdin, core, unmount } = await openDialog()
    expect(core.answers).toHaveLength(1)
    await type(stdin, '1234')
    const masked = await frameUntil(lastFrame, (f) => f.includes('••••'))
    expect(masked).not.toContain('1234')
    stdin.write('\r')
    const frame = await frameUntil(lastFrame, (f) => !f.includes("Confirm it's you"))
    await frameUntil(lastFrame, (f) => f.includes('elevated 9:5') || f.includes('elevated 10:00'))
    expect(core.stepUps).toEqual([{ pin: '1234' }])
    await frameUntil(lastFrame, () => core.answers.length >= 2)
    await Bun.sleep(100)
    expect(core.answers).toHaveLength(2) // the refusal and exactly one retry
    expect(frame).not.toContain('Failed to answer')
    unmount()
  })

  test('a wrong PIN stays open with a danger row; esc cancels and the approval is not answered', async () => {
    const { lastFrame, stdin, core, unmount } = await openDialog()
    await type(stdin, '9999')
    stdin.write('\r')
    const wrong = await frameUntil(lastFrame, (f) => f.includes('✕ Wrong PIN or password.'))
    expect(wrong).toContain("Confirm it's you")
    await pressUntil(stdin, lastFrame, '\u001b', (f) => !f.includes("Confirm it's you"))
    const frame = await frameUntil(lastFrame, (f) => f.includes('Not confirmed.'))
    expect(frame).toContain('Approval needed')
    expect(core.answers).toHaveLength(1)
    unmount()
  })

  test('tab switches to the password', async () => {
    const options = { ...pending(), stepUp: { required: true, password: 'long-password-1' } }
    const { lastFrame, stdin, core, unmount } = await openDialog(options)
    await pressUntil(stdin, lastFrame, '\t', (f) => f.includes('password ›'))
    await type(stdin, 'long-password-1')
    stdin.write('\r')
    await frameUntil(lastFrame, (f) => !f.includes("Confirm it's you"))
    expect(core.stepUps).toEqual([{ password: 'long-password-1' }])
    await frameUntil(lastFrame, () => core.answers.length >= 2)
    await Bun.sleep(100)
    expect(core.answers).toHaveLength(2)
    unmount()
  })

  test('throttled shows the seconds to wait', async () => {
    const options = { ...pending(), stepUp: { required: true, fail: 'throttled' as const } }
    const { lastFrame, stdin, unmount } = await openDialog(options)
    await type(stdin, '1234')
    stdin.write('\r')
    await frameUntil(lastFrame, (f) => f.includes('Try again in 42 s.'))
    unmount()
  })

  test('no PIN or password set: shows the keith-core hint and only esc', async () => {
    const options = { ...pending(), stepUp: { required: true, fail: 'no_method' as const } }
    const { lastFrame, stdin, unmount } = await openDialog(options)
    await type(stdin, '1234')
    stdin.write('\r')
    const frame = await frameUntil(lastFrame, (f) => f.includes('keith-core people pin ana'))
    expect(frame).toContain('[esc] close')
    expect(frame).not.toContain('[enter] confirm')
    unmount()
  })

  test('an old token explains how to get a new login, with no input', async () => {
    const options = { ...pending(), stepUp: { required: true, fail: 'legacy' as const } }
    const { lastFrame, unmount } = await openDialog(options)
    // the sentence wraps inside the dialog: look for its words, not one line
    const frame = await frameUntil(lastFrame, (f) => f.includes('keith-core token'))
    expect(frame).toContain('This login is an old token.')
    expect(frame).toContain('create')
    expect(frame).toContain('login --token')
    expect(frame).not.toContain('[enter] confirm')
    unmount()
  })

  test('/stepup elevates on demand', async () => {
    const { lastFrame, stdin, core, unmount } = await setupApp({
      whoami: MEMBER,
      stepUp: { pin: '1234' },
    })
    await typeLine(stdin, '/stepup')
    await frameUntil(lastFrame, (f) => f.includes("Confirm it's you"))
    await type(stdin, '1234')
    stdin.write('\r')
    await frameUntil(lastFrame, (f) => f.includes('Confirmed.'))
    expect(core.stepUps).toEqual([{ pin: '1234' }])
    unmount()
  })

  test('/stepup on the local socket says it is always confirmed', async () => {
    const { lastFrame, stdin, unmount } = await setupApp({ whoami: { via: 'local' } })
    await typeLine(stdin, '/stepup')
    await frameUntil(lastFrame, (f) => f.includes('always confirmed'))
    unmount()
  })
})

describe('approvals of two people', () => {
  test('the owner reads who asked, the node and the whole command', async () => {
    const { lastFrame, unmount } = await setupApp({ attention: [askedByApproval()] })
    const frame = await frameUntil(lastFrame, (f) => f.includes('Approval needed'))
    expect(frame).toContain('Ana asks to run a shell command on laptop-e')
    expect(frame).toContain('$ rm -rf /tmp/build-cache')
    expect(frame).toContain('tab to answer')
    unmount()
  })

  test('a member sees their own owner-routed request read only', async () => {
    const { lastFrame, stdin, core, unmount } = await setupApp({
      ...member,
      attention: [waitingApproval()],
    })
    const frame = await frameUntil(lastFrame, (f) => f.includes('Waiting for the owner to approve'))
    expect(frame).not.toContain('tab to answer')
    expect(frame).not.toContain('[tab] approval')
    expect(frame).not.toContain('[y] allow')
    stdin.write('\t')
    stdin.write('y')
    await Bun.sleep(150)
    expect(lastFrame()).not.toContain('[y] allow')
    expect(core.answers).toHaveLength(0)
    unmount()
  })

  test('if the core answers KEITH_WAITING_FOR_OWNER, that text is shown', async () => {
    const { lastFrame, stdin, unmount } = await setupApp({
      ...member,
      attention: [approval({ id: 'ap1' })],
      waitingForOwner: ['ap1'],
    })
    await frameUntil(lastFrame, (f) => f.includes('Approval needed'))
    await pressUntil(stdin, lastFrame, '\t', (f) => f.includes('[y] allow'))
    await pressUntil(stdin, lastFrame, 'y', (f) => f.includes('Waiting for the owner to approve'))
    unmount()
  })
})

describe('/budget by role', () => {
  test('a member sees their own cap, spend and remaining, "set by the owner"', async () => {
    const { lastFrame, stdin, unmount } = await setupApp(member)
    await typeLine(stdin, '/budget')
    const frame = await frameUntil(lastFrame, (f) => f.includes('Your cap'))
    expect(frame).toContain('$5.00 (set by the owner)')
    expect(frame).toContain('$1.50')
    expect(frame).toContain('$3.50')
    expect(frame).toContain('The cap is set by the owner.')
    expect(frame).not.toContain('keith-core budget set')
    unmount()
  })

  test('the owner sees the global figures and a table of people', async () => {
    const person = (over: object) => ({
      personId: 'p',
      username: 'ana',
      name: 'Ana',
      limitUsd: 5,
      spentUsd: 1.5,
      reservedUsd: 0,
      remainingUsd: 3.5,
      ...over,
    })
    const { lastFrame, stdin, unmount } = await setupApp({
      budget: {
        spentUsd: 4,
        people: [
          person({}),
          person({
            personId: 'o',
            username: 'owner',
            name: 'Owner',
            limitUsd: null,
            remainingUsd: null,
            spentUsd: 2.5,
          }),
        ],
      },
    })
    await typeLine(stdin, '/budget')
    const frame = await frameUntil(lastFrame, (f) => /person\s+spent\s+cap\s+left/.test(f))
    expect(frame).toContain('Monthly limit')
    expect(frame).toMatch(/ana\s+\$1\.50\s+\$5\.00\s+\$3\.50/)
    expect(frame).toMatch(/owner\s+\$2\.50\s+no cap/)
    expect(frame).toContain('keith-core budget set')
    unmount()
  })
})

describe('nodes for a member', () => {
  const registry = () => {
    const calls = { list: 0 }
    return {
      calls,
      rpc: {
        'nodes/list': () => {
          calls.list++
          return [node()]
        },
      },
    }
  }

  test('the list is read again on a timer while the sidebar shows it', async () => {
    const reg = registry()
    const { unmount } = await setupApp({ ...member, rpc: reg.rpc, nodesPollMs: 40 })
    const start = Date.now()
    while (reg.calls.list < 4 && Date.now() - start < 5000) await Bun.sleep(20)
    expect(reg.calls.list).toBeGreaterThanOrEqual(4)
    unmount()
  })

  test('the owner gets events, not a timer', async () => {
    const reg = registry()
    const { unmount } = await setupApp({ rpc: reg.rpc, nodesPollMs: 40 })
    await Bun.sleep(200)
    expect(reg.calls.list).toBeLessThanOrEqual(2)
    unmount()
  })

  test('opening /nodes reads the list again', async () => {
    const reg = registry()
    const { lastFrame, stdin, unmount } = await setupApp({ ...member, rpc: reg.rpc })
    await frameUntil(lastFrame, (f) => f.includes('laptop-e'))
    const before = reg.calls.list
    await typeLine(stdin, '/nodes')
    await frameUntil(lastFrame, () => reg.calls.list > before)
    unmount()
  })
})

describe('help by role', () => {
  test('a member is told to ask the owner; the owner sees the keith-core commands', async () => {
    const m = await setupApp(member)
    await typeLine(m.stdin, '/help')
    const first = await frameUntil(m.lastFrame, (f) => f.includes('your spend this month'))
    expect(first).toContain('/stepup')
    const mf = await scrollUntil(m.stdin, m.lastFrame, (f) => f.includes('Ask the owner'))
    expect(mf).not.toContain('keith-core model set')
    m.unmount()
    const o = await setupApp()
    await typeLine(o.stdin, '/help')
    const of = await scrollUntil(o.stdin, o.lastFrame, (f) =>
      f.includes('keith-core model set front <id>'),
    )
    expect(of).toContain('keith-core model set front <id>')
    expect(of).not.toContain('Ask the owner')
    o.unmount()
  })

  test('a settings command shows the owner their keith-core notice and a member "Ask the owner"', async () => {
    const m = await setupApp(member)
    await typeLine(m.stdin, '/pair')
    await frameUntil(m.lastFrame, (f) => f.includes('Ask the owner.'))
    m.unmount()
    const o = await setupApp()
    await typeLine(o.stdin, '/pair')
    await frameUntil(o.lastFrame, (f) => f.includes('keith-core pair'))
    o.unmount()
  })
})
