import { askHidden, CliError, type CliOutput, type Command, defineCommand } from '@keith/cli'
import { createKeithClient, LocalLockError, openLocalSession } from '@keith/client'
import { probeSocket, socketPathFor } from '../modules/local-socket/index.ts'
import { localSessionError } from './admin-session.ts'
import { type CliDeps, configOf, NOT_RUNNING, unixFetch } from './context.ts'

const errOut = (io: { stderr?: CliOutput; stdout: CliOutput }): CliOutput => io.stderr ?? io.stdout
const VAR = 'KEITH_ADMIN_SESSION'
const EVAL_HINT = (verb: string) => `run it as: eval "$(keith-core ${verb})"`

/**
 * `keith-core login` and `logout` (docs/specs/auth.md, "The admin session"): the only way to keep an admin
 * session between commands, and it never touches the disk. `login` asks the PIN (the prompt goes to the
 * terminal, not to stdout) and prints `export KEITH_ADMIN_SESSION=...` for the shell to `eval`; the
 * credential then lives in that shell's environment only (5 idle minutes on the core). `logout`
 * revokes it and prints `unset KEITH_ADMIN_SESSION`. With a terminal on stdout the token would land in the
 * scrollback, so both refuse and say how to run them.
 */
export function adminLoginCommands(deps: CliDeps): Command[] {
  return [
    defineCommand({
      name: 'login',
      summary: `Sign in for a few minutes in this shell: eval "$(keith-core login)"`,
      run: async (ctx) => {
        if (ctx.io.stdout.isTTY === true) throw new CliError(EVAL_HINT('login'))
        const config = configOf(deps)
        const path = socketPathFor(config.dataDir)
        if (!(await probeSocket(path))) throw new CliError(NOT_RUNNING)
        // the prompt must not land in what the shell evaluates
        const err = errOut(ctx.io)
        const promptIo = {
          ...ctx.io,
          stdout: err,
          isTTY: ctx.io.stdin.isTTY === true && err.isTTY === true,
        }
        const pin =
          deps.askPin === undefined
            ? await askHidden('Owner PIN', {
                io: promptIo,
                validate: (v) => (v === '' ? 'the PIN is empty' : undefined),
              })
            : await deps.askPin()
        try {
          const made = await openLocalSession({ fetch: unixFetch(path), pin })
          ctx.io.stdout.write(`export ${VAR}='${made.credential}'\n`)
          err.write('signed in for this shell: 5 idle minutes; `keith-core logout` ends it\n')
          return 0
        } catch (error) {
          if (error instanceof LocalLockError && error.reason === 'not_applicable') {
            err.write(
              'the local socket serves the owner without a session: nothing to sign in to\n',
            )
            return 0
          }
          throw localSessionError(error)
        }
      },
    }),
    defineCommand({
      name: 'logout',
      summary: `End this shell's admin session: eval "$(keith-core logout)"`,
      run: async (ctx) => {
        if (ctx.io.stdout.isTTY === true) throw new CliError(EVAL_HINT('logout'))
        const config = configOf(deps)
        const token = config.adminSession
        if (token !== undefined) {
          const path = socketPathFor(config.dataDir)
          if (await probeSocket(path)) {
            await createKeithClient({
              baseUrl: 'http://localhost',
              fetch: unixFetch(path),
              token,
            })
              .revokeSelf()
              .catch(() => undefined)
          }
        }
        ctx.io.stdout.write(`unset ${VAR}\n`)
        errOut(ctx.io).write(token === undefined ? `no ${VAR} in this shell\n` : 'signed out\n')
        return 0
      },
    }),
  ]
}
