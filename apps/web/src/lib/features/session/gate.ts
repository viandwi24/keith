import { isUnauthorized } from './unauthorized.ts'

export type SessionStatus = 'loading' | 'signed-in' | 'signed-out' | 'error'

/** What the session gate does with a route: wait, show it, or move the person. */
export type GateAction = 'wait' | 'stay' | 'to-login' | 'to-app'

/** The sign-in screen is for the signed out; every other route is for the signed in. An error keeps the person where they are. */
export function gateAction(status: SessionStatus, onLogin: boolean): GateAction {
  if (status === 'loading') return 'wait'
  if (status === 'signed-out') return onLogin ? 'stay' : 'to-login'
  if (status === 'signed-in') return onLogin ? 'to-app' : 'stay'
  return 'stay'
}

/** The status a failed whoami means: a refused credential is signed out; anything else is an error to retry. */
export const statusOfFailure = (error: unknown): SessionStatus =>
  isUnauthorized(error) ? 'signed-out' : 'error'

/** The guest chat page (`/app/guest`): it has no sign-in, and on the guest listener there is no owner API to ask. */
export const isGuestPath = (base: string, pathname: string): boolean =>
  pathname === `${base}/guest` || pathname === `${base}/guest/`
