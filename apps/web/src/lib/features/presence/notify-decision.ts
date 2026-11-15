// What a `notify` delivery does in the browser, and the opt-in for desktop notifications. Pure: the page reads the visibility and the
// permission and acts on the answer.

export type NotifyPermission = 'default' | 'granted' | 'denied' | 'unsupported'

export interface NotifyInput {
  /** The text the core sent, when it sent one. */
  text?: string | undefined
  /** The name of the delivery (used when there is no text). */
  name: string
  /** The tab is in the background or minimised. */
  hidden: boolean
  permission: NotifyPermission
  /** The person turned desktop notifications on in the avatar menu. */
  optedIn: boolean
}

export interface NotifyDecision {
  /** Always: a toast (the person sees it when they come back to the tab). */
  toast: string
  /** A system notification, only when the tab is hidden, the person opted in and the browser allows it. */
  system: { title: string; body: string } | undefined
}

const MAX = 200

export function decideNotify(input: NotifyInput): NotifyDecision {
  const text = (input.text ?? '').trim() || input.name.trim() || 'Keith has something for you'
  const body = text.length > MAX ? `${text.slice(0, MAX - 1)}…` : text
  const system =
    input.hidden && input.optedIn && input.permission === 'granted'
      ? { title: 'Keith', body }
      : undefined
  return { toast: body, system }
}

/** The label of the menu and palette item that turns desktop notifications on or off. */
export function notificationsLabel(optedIn: boolean, permission: NotifyPermission): string {
  if (permission === 'unsupported') return 'Desktop notifications are not available here'
  if (permission === 'denied') return 'Desktop notifications are blocked in the browser'
  return optedIn && permission === 'granted'
    ? 'Turn off desktop notifications'
    : 'Turn on desktop notifications'
}

/** Whether the toggle can do anything (a blocked or unsupported browser cannot be asked again by a page). */
export const canToggle = (permission: NotifyPermission): boolean =>
  permission === 'default' || permission === 'granted'

export const NOTIFY_KEY = 'keith.notify'

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const platform = (): StorageLike | undefined => {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

export function readOptIn(storage: StorageLike | undefined = platform()): boolean {
  try {
    return storage?.getItem(NOTIFY_KEY) === 'on'
  } catch {
    return false
  }
}

export function writeOptIn(on: boolean, storage: StorageLike | undefined = platform()): void {
  try {
    if (on) storage?.setItem(NOTIFY_KEY, 'on')
    else storage?.removeItem(NOTIFY_KEY)
  } catch {
    // the choice then lasts until the tab closes
  }
}

/** The page a delivered `open.view` name leads to (a path under the app base), or undefined for a view this client cannot open. */
export function viewPath(name: string): string | undefined {
  if (name === 'tasks') return '/tasks'
  if (name === 'protocols') return '/manage'
  const room = /^room:([^\s:]+)$/.exec(name)
  if (room !== null) return `/rooms/${encodeURIComponent(room[1] ?? '')}`
  // a plugin view: `plugin:<id>:<view>` is the view `<id>.<view>` of the Apps menu
  const plugin = /^plugin:([a-z0-9_-]+):([a-z0-9_-]+)$/.exec(name)
  if (plugin !== null) return `/apps/${plugin[1]}/${plugin[2]}`
  return undefined
}

/** Touches (user input) are reported at most this often. */
export const TOUCH_GAP_MS = 1000

export const shouldTouch = (last: number, now: number, gap = TOUCH_GAP_MS): boolean =>
  now - last >= gap
