/** The fixed words and pure helpers of the Sign in screen (docs/specs/tui-login.md). */
/** Shown next to a secret on the `lan` zone, where the core speaks plain HTTP (ADR-0014 point 10). */
export const LAN_WARNING = 'plain HTTP on this network: others on it could read what you type'

/** `K T P W - 4 C 7 M`: spaced for legibility; the approve command carries the code unspaced. */
export const spacedCode = (code: string): string => Array.from(code).join(' ')

/** Whole seconds left until `at` (epoch ms), never negative. */
export const secondsLeft = (at: number, now: number): number =>
  Math.max(0, Math.ceil((at - now) / 1000))

/** `expires in 10 minutes`, `expires in 1 minute`, `expires in 42 s`, `expired`. */
export function expiresText(expiresAt: number, now: number): string {
  const s = secondsLeft(expiresAt, now)
  if (s === 0) return 'expired'
  if (s < 60) return `expires in ${s} s`
  const m = Math.ceil(s / 60)
  return `expires in ${m} ${m === 1 ? 'minute' : 'minutes'}`
}

/** `try again in 12 s`, or `you can try again now` once due. */
export function throttleText(retryAt: number, now: number): string {
  const s = secondsLeft(retryAt, now)
  return s === 0 ? 'you can try again now' : `try again in ${s} s`
}

/** The core's version line: `Keith 0.4.1`, or the bare name when `/health` gave none. */
export const versionLine = (version: string): string =>
  version === '' ? 'Keith' : `Keith ${version}`

/** The one-line opt-in to keep this sign-in on the device (30 days idle). */
export const REMEMBER_LABEL = 'remember for 30 days  (ctrl+r)'
