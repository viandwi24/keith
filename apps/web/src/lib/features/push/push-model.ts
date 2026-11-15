// "Notifications on this device" (docs/specs/web.md, "Push"): what this browser can do about Web Push, what the toggle does
// next, and how a stored device reads. Pure: the controller reads the platform and asks here.

export type PushPermission = 'default' | 'granted' | 'denied'

/** What the page can see of the platform. */
export interface PushPlatform {
  secureContext: boolean
  serviceWorker: boolean
  pushManager: boolean
  notification: boolean
  /** An iPhone or iPad (`navigator.platform` or the touch Mac that says `MacIntel`). */
  ios: boolean
  /** Running from the Home Screen (`display-mode: standalone` or `navigator.standalone`). */
  standalone: boolean
  permission: PushPermission
}

/**
 * Why push can or cannot be turned on here. `ready`: the browser asks (or already allowed). The others are a reason the page
 * shows, in the order a person fixes them: HTTPS first, then the Home Screen install on iOS, then browser support, then a block.
 */
export type PushAvailability = 'ready' | 'insecure' | 'needs-install' | 'unsupported' | 'blocked'

export function availabilityOf(p: PushPlatform): PushAvailability {
  if (!p.secureContext) return 'insecure'
  // iOS (16.4 and later) has Web Push only for an app added to the Home Screen; in Safari the API is missing
  if (p.ios && !p.standalone) return 'needs-install'
  if (!p.serviceWorker || !p.pushManager || !p.notification) return 'unsupported'
  if (p.permission === 'denied') return 'blocked'
  return 'ready'
}

/** The sentence under the toggle when push cannot be turned on. */
export const AVAILABILITY_TEXT: Record<Exclude<PushAvailability, 'ready'>, string> = {
  insecure:
    'Push needs a secure page: open Keith over HTTPS (for example with Tailscale serve), or on localhost.',
  'needs-install':
    'On iPhone and iPad, push works only for Keith added to the Home Screen (iOS 16.4 or later): Share, then Add to Home Screen, and open it from there.',
  unsupported: 'This browser does not support push notifications.',
  blocked:
    'Notifications are blocked for this site: allow them in the browser settings, then try again.',
}

export interface ToggleInput {
  availability: PushAvailability
  /** This browser holds a push subscription. */
  subscribed: boolean
  busy: boolean
}

/** What a click on the toggle does. Turning off is always possible; turning on only when `ready`. */
export function toggleStep(t: ToggleInput): 'subscribe' | 'unsubscribe' | 'none' {
  if (t.busy) return 'none'
  if (t.subscribed) return 'unsubscribe'
  return t.availability === 'ready' ? 'subscribe' : 'none'
}

/** The label of the toggle (menu item and page). */
export function toggleLabel(t: ToggleInput): string {
  if (t.busy) return 'Working…'
  if (t.subscribed) return 'Turn off notifications on this device'
  return t.availability === 'ready'
    ? 'Turn on notifications on this device'
    : 'Notifications are not available here'
}

/** Whether the control can be pressed. */
export const toggleEnabled = (t: ToggleInput): boolean => toggleStep(t) !== 'none'

/** The words of a failure of the subscribe steps, one sentence. */
export function failureText(error: unknown): string {
  const name = error instanceof Error ? error.name : ''
  if (name === 'NotAllowedError') return 'Notifications were not allowed.'
  if (name === 'AbortError' || name === 'NetworkError')
    return 'The browser could not reach its push service. Try again later.'
  if (name === 'InvalidStateError')
    return 'This browser has an older push subscription. Turn it off and on again.'
  const message = error instanceof Error ? error.message : String(error)
  return `Could not turn on notifications: ${message}`
}

export interface DeviceRecord {
  id: string
  clientId?: string | null | undefined
  label: string
  createdAt: number
  lastSuccessAt: number | null
  failures: number
}

export interface DeviceRow {
  id: string
  label: string
  /** The row of this browser. */
  here: boolean
  added: string
  /** `ok 5 min ago`, `no message yet`, or the failure count. */
  health: string
  /** A failing device is shown in a warning tone. */
  warn: boolean
}

const ago = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} days ago`
}

/** The rows of the device list, this browser first. */
export function deviceRowsOf(
  records: readonly DeviceRecord[],
  ownClientId: string | undefined,
  now: number,
): DeviceRow[] {
  const rows = records.map((r) => ({
    id: r.id,
    label: r.label === '' ? 'Unnamed browser' : r.label,
    here: ownClientId !== undefined && r.clientId === ownClientId,
    added: `added ${ago(now - r.createdAt)}`,
    health:
      r.failures > 0
        ? `${r.failures} failed ${r.failures === 1 ? 'send' : 'sends'} in a row`
        : r.lastSuccessAt === null
          ? 'no message yet'
          : `last message ${ago(now - r.lastSuccessAt)}`,
    warn: r.failures > 0,
  }))
  return [...rows.filter((r) => r.here), ...rows.filter((r) => !r.here)]
}

export const PREVIEW_NOTE =
  'Off: a notification says only that Keith has something for you. On: it shows the start of the message, which anyone who sees your lock screen can read. Either way the push service sees nothing but encrypted data.'
