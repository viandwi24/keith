import { KEITH_STEP_UP_REQUIRED, StepUpError } from '@keith/client/browser'

/** The `code` of the refusal when a member answers an item the owner answers (amygdala.md). */
export const KEITH_WAITING_FOR_OWNER = 'KEITH_WAITING_FOR_OWNER'

export const WAITING_TEXT = 'Waiting for the owner to approve'

export const LEGACY_TEXT =
  'This login is an old token. On the core machine run `keith-core token create`, then `keith login --token`.'

const codeOf = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** The core refused a call until the person steps up (oRPC error or attention answer). */
export const isStepUpRequired = (error: unknown): boolean =>
  codeOf(error) === KEITH_STEP_UP_REQUIRED

/** A member tried to answer an item that waits for the owner. */
export const isWaitingForOwnerError = (error: unknown): boolean =>
  codeOf(error) === KEITH_WAITING_FOR_OWNER

/** The refusal says the credential is a legacy token (it can never step up). */
export const isLegacyRefusal = (error: unknown): boolean =>
  error instanceof Error && /legacy token/i.test(error.message)

/** The step-up prompt was dismissed (esc); the original action did not run again. */
export class StepUpCancelled extends Error {
  constructor() {
    super('Not confirmed.')
    this.name = 'StepUpCancelled'
  }
}

/** The text of a failed step-up, for the danger row of the prompt. */
export function stepUpFailure(error: unknown): string {
  if (error instanceof StepUpError) {
    switch (error.reason) {
      case 'invalid':
        return 'Wrong PIN or password.'
      case 'throttled':
        return error.retryAfter === undefined
          ? 'Too many attempts. Try again later.'
          : `Too many attempts. Try again in ${error.retryAfter} s.`
      case 'no_method':
        return `No PIN or password is set. On the core machine: ${error.hint ?? 'keith-core people pin <username>'}`
      case 'legacy_credential':
        return LEGACY_TEXT
      case 'not_allowed_here':
        return 'Confirming is not allowed from this network.'
      case 'unauthorized':
        return 'This login is no longer valid. Sign in again with `/login`.'
      case 'pin_session':
        return `A${error.message.slice(1)}`
      case 'unavailable':
        return 'The core is busy. Try again in a moment.'
      case 'unreachable':
        return 'Cannot reach the core.'
    }
  }
  return error instanceof Error ? error.message : String(error)
}

/** Whether a failed step-up leaves nothing to retype (the prompt then only offers esc). */
export const isDeadEnd = (error: unknown): boolean =>
  error instanceof StepUpError &&
  (error.reason === 'no_method' || error.reason === 'legacy_credential')

/** `9:41` for the milliseconds left (never negative). */
export function remaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
