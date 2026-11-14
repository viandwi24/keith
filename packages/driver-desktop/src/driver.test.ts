import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityCall, CapabilityResult, DriverContext } from '@keith/driver-sdk'
import type { DesktopAction } from './actions.ts'
import { MissingPermissionError } from './backend.ts'
import { createDesktopDriver, PAUSE_FILE, SCREENSHOT_LIMIT_BYTES } from './driver.ts'
import { type FakeBackend, fakeBackend, fakeJpeg, MAIN_DISPLAY } from './testing/fake-backend.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'keith-desktop-test-'))
  await mkdir(join(root, 'work'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const silent = { info() {}, warn() {}, error() {} }

function ctxFor(options: Record<string, unknown> = {}): DriverContext {
  return {
    logger: silent,
    workdir: join(root, 'work'),
    options,
    signal: new AbortController().signal,
    progress() {},
  }
}

const call = (capability: string, input: unknown, schemaVersion = 1): CapabilityCall => ({
  callId: 'c1',
  capability,
  schemaVersion,
  input,
  timeoutMs: 5000,
})

/** A driver over a fake backend with a clock the test moves by hand. */
function setup(backend: FakeBackend, options: Record<string, unknown> = {}) {
  let clock = 0
  const driver = createDesktopDriver({ backend, now: () => clock })
  return {
    driver,
    ctx: ctxFor(options),
    advance: (ms: number) => {
      clock += ms
    },
    run: (capability: string, input: unknown = {}) =>
      Promise.resolve(
        driver.invoke(call(capability, input), ctxFor(options)),
      ) as Promise<CapabilityResult>,
  }
}

async function screenshotFirst(run: ReturnType<typeof setup>['run']) {
  const shot = await run('desktop.screenshot', {})
  expect(shot.ok).toBe(true)
  return shot
}

const clickAt = (x: number, y: number): DesktopAction => ({ type: 'click', x, y })

describe('desktop.info and desktop.screenshot', () => {
  test('info returns the displays and the front app from the backend', async () => {
    const backend = fakeBackend()
    const { run } = setup(backend)
    const result = await run('desktop.info')
    expect(result).toEqual({ ok: true, output: { displays: [MAIN_DISPLAY], frontApp: 'Notes' } })
  })

  test('screenshot returns base64 JPEG bytes with the size and scale', async () => {
    const backend = fakeBackend()
    const { run } = setup(backend)
    const result = await run('desktop.screenshot', {})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.output).toEqual({
      data: Buffer.from(fakeJpeg(1280, 800)).toString('base64'),
      mimeType: 'image/jpeg',
      width: 1280,
      height: 800,
      scale: 2,
    })
    expect(backend.calls).toContain('screenshot:main:1280')
  })

  test('a screenshot over 1 MB is refused as too large', async () => {
    const backend = fakeBackend()
    backend.nextJpeg = fakeJpeg(1280, 800, SCREENSHOT_LIMIT_BYTES + 1)
    const { run } = setup(backend)
    const result = await run('desktop.screenshot', {})
    expect(result).toEqual({
      ok: false,
      code: 'failed',
      message: `screenshot too large: ${SCREENSHOT_LIMIT_BYTES + 1} bytes, the limit is ${SCREENSHOT_LIMIT_BYTES}`,
    })
  })

  test('a missing Screen Recording permission is refused and names it', async () => {
    const backend = fakeBackend({
      permissionState: { screenRecording: false, accessibility: true },
    })
    const { run } = setup(backend)
    const result = await run('desktop.screenshot', {})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('refused-by-policy')
    expect(result.message).toContain('missing permission: Screen Recording')
    expect(result.message).toContain('System Settings > Privacy & Security > Screen Recording')
    expect(backend.calls.some((c) => c.startsWith('screenshot'))).toBe(false)
  })

  test('a backend that reports a missing permission is refused with the permission name', async () => {
    const backend = fakeBackend()
    backend.screenshot = async () => {
      throw new MissingPermissionError('Screen Recording')
    }
    const { run } = setup(backend)
    const result = await run('desktop.screenshot', {})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('refused-by-policy')
    expect(result.message).toContain('Screen Recording')
  })

  test('an invalid maxWidth is refused as invalid input', async () => {
    const { run } = setup(fakeBackend())
    const result = await run('desktop.screenshot', { maxWidth: 100 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toStartWith('invalid input:')
  })
})

describe('scale mapping', () => {
  test('a click at a point of a 2x Retina screenshot lands on points', async () => {
    const backend = fakeBackend()
    const { run } = setup(backend, { allowInput: true })
    await screenshotFirst(run)
    // 1280x800 image of a 1440x900 point display at scale 2: (640, 400) is the centre, (720, 450) in points.
    const result = await run('desktop.input', { actions: [clickAt(640, 400)] })
    expect(result).toEqual({ ok: true, output: { performed: 1 } })
    expect(backend.inputs[0]).toEqual([{ type: 'click', x: 720, y: 450 }])
  })

  test('a 1x display maps the image pixels to points one to one when unscaled', async () => {
    const backend = fakeBackend({ displays: [{ id: 0, width: 1920, height: 1080, scale: 1 }] })
    backend.nextJpeg = fakeJpeg(1280, 720)
    const { run } = setup(backend, { allowInput: true })
    await screenshotFirst(run)
    await run('desktop.input', { actions: [clickAt(640, 360)] })
    expect(backend.inputs[0]).toEqual([{ type: 'click', x: 960, y: 540 }])
  })

  test('a drag maps both ends', async () => {
    const backend = fakeBackend()
    const { run } = setup(backend, { allowInput: true })
    await screenshotFirst(run)
    await run('desktop.input', {
      actions: [{ type: 'drag', x: 128, y: 80, to: { x: 640, y: 400 } }],
    })
    expect(backend.inputs[0]).toEqual([{ type: 'drag', x: 144, y: 90, to: { x: 720, y: 450 } }])
  })

  test('a point outside the last screenshot is refused, not clamped', async () => {
    const backend = fakeBackend()
    const { run } = setup(backend, { allowInput: true })
    await screenshotFirst(run)
    const result = await run('desktop.input', { actions: [clickAt(1280, 10)] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toBe('point (1280, 10) is outside the last screenshot (1280x800)')
    expect(backend.inputs).toHaveLength(0)
  })

  test('input before any screenshot fails and names the call to make first', async () => {
    const backend = fakeBackend()
    const { run } = setup(backend, { allowInput: true })
    const result = await run('desktop.input', { actions: [clickAt(1, 1)] })
    expect(result).toEqual({
      ok: false,
      code: 'failed',
      message: 'no screenshot yet: call desktop.screenshot before desktop.input',
    })
  })
})

describe('desktop.input policy', () => {
  test('more than 10 actions in one batch is refused', async () => {
    const backend = fakeBackend()
    const { run } = setup(backend, { allowInput: true })
    await screenshotFirst(run)
    const eleven = Array.from({ length: 11 }, () => clickAt(1, 1))
    const refused = await run('desktop.input', { actions: eleven })
    expect(refused).toEqual({
      ok: false,
      code: 'refused-by-policy',
      message: 'at most 10 actions per batch, got 11',
    })
    expect(backend.inputs).toHaveLength(0)

    const ten = Array.from({ length: 10 }, () => clickAt(1, 1))
    expect((await run('desktop.input', { actions: ten })).ok).toBe(true)
  })

  test('allowInput off refuses desktop.input and keeps screenshots working', async () => {
    const backend = fakeBackend()
    const { run } = setup(backend)
    const shot = await run('desktop.screenshot', {})
    expect(shot.ok).toBe(true)
    const result = await run('desktop.input', { actions: [clickAt(1, 1)] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('refused-by-policy')
    expect(result.message).toContain('allowInput is false')
    expect(backend.inputs).toHaveLength(0)
  })

  test('a missing Accessibility permission is refused and names it', async () => {
    const backend = fakeBackend({
      permissionState: { screenRecording: true, accessibility: false },
    })
    const { run } = setup(backend, { allowInput: true })
    await screenshotFirst(run)
    const result = await run('desktop.input', { actions: [clickAt(1, 1)] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('refused-by-policy')
    expect(result.message).toContain('missing permission: Accessibility')
    expect(backend.inputs).toHaveLength(0)
  })

  test('an action without its coordinates is invalid input', async () => {
    const backend = fakeBackend()
    const { run } = setup(backend, { allowInput: true })
    await screenshotFirst(run)
    const result = await run('desktop.input', { actions: [{ type: 'click' }] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toBe('invalid input: action 0: click needs x and y')
  })

  test('a typed text and a key chord reach the backend unchanged', async () => {
    const backend = fakeBackend()
    const { run } = setup(backend, { allowInput: true })
    await screenshotFirst(run)
    const actions: DesktopAction[] = [
      { type: 'type', text: 'hello' },
      { type: 'key', keys: ['cmd', 'shift', 'a'] },
    ]
    await run('desktop.input', { actions })
    expect(backend.inputs[0]).toEqual(actions)
  })
})

describe('stop file and rate limit', () => {
  test('a desktop.pause file in the node folder refuses every desktop call', async () => {
    const backend = fakeBackend()
    const { run } = setup(backend, { allowInput: true })
    await screenshotFirst(run)
    await writeFile(join(root, PAUSE_FILE), '')
    const before = backend.calls.length
    for (const [capability, input] of [
      ['desktop.info', {}],
      ['desktop.screenshot', {}],
      ['desktop.input', { actions: [clickAt(1, 1)] }],
    ] as const) {
      const result = await run(capability, input)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe('refused-by-policy')
      expect(result.message).toContain('desktop is paused')
    }
    expect(backend.calls).toHaveLength(before)
  })

  test('removing the stop file lets calls through again', async () => {
    const backend = fakeBackend()
    const { run } = setup(backend)
    await writeFile(join(root, PAUSE_FILE), '')
    expect((await run('desktop.info')).ok).toBe(false)
    await rm(join(root, PAUSE_FILE))
    expect((await run('desktop.info')).ok).toBe(true)
  })

  test('the window allows maxActionsPerMinute actions and refuses the next one', async () => {
    const backend = fakeBackend()
    const { run, advance } = setup(backend, { maxActionsPerMinute: 3 })
    expect((await run('desktop.info')).ok).toBe(true)
    expect((await run('desktop.info')).ok).toBe(true)
    expect((await run('desktop.info')).ok).toBe(true)
    const refused = await run('desktop.info')
    expect(refused).toEqual({
      ok: false,
      code: 'refused-by-policy',
      message: 'rate limit: at most 3 desktop actions per minute',
    })
    advance(59_999)
    expect((await run('desktop.info')).ok).toBe(false)
    advance(1)
    expect((await run('desktop.info')).ok).toBe(true)
  })

  test('a batch spends one action per entry, so a batch larger than the window is refused whole', async () => {
    const backend = fakeBackend()
    const { run } = setup(backend, { allowInput: true, maxActionsPerMinute: 4 })
    await screenshotFirst(run) // 1 of 4 spent
    const batch = Array.from({ length: 4 }, () => clickAt(1, 1))
    const refused = await run('desktop.input', { actions: batch }) // 4 more would be 5
    expect(refused.ok).toBe(false)
    expect(backend.inputs).toHaveLength(0)
    const fits = await run('desktop.input', { actions: batch.slice(0, 3) }) // 1 + 3 = 4
    expect(fits.ok).toBe(true)
  })

  test('offered leaves desktop.input out unless allowInput is on', () => {
    const driver = createDesktopDriver({ backend: fakeBackend() })
    const ids = (options: Record<string, unknown>) => driver.offered?.(options).map((c) => c.id)
    expect(ids({})).toEqual(['desktop.info', 'desktop.screenshot'])
    expect(ids({ allowInput: true })).toEqual([
      'desktop.info',
      'desktop.screenshot',
      'desktop.input',
    ])
  })

  test('invalid driver options stop the driver at start', () => {
    const driver = createDesktopDriver({ backend: fakeBackend() })
    expect(() => driver.start?.(ctxFor({ allowInput: 'yes' }))).toThrow(
      'allowInput must be true or false',
    )
  })
})

describe('calls the driver does not handle', () => {
  test('another schema version is refused as failed', async () => {
    const { driver } = setup(fakeBackend())
    const result = await driver.invoke(call('desktop.info', {}, 2), ctxFor())
    expect(result).toEqual({
      ok: false,
      code: 'failed',
      message: 'desktop.info schema version 2 is not handled',
    })
  })

  test('a cancelled call returns cancelled before it reaches the backend', async () => {
    const backend = fakeBackend()
    const { driver } = setup(backend)
    const controller = new AbortController()
    controller.abort()
    const ctx = { ...ctxFor(), signal: controller.signal }
    const result = await driver.invoke(call('desktop.info', {}), ctx)
    expect(result).toEqual({ ok: false, code: 'cancelled', message: 'the call was cancelled' })
    expect(backend.calls).toHaveLength(0)
  })
})
