import { askHidden, CliError, type Command, defineCommand } from '@keith/cli'
import {
  isLockedError,
  LocalLockError,
  localSocketPath,
  lockLocal,
  probeSocket,
  socketFetch,
  unlockLocal,
} from '@keith/client'

export interface LockDeps {
  /** The default core's data dir, whose socket these commands talk to. */
  dataDir: string
  /** Does something answer on this socket? (tests inject one) */
  probe?: (path: string) => Promise<boolean>
  /** A socket path to use instead of the data dir's (tests). */
  socketPath?: string
}

const NOT_LOCAL = 'No core answers on the local socket. On the core machine run `keith-core start`.'

async function socketOf(deps: LockDeps): Promise<string> {
  const path = deps.socketPath ?? localSocketPath(deps.dataDir)
  if (!(await (deps.probe ?? probeSocket)(path))) throw new CliError(NOT_LOCAL)
  return path
}

function failure(error: unknown): CliError {
  if (error instanceof LocalLockError) {
    if (error.reason === 'no_pin')
      return new CliError(
        `${error.message}. Set one with \`keith-core people pin <you>\`, then lock again.`,
      )
    if (error.reason === 'not_applicable' || error.reason === 'unauthorized')
      return new CliError(
        'The local socket needs a session (local trust: none): there is no implicit owner to lock.',
      )
    if (error.reason === 'invalid') return new CliError('Wrong PIN.')
    if (error.reason === 'throttled')
      return new CliError(`Too many attempts: wait ${error.retryAfter ?? 'a few'} s and try again.`)
    return new CliError(error.message)
  }
  if (isLockedError(error)) return new CliError('The socket is already locked: `keith unlock`.')
  return error instanceof CliError ? error : new CliError(String(error))
}

/**
 * `keith lock` and `keith unlock` (docs/specs/cli.md, "The local socket lock"): talk to the core on
 * this machine through its Unix socket. `lock` needs the socket open; `unlock` asks for the owner's PIN.
 */
export function lockCommands(deps: LockDeps): Command[] {
  return [
    defineCommand({
      name: 'lock',
      summary: 'Lock the local socket now: everything on this machine needs the PIN again',
      run: async (ctx) => {
        const path = await socketOf(deps)
        try {
          await lockLocal({ fetch: socketFetch(path) })
        } catch (error) {
          throw failure(error)
        }
        ctx.io.stdout.write('Locked. `keith unlock` (or `keith`) asks for your PIN.\n')
        return 0
      },
    }),
    defineCommand({
      name: 'unlock',
      summary: 'Unlock the local socket with your PIN',
      run: async (ctx) => {
        const path = await socketOf(deps)
        const pin = await askHidden('PIN', {
          io: ctx.io,
          validate: (v) => (v === '' ? 'the PIN is empty' : undefined),
        })
        try {
          await unlockLocal({ fetch: socketFetch(path), pin })
        } catch (error) {
          throw failure(error)
        }
        ctx.io.stdout.write('Unlocked.\n')
        return 0
      },
    }),
  ]
}
