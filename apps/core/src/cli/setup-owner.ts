import { ask, askHidden, type CliIo, type CommandContext, confirm, UsageError } from '@keith/cli'
import type { OfflineAdmin } from '../modules/admin/index.ts'
import { checkPassword, checkPin, type Hasher } from '../modules/auth/index.ts'
import { PeopleError } from '../modules/people/index.ts'
import {
  currentOwnerUsername,
  ownerSignInKinds,
  ownerUsernameChecker,
  recordOwnerSignIn,
  saveOwnerPassword,
  saveOwnerPin,
  saveOwnerUsername,
} from './setup-steps.ts'

/** A secret typed twice (hidden) until both match and pass `rule`; one line from a pipe. */
async function twice(
  io: CliIo,
  label: string,
  rule: (v: string) => string | undefined,
  piped: boolean,
): Promise<string> {
  for (;;) {
    const first = await askHidden(label, {
      io,
      // a pipe cannot be asked again: the caller reports the refusal
      ...(piped ? {} : { validate: (v: string) => (v === '' ? 'a value is needed' : rule(v)) }),
    })
    if (piped) return first
    const again = await askHidden(`${label}, again`, { io })
    if (first === again) return first
    io.stdout.write('They differ. Try again.\n')
  }
}

/**
 * The username the owner signs in with. It is asked first, before anything else is saved, and the
 * prompt defaults to the current one (so Enter keeps it). A taken name or a bad one is a usage error
 * that changes nothing (FD10-03, ADR-0027 §24).
 */
export async function stepOwnerUsername(
  ctx: CommandContext,
  admin: OfflineAdmin,
  prompts: boolean,
): Promise<void> {
  const { io } = ctx
  const check = await ownerUsernameChecker(admin)
  let username = ctx.string('owner-username')
  if (username === undefined && prompts) {
    username = await ask('Username you sign in with', {
      default: currentOwnerUsername(admin),
      io,
      validate: check,
    })
  }
  if (username === undefined) return
  const problem = check(username)
  if (problem !== undefined)
    throw new UsageError(
      `${ctx.string('owner-username') === undefined ? 'username' : '--owner-username'}: ${problem}`,
    )
  try {
    await saveOwnerUsername(admin, username)
  } catch (error) {
    if (error instanceof PeopleError) throw new UsageError(error.message)
    throw error
  }
}

/**
 * The owner's way to sign in. Required: at least one of a PIN and a password must exist when this
 * returns. A secret comes from a hidden prompt (typed twice) or one stdin line (`--owner-pin-stdin`,
 * then `--owner-password-stdin`), never from argv. An owner who already has credentials keeps them
 * unless a flag or an answer asks to change them. Nothing secret is printed or audited.
 */
export async function stepOwnerSignIn(
  ctx: CommandContext,
  admin: OfflineAdmin,
  prompts: boolean,
  hasher: Hasher | undefined,
): Promise<string[]> {
  const { io } = ctx
  const had = ownerSignInKinds(admin)
  const wantPin = ctx.bool('owner-pin-stdin')
  const wantPassword = ctx.bool('owner-password-stdin')
  let change = wantPin || wantPassword
  if (!change && had.length > 0 && prompts)
    change = await confirm(`The owner already signs in with ${had.join(' and ')}. Change it?`, {
      default: false,
      io,
    })
  if (!change && had.length > 0) return had
  if (!change && !prompts)
    throw new UsageError(
      'the owner needs a way to sign in: pipe a PIN with --owner-pin-stdin (and/or a password with --owner-password-stdin)',
    )
  const piped = wantPin || wantPassword
  let pin: string | undefined
  let password: string | undefined
  if (piped) {
    if (wantPin) pin = await twice(io, 'Owner PIN', checkPin, true)
    if (wantPassword) {
      password = await twice(io, 'Owner password', (v) => checkPassword(v), true)
    }
  } else {
    pin = await twice(io, 'Owner PIN (6 to 12 digits, needed to sign in)', checkPin, false)
    const wish = await confirm(
      'Also set an owner password (typed to sign in from other devices)?',
      { default: false, io },
    )
    if (wish)
      password = await twice(
        io,
        'Owner password (15 characters or more)',
        (v) => checkPassword(v),
        false,
      )
  }
  if (pin !== undefined) {
    const problem = await saveOwnerPin(admin, pin, hasher)
    if (problem !== undefined) throw new UsageError(`the PIN was refused: ${problem}`)
  }
  if (password !== undefined) {
    const problem = await saveOwnerPassword(admin, password, hasher)
    if (problem !== undefined) throw new UsageError(`the password was refused: ${problem}`)
  }
  const kinds = ownerSignInKinds(admin)
  recordOwnerSignIn(admin, kinds)
  return kinds
}
