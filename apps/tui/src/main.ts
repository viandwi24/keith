import {
  type Auth,
  ClientError,
  createAuth,
  createChatClient,
  normalizeBaseUrl,
  type StoredSession,
} from '@keith/client'
import { DEFAULT_PORT } from '@keith/protocol'
import { type CliRenderer, createCliRenderer } from '@opentui/core'
import { type Env, fileSessionStore, sessionFilePath } from './config.ts'
import { TuiError } from './errors.ts'
import { promptLogin } from './login-screen.ts'
import { logoutCommand } from './logout.ts'
import { mountChat } from './ui.ts'

export const CLIENT_INFO = { name: 'keith-tui', version: '0.0.0' }

export const USAGE = `usage: keith-tui [--url http://127.0.0.1:${DEFAULT_PORT}] [--invite <code>] | --logout

  --url <url>       core address (default: the last used one, else http://127.0.0.1:${DEFAULT_PORT})
  --invite <code>   sign up with the invite code from \`keith person add\` (choose a username and a password)
  --logout          sign out: revoke the stored token on its core and delete it locally
  --help            show this help

In the chat: /threads lists your threads, /open <n> switches to one.`

export type CliArgs = { url: string | undefined; invite: string | undefined; help: boolean; logout: boolean }

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { url: undefined, invite: undefined, help: false, logout: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--logout') args.logout = true
    else if (arg === '--url' || arg === '--invite') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--'))
        throw new TuiError('INVALID_ARGS', `${arg} needs a value`)
      if (arg === '--url') args.url = value
      else args.invite = value
      i++
    } else if (arg.startsWith('--url=')) args.url = arg.slice('--url='.length)
    else if (arg.startsWith('--invite=')) {
      const value = arg.slice('--invite='.length)
      if (value === '') throw new TuiError('INVALID_ARGS', '--invite needs a value')
      args.invite = value
    } else throw new TuiError('INVALID_ARGS', `unknown argument '${arg}'`)
  }
  if (args.invite !== undefined && args.logout) {
    throw new TuiError('INVALID_ARGS', '--invite and --logout cannot be combined')
  }
  return args
}

export type MainDeps = {
  /** Creates the terminal renderer. Tests pass OpenTUI's test renderer. */
  createRenderer?: (() => Promise<CliRenderer>) | undefined
}

/** Runs the TUI. Returns the process exit code. */
export async function main(argv: readonly string[], env: Env, deps: MainDeps = {}): Promise<number> {
  let args: CliArgs
  try {
    args = parseArgs(argv)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error(USAGE)
    return 2
  }
  if (args.help) {
    console.log(USAGE)
    return 0
  }

  const store = fileSessionStore(sessionFilePath(env))
  // The stored token belongs to the core it was issued by, so `--url` doesn't matter here.
  if (args.logout) return logoutCommand(store)
  const stored = await store.load()
  let baseUrl: string
  try {
    baseUrl = normalizeBaseUrl(args.url ?? stored?.url ?? `http://127.0.0.1:${DEFAULT_PORT}`)
  } catch (error) {
    if (!(error instanceof ClientError)) throw error
    console.error(error.message)
    return 2
  }
  // The stored session is reused only for the same core and while it has not expired.
  const auth = createAuth({ baseUrl, store })

  const renderer = await (deps.createRenderer ?? (() => createCliRenderer({ exitOnCtrlC: false })))()
  let failure: string | undefined
  try {
    // `--invite`: sign up first (a stored session is replaced), then chat like after a login.
    let session: StoredSession | null
    try {
      session = args.invite !== undefined ? await signUp(renderer, auth, args.invite) : await auth.restore()
    } catch (error) {
      if (!(error instanceof ClientError) || error.code !== 'INVITE_INVALID') throw error
      failure = error.message
      return 1
    }
    if (args.invite !== undefined && !session) return 0
    let message: string | undefined
    for (;;) {
      if (!session) {
        session = await signIn(renderer, auth, message)
        if (!session) return 0
      }
      const outcome = await runChat(renderer, session, auth)
      if (outcome === 'quit') return 0
      // Keeps the node id for the next login.
      await auth.expire()
      session = null
      message = 'Your session was rejected by the core. Sign in again.'
    }
  } finally {
    renderer.destroy()
    // Printed once the terminal is restored, so it stays on screen.
    if (failure !== undefined) console.error(failure)
  }
}

/**
 * Phase 5: the sign-up form for `--invite`. A refused username (or any other error but an invalid
 * code) shows the core's message and asks again. An invalid code throws `INVITE_INVALID`, which
 * ends the TUI with exit code 1. Null when the user quits.
 */
async function signUp(renderer: CliRenderer, auth: Auth, code: string): Promise<StoredSession | null> {
  let message: string | undefined
  let username: string | undefined
  for (;;) {
    const creds = await promptLogin(renderer, { url: auth.baseUrl, username, message, signUp: true })
    if (!creds) return null
    try {
      return await auth.acceptInvite({ code, ...creds })
    } catch (error) {
      if (!(error instanceof ClientError) || error.code === 'INVITE_INVALID') throw error
      message = error.message
      username = creds.username
    }
  }
}

async function signIn(
  renderer: CliRenderer,
  auth: Auth,
  firstMessage: string | undefined,
): Promise<StoredSession | null> {
  let message = firstMessage
  let username: string | undefined
  for (;;) {
    const creds = await promptLogin(renderer, { url: auth.baseUrl, username, message })
    if (!creds) return null
    try {
      return await auth.login(creds)
    } catch (error) {
      if (!(error instanceof ClientError)) throw error
      message = error.message
      username = creds.username
    }
  }
}

function runChat(
  renderer: CliRenderer,
  session: StoredSession,
  auth: Auth,
): Promise<'quit' | 'auth-required'> {
  return new Promise((resolve) => {
    let done = false
    const finish = (outcome: 'quit' | 'auth-required') => {
      if (done) return
      done = true
      client.close()
      screen.destroy()
      resolve(outcome)
    }
    const client = createChatClient({
      baseUrl: session.url,
      token: session.token,
      nodeId: session.nodeId,
      client: CLIENT_INFO,
      onState: (state) => {
        if (done) return
        if (state.connection.kind === 'auth-required') {
          finish('auth-required')
          return
        }
        screen.update(state)
      },
      onNodeId: (nodeId) => {
        auth.rememberNodeId(nodeId).catch((error: unknown) => {
          console.error('cannot save the node id', error)
        })
      },
    })
    const screen = mountChat(renderer, {
      send: (text) => client.send(text),
      cancel: () => client.cancel(),
      loadOlder: () => {
        // Failures become a notice in the log (`ChatClient.loadOlder`).
        void client.loadOlder()
      },
      openThread: (threadId) => client.openThread(threadId),
      quit: () => finish('quit'),
    })
    client.start()
  })
}
