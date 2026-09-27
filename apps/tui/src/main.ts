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
import { mountChat } from './ui.ts'

export const CLIENT_INFO = { name: 'keith-tui', version: '0.0.0' }

export const USAGE = `usage: keith-tui [--url http://127.0.0.1:${DEFAULT_PORT}]

  --url <url>   core address (default: the last used one, else http://127.0.0.1:${DEFAULT_PORT})
  --help        show this help`

export type CliArgs = { url: string | undefined; help: boolean }

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { url: undefined, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--url') {
      const value = argv[i + 1]
      if (value === undefined) throw new TuiError('INVALID_ARGS', '--url needs a value')
      args.url = value
      i++
    } else if (arg.startsWith('--url=')) args.url = arg.slice('--url='.length)
    else throw new TuiError('INVALID_ARGS', `unknown argument '${arg}'`)
  }
  return args
}

/** Runs the TUI. Returns the process exit code. */
export async function main(argv: readonly string[], env: Env): Promise<number> {
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

  const renderer = await createCliRenderer({ exitOnCtrlC: false })
  try {
    let session = await auth.restore()
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
      quit: () => finish('quit'),
    })
    client.start()
  })
}
