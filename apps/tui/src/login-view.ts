/**
 * The text of `keith login` (tui-design 5.13), as plain stdout: it fits a pipe and the scrollback,
 * so there is no Ink here. Same words and structure as the design: title, the approve command,
 * the spaced code, one status line.
 */
import type { LoginError } from '@keith/client'

/** `A B C D - E F G H`: spaced for legibility. */
export const spacedCode = (code: string): string => Array.from(code).join(' ')

const minutesLeft = (ms: number): number => Math.max(1, Math.round(ms / 60_000))

/** The waiting screen, printed once when the code arrives. */
export function loginWaiting({
  core,
  code,
  expiresAt,
  now,
}: {
  core: string
  code: string
  expiresAt: number
  now: number
}): string {
  const left = minutesLeft(expiresAt - now)
  return [
    '',
    `  keith login  ·  ${core}`,
    '',
    '  On the core machine, approve this device:',
    '',
    `    keith-core devices approve ${code} --label <name>`,
    '',
    `    ${spacedCode(code)}`,
    '',
    `  waiting for approval · expires in ${left} ${left === 1 ? 'minute' : 'minutes'} · esc to cancel`,
    '',
  ].join('\n')
}

/**
 * The next line of a login. A remembered login (`--remember`) is what the app signs in with; any other login is
 * for scripts and `keith whoami` only, and the app ignores it (docs/specs/client.md, "Remembered and saved logins").
 */
const nextStep = (remembered: boolean): string =>
  remembered
    ? 'Run keith to start.\n'
    : 'Saved for scripts and `keith whoami`; `keith login` without a flag keeps a login for the app.\n'

/** The result line of a login; `person` and `label` are known when `auth.whoami` answered. */
export function loginDone({
  core,
  person,
  label,
  remembered = false,
}: {
  core: string
  person?: string | undefined
  label?: string | undefined
  remembered?: boolean
}): string {
  const who = person === undefined ? '' : ` as ${person}`
  const device = label === undefined ? '' : ` (device "${label}")`
  return `✓ Logged in to ${core}${who}${device}.\n${nextStep(remembered)}`
}

/** The result line of a password login. */
export function passwordDone({
  core,
  username,
  role,
  remembered = false,
}: {
  core: string
  username: string
  role?: string | undefined
  remembered?: boolean
}): string {
  const tag = role === undefined ? '' : ` (${role})`
  return `✓ Logged in to ${core} as ${username}${tag}.\n${nextStep(remembered)}`
}

/** The words of a failed password login (the core never says whether the user or the password was wrong). */
export function passwordFailure(error: LoginError): string {
  switch (error.reason) {
    case 'invalid':
      return 'Wrong username or password.'
    case 'throttled':
      return error.retryAfter === undefined
        ? 'Too many attempts. Try again later.'
        : `Too many attempts. Try again in ${error.retryAfter} s.`
    case 'not_allowed_here':
      return 'Password login is only allowed from this machine, Tailscale, or tailscale serve. Use a device code instead.'
    case 'unavailable':
      return 'The core is busy. Try again in a moment.'
    case 'unreachable':
    case 'remember_unavailable':
      return error.message
  }
}

/** `✕ …` for a failed login. */
export const loginFailed = (message: string): string => `✕ ${message}`
