/** Every fixed text the thin client prints, in one place. Commands go in backticks (drawn in accent). */

export const NO_CORE =
  'No core found. On the core machine run `keith-core start`; from another device run `keith login --core <url>`.'

/** The logged-out sentence of the plain commands (`keith whoami`). */
export const LOGGED_OUT = 'Logged out or revoked. Run `keith login`.'

/** The same on the local socket whose owner needs a session (`local trust: none`): sign in from the app. */
export const SOCKET_LOGGED_OUT =
  'The local socket needs a session (local trust: none). Run `keith` and sign in with your PIN.'

/** The logged-out block of the TUI (three rows). */
export const LOGGED_OUT_ROWS = (): string[] => [
  'This device is logged out or its credential was revoked.',
  'Press `enter` to sign in.',
  'Keith reconnects by itself after the login.',
]

/** The block when the core cannot be reached (at start, or over the local socket). */
export const CORE_DOWN_ROWS = (target: string, detail?: string): string[] => [
  `Cannot reach the core at ${target}.`,
  ...(detail === undefined || detail === '' ? [] : [detail]),
]

/** Commands that moved to `keith-core`: typing one in the TUI shows the matching rows. */
export const MOVED: Record<string, string[]> = {
  connect: ['Providers are set on the core machine:', '`keith-core provider add <id>`'],
  providers: ['Providers are set on the core machine:', '`keith-core provider list`'],
  model: ['Models are set on the core machine:', '`keith-core model set front <id>`'],
  pair: ['Nodes are paired on the core machine:', '`keith-core pair`'],
}

export const BUDGET_MOVED = [
  'The monthly limit is set on the core machine:',
  '`keith-core budget set <usd|none>`',
]

/** What a member sees where the owner is told to use `keith-core`. */
export const ASK_OWNER = ['This is set on the core machine.', 'Ask the owner.']
