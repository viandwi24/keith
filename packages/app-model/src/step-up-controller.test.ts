import { describe, expect, test } from 'bun:test'
import { StepUpError } from '@keith/client/browser'
import { StepUpController } from './step-up-controller.ts'
import { StepUpCancelled } from './step-up-state.ts'

const required = Object.assign(new Error('step up'), { code: 'KEITH_STEP_UP_REQUIRED' })
const tick = () => new Promise((r) => setTimeout(r, 0))

const fakeClient = (
  result: (secret: object) => Promise<{ elevatedUntil: number }> = async () => ({
    elevatedUntil: 1234,
  }),
) => {
  const calls: object[] = []
  return {
    calls,
    client: {
      stepUp: (secret: object) => {
        calls.push(secret)
        return result(secret)
      },
    },
  }
}

describe('StepUpController.guard', () => {
  test('runs the action once when the core does not refuse', async () => {
    const { client } = fakeClient()
    const c = new StepUpController(client as never)
    let runs = 0
    expect(await c.guard(async () => ++runs)).toBe(1)
    expect(c.getSnapshot().prompt).toBeUndefined()
  })

  test('another error passes through without a prompt', async () => {
    const c = new StepUpController(fakeClient().client as never)
    await expect(c.guard(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(c.getSnapshot().prompt).toBeUndefined()
  })

  test('a step-up refusal opens the prompt, then retries once after success', async () => {
    const { client, calls } = fakeClient()
    const c = new StepUpController(client as never)
    let runs = 0
    const done = c.guard(async () => {
      if (++runs === 1) throw required
      return 'ok'
    })
    await tick()
    expect(c.getSnapshot().prompt?.method).toBe('pin')
    c.submit('1234')
    expect(await done).toBe('ok')
    expect(runs).toBe(2)
    expect(calls).toEqual([{ pin: '1234' }])
    expect(c.getSnapshot().prompt).toBeUndefined()
    expect(c.getSnapshot().elevatedUntil).toBe(1234)
  })

  test('preferMethod opens the prompt on the password (a PIN session)', async () => {
    const { client, calls } = fakeClient()
    const c = new StepUpController(client as never, { preferMethod: () => 'password' })
    const done = c.elevate()
    await tick()
    expect(c.getSnapshot().prompt?.method).toBe('password')
    c.submit('a long test passphrase')
    await done
    expect(calls).toEqual([{ password: 'a long test passphrase' }])
  })

  test('a second refusal is the caller error (no third run)', async () => {
    const c = new StepUpController(fakeClient().client as never)
    let runs = 0
    const done = c.guard(async () => {
      runs++
      throw required
    })
    await tick()
    c.submit('1234')
    await expect(done).rejects.toBe(required)
    expect(runs).toBe(2)
  })

  test('cancel rejects with StepUpCancelled and does not retry', async () => {
    const c = new StepUpController(fakeClient().client as never)
    let runs = 0
    const done = c.guard(async () => {
      runs++
      throw required
    })
    await tick()
    c.cancel()
    await expect(done).rejects.toBeInstanceOf(StepUpCancelled)
    expect(runs).toBe(1)
    expect(c.getSnapshot().prompt).toBeUndefined()
  })

  test('two waiting actions share one prompt and both retry', async () => {
    const c = new StepUpController(fakeClient().client as never)
    const attempt = () => {
      let n = 0
      return c.guard(async () => {
        if (n++ === 0) throw required
        return n
      })
    }
    const a = attempt()
    const b = attempt()
    await tick()
    c.submit('1')
    expect(await Promise.all([a, b])).toEqual([2, 2])
  })
})

describe('StepUpController prompt', () => {
  test('a wrong secret keeps the prompt open with the text', async () => {
    const c = new StepUpController(
      fakeClient(() => Promise.reject(new StepUpError('invalid', 'x'))).client as never,
    )
    void c.elevate().catch(() => {})
    c.submit('0000')
    await tick()
    expect(c.getSnapshot().prompt).toMatchObject({ busy: false, error: 'Wrong PIN or password.' })
  })

  test('a PIN session refusal moves to the password tab and shows the core text', async () => {
    const c = new StepUpController(
      fakeClient(() =>
        Promise.reject(
          new StepUpError(
            'pin_session',
            'a PIN session cannot confirm with its PIN: confirm with your password',
          ),
        ),
      ).client as never,
    )
    void c.elevate().catch(() => {})
    c.submit('1234')
    await tick()
    const p = c.getSnapshot().prompt
    expect(p?.method).toBe('password')
    expect(p?.error).toBe('A PIN session cannot confirm with its PIN: confirm with your password')
  })

  test('setMethod and toggleMethod switch tabs and clear the error', () => {
    const c = new StepUpController(fakeClient().client as never)
    void c.elevate().catch(() => {})
    c.setMethod('password')
    expect(c.getSnapshot().prompt?.method).toBe('password')
    c.toggleMethod()
    expect(c.getSnapshot().prompt?.method).toBe('pin')
  })

  test('subscribers hear every change', () => {
    const c = new StepUpController(fakeClient().client as never)
    let n = 0
    const off = c.subscribe(() => n++)
    void c.elevate().catch(() => {})
    c.cancel()
    off()
    c.elevate().catch(() => {})
    expect(n).toBe(2)
  })
})
