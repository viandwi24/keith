import { DEFAULT_PORT } from '@keith/protocol'
import { type CliRenderer, createCliRenderer } from '@opentui/core'
import { login, normalizeBaseUrl } from './api.ts'
import { createChatClient } from './client.ts'
import { type Env, loadSession, type StoredSession, saveSession, sessionFilePath } from './config.ts'
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

  const path = sessionFilePath(env)
  const stored = await loadSession(path)
  const baseUrl = normalizeBaseUrl(args.url ?? stored?.url ?? `http://127.0.0.1:${DEFAULT_PORT}`)
  const sameServer = stored?.url === baseUrl ? stored : null

  const renderer = await createCliRenderer({ exitOnCtrlC: false })
  try {
    let session: StoredSession | null = sameServer && sameServer.expiresAt > Date.now() ? sameServer : null
    let nodeId = sameServer?.nodeId
    let message: string | undefined
    for (;;) {
      if (!session) {
        session = await signIn(renderer, { baseUrl, path, nodeId, message, username: undefined })
        if (!session) return 0
      }
      const outcome = await runChat(renderer, session, path)
      if (outcome === 'quit') return 0
      nodeId = session.nodeId
      session = null
      message = 'Your session was rejected by the core. Sign in again.'
    }
  } finally {
    renderer.destroy()
  }
}

async function signIn(
  renderer: CliRenderer,
  opts: {
    baseUrl: string
    path: string
    nodeId: StoredSession['nodeId']
    message: string | undefined
    username: string | undefined
  },
): Promise<StoredSession | null> {
  let message = opts.message
  let username = opts.username
  for (;;) {
    const creds = await promptLogin(renderer, { url: opts.baseUrl, username, message })
    if (!creds) return null
    try {
      const res = await login(opts.baseUrl, creds)
      const session: StoredSession = {
        url: opts.baseUrl,
        token: res.token,
        person: res.person,
        expiresAt: res.expiresAt,
        ...(opts.nodeId ? { nodeId: opts.nodeId } : {}),
      }
      await saveSession(opts.path, session)
      return session
    } catch (error) {
      if (!(error instanceof TuiError)) throw error
      message = error.message
      username = creds.username
    }
  }
}

function runChat(
  renderer: CliRenderer,
  session: StoredSession,
  path: string,
): Promise<'quit' | 'auth-required'> {
  return new Promise((resolve) => {
    let current = session
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
        current = { ...current, nodeId }
        saveSession(path, current).catch((error: unknown) => {
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
