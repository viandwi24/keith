// A fake desktop backend for tests: it records calls and returns what the test sets. It never touches
// a screen, a process or the OS.
import type { DesktopAction } from '../actions.ts'
import type {
  DesktopBackend,
  DesktopInfo,
  DisplayInfo,
  PermissionState,
  Screenshot,
} from '../backend.ts'

export const MAIN_DISPLAY: DisplayInfo = { id: 0, width: 1440, height: 900, scale: 2 }

/** A JPEG-shaped byte array: a valid frame header of the given size, padded to `bytes` long. */
export function fakeJpeg(width: number, height: number, bytes = 64): Uint8Array {
  const out = new Uint8Array(Math.max(bytes, 16))
  out.set([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
  ])
  return out
}

export interface FakeBackend extends DesktopBackend {
  readonly calls: string[]
  readonly inputs: (readonly DesktopAction[])[]
  permissionState: PermissionState
  displays: DisplayInfo[]
  /** The JPEG the next screenshot returns (1280x800 by default). */
  nextJpeg: Uint8Array
}

export function fakeBackend(
  overrides: Partial<Pick<FakeBackend, 'permissionState' | 'displays'>> = {},
): FakeBackend {
  const calls: string[] = []
  const inputs: (readonly DesktopAction[])[] = []
  const backend: FakeBackend = {
    calls,
    inputs,
    permissionState: overrides.permissionState ?? { screenRecording: true, accessibility: true },
    displays: overrides.displays ?? [MAIN_DISPLAY],
    nextJpeg: fakeJpeg(1280, 800),
    async permissions() {
      calls.push('permissions')
      return backend.permissionState
    },
    async info(): Promise<DesktopInfo> {
      calls.push('info')
      return { displays: backend.displays, frontApp: 'Notes' }
    },
    async screenshot({ display, maxWidth }): Promise<Screenshot> {
      calls.push(`screenshot:${display ?? 'main'}:${maxWidth}`)
      const found = backend.displays.find((candidate) => candidate.id === (display ?? 0))
      if (found === undefined) throw new Error(`no display ${display}`)
      return { display: found, jpeg: backend.nextJpeg }
    },
    async input(actions): Promise<void> {
      calls.push(`input:${actions.length}`)
      inputs.push(actions)
    },
  }
  return backend
}
