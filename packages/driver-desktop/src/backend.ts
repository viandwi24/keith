// The seam between the desktop driver and the OS (docs/specs/node-drivers.md, "Driver desktop").
// The driver never touches the OS itself: a backend does. The macOS backend is the only real one;
// tests use a fake backend that never reaches a screen.
import type { DesktopAction } from './actions.ts'

export type DesktopPermission = 'Screen Recording' | 'Accessibility'

export interface DisplayInfo {
  /** The 0-based display index from `desktop.info`; the `display` a screenshot call names. */
  readonly id: number
  /** Size in points: the coordinate space of input events. */
  readonly width: number
  readonly height: number
  /** Physical pixels per point (2 on a Retina display). */
  readonly scale: number
}

export interface DesktopInfo {
  readonly displays: readonly DisplayInfo[]
  readonly frontApp?: string
}

export interface PermissionState {
  readonly screenRecording: boolean
  readonly accessibility: boolean
}

export interface ScreenshotRequest {
  readonly display?: number
  /** Longest side allowed for the JPEG, in pixels. */
  readonly maxWidth: number
  readonly signal: AbortSignal
}

export interface Screenshot {
  readonly display: DisplayInfo
  /** A JPEG no wider than the request's `maxWidth`. */
  readonly jpeg: Uint8Array
}

export interface DesktopBackend {
  permissions(signal: AbortSignal): Promise<PermissionState>
  info(signal: AbortSignal): Promise<DesktopInfo>
  screenshot(request: ScreenshotRequest): Promise<Screenshot>
  /** Runs the actions in order. Coordinates are already in points. */
  input(actions: readonly DesktopAction[], signal: AbortSignal): Promise<void>
}

/** Thrown by a backend when the OS refuses an action because a permission is not granted. */
export class MissingPermissionError extends Error {
  readonly permission: DesktopPermission

  constructor(permission: DesktopPermission) {
    super(`missing permission: ${permission}`)
    this.name = 'MissingPermissionError'
    this.permission = permission
  }
}
