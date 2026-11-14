// The desktop driver: policy, checks and coordinate mapping around a backend
// (docs/specs/node-drivers.md, "Driver desktop"). It never reaches the OS; the backend does.
import { join } from 'node:path'
import {
  type CapabilityCall,
  type CapabilityResult,
  type DriverContext,
  type DriverFailureCode,
  defineDriver,
} from '@keith/driver-sdk'
import {
  actionCount,
  DESKTOP_MAX_ACTIONS,
  type DesktopAction,
  invalid,
  type Parsed,
  parseInfoInput,
  parseInputActions,
  parseScreenshotInput,
} from './actions.ts'
import {
  type DesktopBackend,
  type DesktopPermission,
  type DisplayInfo,
  MissingPermissionError,
  type PermissionState,
} from './backend.ts'
import { jpegSize } from './jpeg.ts'
import { RateLimiter } from './rate-limit.ts'
import { insideShot, type Point, pixelToPoint, type ShotSize } from './scale.ts'

export const DRIVER_NAME = 'desktop'
export const DRIVER_VERSION = '0.1.0'
export const DESKTOP_CAPABILITIES = [
  { id: 'desktop.info', schemaVersion: 1 },
  { id: 'desktop.screenshot', schemaVersion: 1 },
  { id: 'desktop.input', schemaVersion: 1 },
] as const

/** The owner's brake: while this file sits in the node folder's parent, every call is refused. */
export const PAUSE_FILE = 'desktop.pause'
export const SCREENSHOT_LIMIT_BYTES = 1024 * 1024
export const DEFAULT_MAX_ACTIONS_PER_MINUTE = 60

export interface DesktopOptions {
  readonly allowInput: boolean
  readonly maxActionsPerMinute: number
}

export interface DesktopDeps {
  readonly backend: DesktopBackend
  /** Milliseconds; defaults to `Date.now`. Tests pass a fake clock. */
  readonly now?: () => number
}

interface Settings {
  readonly options: DesktopOptions
  readonly limiter: RateLimiter
}

/** The last screenshot: input coordinates are in its pixel space. */
interface LatestShot {
  readonly display: DisplayInfo
  readonly size: ShotSize
}

const ok = (output: unknown): CapabilityResult => ({ ok: true, output })
const failed = (message: string, code: DriverFailureCode = 'failed'): CapabilityResult => ({
  ok: false,
  code,
  message,
})

const PERMISSION_KEYS: Record<DesktopPermission, keyof PermissionState> = {
  'Screen Recording': 'screenRecording',
  Accessibility: 'accessibility',
}

export function parseOptions(raw: Readonly<Record<string, unknown>>): Parsed<DesktopOptions> {
  const allowInput = raw.allowInput ?? false
  if (typeof allowInput !== 'boolean') return invalid('allowInput must be true or false')
  const perMinute = raw.maxActionsPerMinute ?? DEFAULT_MAX_ACTIONS_PER_MINUTE
  if (
    typeof perMinute !== 'number' ||
    !Number.isInteger(perMinute) ||
    perMinute < 1 ||
    perMinute > 600
  ) {
    return invalid('maxActionsPerMinute must be a whole number from 1 to 600')
  }
  return { ok: true, value: { allowInput, maxActionsPerMinute: perMinute } }
}

/** Maps every point of an action from screenshot pixels to points; refuses a point outside the shot. */
function toPoints(action: DesktopAction, latest: LatestShot): Parsed<DesktopAction> {
  const size = latest.size
  const map = (point: Point): Parsed<Point> =>
    insideShot(point, size)
      ? { ok: true, value: pixelToPoint(point, size, latest.display) }
      : invalid(
          `point (${point.x}, ${point.y}) is outside the last screenshot (${size.width}x${size.height})`,
        )

  if (action.type === 'type' || action.type === 'key') return { ok: true, value: action }
  const from = map({ x: action.x ?? -1, y: action.y ?? -1 })
  if (!from.ok) return from
  if (action.type !== 'drag') {
    return { ok: true, value: { ...action, x: from.value.x, y: from.value.y } }
  }
  if (action.to === undefined) return invalid('drag needs to')
  const to = map(action.to)
  if (!to.ok) return to
  return { ok: true, value: { ...action, x: from.value.x, y: from.value.y, to: to.value } }
}

/**
 * Builds the desktop driver over a backend. The module keeps the options, the rate window and the
 * last screenshot per driver instance: one instance per node process.
 */
export function createDesktopDriver({ backend, now = Date.now }: DesktopDeps) {
  let settings: Settings | undefined
  let latest: LatestShot | undefined

  function settle(raw: Readonly<Record<string, unknown>>): Parsed<Settings> {
    if (settings !== undefined) return { ok: true, value: settings }
    const parsed = parseOptions(raw)
    if (!parsed.ok) return parsed
    settings = {
      options: parsed.value,
      limiter: new RateLimiter(parsed.value.maxActionsPerMinute, now),
    }
    return { ok: true, value: settings }
  }

  /** A refusal when the permission is missing or the window is full; undefined when the call may run. */
  async function gate(
    permission: DesktopPermission | undefined,
    cost: number,
    current: Settings,
    signal: AbortSignal,
  ): Promise<CapabilityResult | undefined> {
    if (permission !== undefined) {
      const state = await backend.permissions(signal)
      if (!state[PERMISSION_KEYS[permission]]) {
        return failed(
          `missing permission: ${permission}. Grant it to the app that runs keith-node in System Settings > Privacy & Security > ${permission}.`,
          'refused-by-policy',
        )
      }
    }
    if (!current.limiter.take(cost)) {
      return failed(
        `rate limit: at most ${current.options.maxActionsPerMinute} desktop actions per minute`,
        'refused-by-policy',
      )
    }
    return undefined
  }

  async function info(
    input: unknown,
    current: Settings,
    signal: AbortSignal,
  ): Promise<CapabilityResult> {
    const parsed = parseInfoInput(input)
    if (!parsed.ok) return failed(`invalid input: ${parsed.message}`)
    const refusal = await gate(undefined, 1, current, signal)
    if (refusal) return refusal
    return ok(await backend.info(signal))
  }

  async function screenshot(
    input: unknown,
    current: Settings,
    signal: AbortSignal,
  ): Promise<CapabilityResult> {
    const parsed = parseScreenshotInput(input)
    if (!parsed.ok) return failed(`invalid input: ${parsed.message}`)
    const refusal = await gate('Screen Recording', 1, current, signal)
    if (refusal) return refusal
    const shot = await backend.screenshot({
      display: parsed.value.display,
      maxWidth: parsed.value.maxWidth,
      signal,
    })
    if (shot.jpeg.byteLength > SCREENSHOT_LIMIT_BYTES) {
      return failed(
        `screenshot too large: ${shot.jpeg.byteLength} bytes, the limit is ${SCREENSHOT_LIMIT_BYTES}`,
      )
    }
    const size = jpegSize(shot.jpeg)
    if (size === undefined) return failed('the screenshot is not a JPEG image')
    latest = { display: shot.display, size }
    return ok({
      data: Buffer.from(shot.jpeg).toString('base64'),
      mimeType: 'image/jpeg',
      width: size.width,
      height: size.height,
      scale: shot.display.scale,
    })
  }

  async function input(
    input: unknown,
    current: Settings,
    signal: AbortSignal,
  ): Promise<CapabilityResult> {
    if (!current.options.allowInput) {
      return failed(
        'desktop.input is off: the desktop driver option allowInput is false (screenshots only)',
        'refused-by-policy',
      )
    }
    const count = actionCount(input)
    if (count > DESKTOP_MAX_ACTIONS) {
      return failed(
        `at most ${DESKTOP_MAX_ACTIONS} actions per batch, got ${count}`,
        'refused-by-policy',
      )
    }
    const parsed = parseInputActions(input)
    if (!parsed.ok) return failed(`invalid input: ${parsed.message}`)
    if (latest === undefined) {
      return failed('no screenshot yet: call desktop.screenshot before desktop.input')
    }
    const mapped: DesktopAction[] = []
    for (const action of parsed.value) {
      const point = toPoints(action, latest)
      if (!point.ok) return failed(point.message)
      mapped.push(point.value)
    }
    const refusal = await gate('Accessibility', mapped.length, current, signal)
    if (refusal) return refusal
    await backend.input(mapped, signal)
    return ok({ performed: mapped.length })
  }

  function mapError(error: unknown, signal: AbortSignal): CapabilityResult {
    if (signal.aborted) return failed('the call was cancelled', 'cancelled')
    if (error instanceof MissingPermissionError) {
      return failed(
        `missing permission: ${error.permission}. Grant it to the app that runs keith-node in System Settings > Privacy & Security > ${error.permission}.`,
        'refused-by-policy',
      )
    }
    return failed(error instanceof Error ? error.message : String(error))
  }

  return defineDriver({
    name: DRIVER_NAME,
    version: DRIVER_VERSION,
    capabilities: DESKTOP_CAPABILITIES,
    // desktop.input is announced only when the owner turned allowInput on at `driver add`.
    offered(raw: Readonly<Record<string, unknown>>) {
      const parsed = parseOptions(raw)
      const input = parsed.ok && parsed.value.allowInput
      return input
        ? DESKTOP_CAPABILITIES
        : DESKTOP_CAPABILITIES.filter((cap) => cap.id !== 'desktop.input')
    },
    start(ctx: DriverContext) {
      const parsed = settle(ctx.options)
      if (!parsed.ok) throw new TypeError(`invalid desktop options: ${parsed.message}`)
    },
    async invoke(call: CapabilityCall, ctx: DriverContext): Promise<CapabilityResult> {
      if (await Bun.file(join(ctx.workdir, '..', PAUSE_FILE)).exists()) {
        return failed(
          'desktop is paused: remove desktop.pause from the node folder to resume',
          'refused-by-policy',
        )
      }
      if (call.schemaVersion !== 1) {
        return failed(`${call.capability} schema version ${call.schemaVersion} is not handled`)
      }
      if (ctx.signal.aborted) return failed('the call was cancelled', 'cancelled')
      const current = settle(ctx.options)
      if (!current.ok) return failed(`invalid desktop options: ${current.message}`)
      try {
        switch (call.capability) {
          case 'desktop.info':
            return await info(call.input, current.value, ctx.signal)
          case 'desktop.screenshot':
            return await screenshot(call.input, current.value, ctx.signal)
          case 'desktop.input':
            return await input(call.input, current.value, ctx.signal)
          default:
            return failed(`unknown capability ${call.capability}`)
        }
      } catch (error) {
        return mapError(error, ctx.signal)
      }
    },
  })
}
