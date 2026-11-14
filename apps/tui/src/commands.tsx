import { hostname } from 'node:os'
import {
  ask,
  askHidden,
  CliError,
  type CliIo,
  type Command,
  type CommandContext,
  defineCommand,
  isInteractive,
  select,
  UsageError,
} from '@keith/cli'
import {
  type ClientConfig,
  DEFAULT_CORE,
  DeviceLoginError,
  defaultConfigPath,
  deviceLogin,
  type KeithClient,
  LoginError,
  passwordLogin,
  readClientConfig,
} from '@keith/client'
import {
  type Connection,
  CoreFlagError,
  clientFor,
  coreLabel,
  parseCoreFlag,
  resolveConnection,
} from './connection.ts'
import { GuestUrlError, guestUrlOf } from './guest-url.ts'
import { lockCommands } from './lock-commands.ts'
import {
  loginDone,
  loginFailed,
  loginWaiting,
  passwordDone,
  passwordFailure,
} from './login-view.ts'
import { LOGGED_OUT, NO_CORE, SOCKET_LOGGED_OUT } from './messages.ts'
import { replaceClientConfig, signOut } from './sign-out.ts'
import { isUnauthorized } from './unauthorized.ts'

export interface KeithDeps {
  /** `client.json` path (`undefined`: the client's default). */
  configPath: string | undefined
  /** The default core's data dir. */
  dataDir: string
  /** Open the chat screen on a connection; returns when the user quits. */
  startChat(connection: Connection): Promise<number | undefined>
  /** Open the Home screen (`keith`); without it `keith` opens the chat. */
  startHome?(connection: Connection): Promise<number | undefined>
  /** Open the Manage screen on a connection (`keith manage`); returns when the user quits. */
  startManage?(connection: Connection): Promise<number | undefined>
  /**
   * Open the app on the Sign in screen (`keith login` on a terminal with no flag). Without it
   * `keith login` stays the text command in every case (tests, a host with no screen).
   */
  startLogin?(connection: Connection): Promise<number | undefined>
  /**
   * Open the guest chat on a guest listener URL (`keith --guest`); returns when the visitor leaves. Default: the full-screen
   * guest app (`guest-main.tsx`, loaded only when asked). Tests inject their own.
   */
  startGuest?(url: string): Promise<number | undefined>
  /** Cancels a waiting device login (Ctrl+C / SIGTERM of the process). */
  signal?: AbortSignal
  /** Test hooks. */
  fetch?: typeof fetch
  pollMs?: number
  probe?: (path: string) => Promise<boolean>
}

const coreFlag = {
  type: 'string',
  placeholder: 'url',
  description:
    'core to use: an http(s) URL or unix:<path> (default: a remembered login in client.json, else the local socket)',
} as const

const disableOrbFlag = {
  type: 'boolean',
  description:
    'the orb does not move: one still frame, only its colour follows the state (no waves, no flight between Home and the chat)',
} as const

/**
 * `--disable-orb` reaches the app as `KEITH_DISABLE_ORB`: the TUI reads every setting in `platform/config.ts`,
 * and the app reads that config when it draws, after this command ran.
 */
function applyDisableOrb(ctx: CommandContext): void {
  if (ctx.bool('disable-orb')) process.env.KEITH_DISABLE_ORB = '1'
}

/** Esc or Ctrl+C on a terminal aborts; returns the function that stops listening and restores the tty. */
function watchCancel(io: CliIo, controller: AbortController): () => void {
  const stdin = io.stdin
  if (stdin.isTTY !== true || stdin.setRawMode === undefined) return () => {}
  const onData = (chunk: Buffer | string): void => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    if (text === '\u001b' || text.includes('\u0003')) controller.abort()
  }
  stdin.setRawMode(true)
  stdin.resume()
  stdin.on('data', onData)
  return () => {
    stdin.off('data', onData)
    stdin.setRawMode?.(false)
    stdin.pause()
  }
}

interface PersonInfo {
  name: string
  username: string | null
  role: string
}

/** Who the new credential is (`auth.whoami`), or `undefined` when the core does not say within 3 s. */
async function whoOf(core: string, token: string): Promise<PersonInfo | undefined> {
  const client = clientFor({ kind: 'http', url: core, token, source: 'file' })
  const answer = client.rpc.auth.whoami().then(
    (me): PersonInfo => ({ name: me.name, username: me.username, role: me.role }),
    () => undefined,
  )
  const timeout = new Promise<PersonInfo | undefined>((resolve) =>
    setTimeout(() => resolve(undefined), 3000),
  )
  return Promise.race([answer, timeout])
}

type TokenCheck =
  | { kind: 'ok'; person: PersonInfo }
  | { kind: 'rejected' }
  | { kind: 'unreachable' }

/** Ask the core who a pasted credential is: a 401 is a refusal, no answer within 3 s is an unreachable core. */
async function checkToken(core: string, token: string): Promise<TokenCheck> {
  const client = clientFor({ kind: 'http', url: core, token, source: 'file' })
  const answer = client.rpc.auth.whoami().then(
    (me): TokenCheck => ({
      kind: 'ok',
      person: { name: me.name, username: me.username, role: me.role },
    }),
    (error): TokenCheck => (isUnauthorized(error) ? { kind: 'rejected' } : { kind: 'unreachable' }),
  )
  const timeout = new Promise<TokenCheck>((resolve) =>
    setTimeout(() => resolve({ kind: 'unreachable' }), 3000),
  )
  return Promise.race([answer, timeout])
}

/** Every flag that asks for the text command: a method, a secret source, or a device name. */
const TEXT_FLAGS = ['token', 'password', 'password-stdin', 'device', 'remember'] as const

/**
 * Does `keith login` open the Sign in screen of the app instead of the text command? Only on a
 * terminal (stdin and stdout are TTYs) and with no flag that picks a method, a secret source or a
 * device name (`--token`, `--password`, `--password-stdin`, `--username`, `--device`, `--label`):
 * those mean the user (or a script) asked for the text flow. `--core` alone is fine: it prefills the
 * address. Piped stdin or stdout is never a terminal, so scripts keep the text command.
 */
export function opensSignInScreen(
  ctx: CommandContext,
  deps: Pick<KeithDeps, 'startLogin'>,
): boolean {
  if (deps.startLogin === undefined || !isInteractive(ctx.io)) return false
  if (TEXT_FLAGS.some((flag) => ctx.bool(flag))) return false
  return ctx.string('username') === undefined && ctx.string('label') === undefined
}

/** The connection to the address the user named, else the stored one, else the default (signed out). */
async function storedCoreConnection(ctx: CommandContext, deps: KeithDeps): Promise<Connection> {
  const flag = ctx.string('core')
  if (flag !== undefined && parseCoreFlagOrUsage(flag).kind === 'unix')
    throw new UsageError('login needs an http(s) URL; the local socket needs no login')
  const stored = readClientConfig(...(deps.configPath === undefined ? [] : [deps.configPath]))
  const connection = await resolveConnection({
    core: flag ?? stored?.core ?? DEFAULT_CORE,
    configPath: deps.configPath,
    dataDir: deps.dataDir,
    interactive: true,
  })
  if (connection === undefined) throw new CliError(NO_CORE)
  return connection
}

/** The Sign in screen of the app, on the address the user named, else the stored one, else the default. */
async function loginScreen(ctx: CommandContext, deps: KeithDeps): Promise<number> {
  if (deps.startLogin === undefined) throw new CliError(NO_CORE)
  return (await deps.startLogin(await storedCoreConnection(ctx, deps))) ?? 0
}

async function login(ctx: CommandContext, deps: KeithDeps): Promise<number> {
  if (opensSignInScreen(ctx, deps)) return loginScreen(ctx, deps)
  const raw = ctx.string('core') ?? DEFAULT_CORE
  const parsed = parseCoreFlagOrUsage(raw)
  if (parsed.kind === 'unix')
    throw new UsageError('login needs an http(s) URL; the local socket needs no login')
  const core = parsed.url
  const write = async (token: string, label?: string): Promise<void> => {
    await saveLogin(ctx, deps, { core, token })
    const person = await whoOf(core, token)
    ctx.io.stdout.write(loginDone({ core, person: person?.name, label }))
  }
  const methods = [ctx.bool('token'), ctx.bool('password'), ctx.bool('device')].filter(Boolean)
  const passwordFlags =
    ctx.bool('password') || ctx.bool('password-stdin') || ctx.string('username') !== undefined
  if (methods.length > 1 || (ctx.bool('token') && passwordFlags))
    throw new UsageError('choose one of --password, --device and --token')
  if (ctx.bool('device') && passwordFlags)
    throw new UsageError('choose one of --password, --device and --token')
  const method: 'token' | 'password' | 'device' = ctx.bool('token')
    ? 'token'
    : passwordFlags
      ? 'password'
      : ctx.bool('device') || !isInteractive(ctx.io)
        ? 'device'
        : await select(
            'How do you want to log in?',
            [
              { value: 'password', label: 'Password', hint: 'username and password' },
              { value: 'device', label: 'Device code', hint: 'approve on the core machine' },
            ],
            { io: ctx.io, default: 'password' },
          )
  // only a password sign-in can be remembered: the core gives the 30 days to a form answer (client.md)
  if (ctx.bool('remember') && method !== 'password')
    throw new UsageError(
      '--remember keeps a password sign-in for 30 days; a device code and a pasted token cannot be remembered: use --password --remember',
    )
  if (method === 'password') return passwordFlow(ctx, deps, core, write)
  if (method === 'token') {
    const token = await askHidden('Token', {
      io: ctx.io,
      validate: (v) => (v === '' ? 'the token is empty' : undefined),
    })
    // a credential is checked before it replaces the saved one: a mistyped token cannot undo a good login
    const checked = await checkToken(core, token)
    if (checked.kind === 'rejected')
      throw new CliError(`${core} did not accept that credential; nothing was saved`)
    if (checked.kind === 'unreachable' && !ctx.bool('no-check'))
      throw new CliError(
        `could not reach ${core} to check that credential; nothing was saved (--no-check saves it anyway)`,
      )
    await saveLogin(ctx, deps, { core, token })
    ctx.io.stdout.write(
      loginDone({ core, person: checked.kind === 'ok' ? checked.person.name : undefined }),
    )
    return 0
  }
  const label = ctx.string('label') ?? hostname()
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  deps.signal?.addEventListener('abort', onAbort)
  const stopWatching = watchCancel(ctx.io, controller)
  try {
    const token = await deviceLogin({
      core,
      label,
      signal: controller.signal,
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      ...(deps.pollMs === undefined ? {} : { pollMs: deps.pollMs }),
      onCode: ({ code, expiresAt }) => {
        ctx.io.stdout.write(loginWaiting({ core, code, expiresAt, now: Date.now() }))
      },
    })
    await write(token, label)
    return 0
  } catch (error) {
    if (error instanceof DeviceLoginError) {
      if (error.reason === 'aborted') {
        ctx.io.stderr?.write('Cancelled.\n')
        return 130
      }
      throw new CliError(
        loginFailed(
          error.reason === 'expired' ? 'The code expired. Run `keith login` again.' : error.message,
        ),
      )
    }
    throw error
  } finally {
    stopWatching()
    deps.signal?.removeEventListener('abort', onAbort)
  }
}

/** Saves the login, then revokes the login it replaces (FD10-08); a note says when that revoke failed. The new login stays. */
async function saveLogin(ctx: CommandContext, deps: KeithDeps, entry: ClientConfig): Promise<void> {
  const note = await replaceClientConfig(entry, deps.configPath)
  if (note !== undefined) ctx.io.stderr?.write(`${note}\n`)
}

/** Username and password: `--username`, else asked; the password is hidden (or one line of piped stdin). */
async function passwordFlow(
  ctx: CommandContext,
  deps: KeithDeps,
  core: string,
  _write: (token: string, label?: string) => Promise<void>,
): Promise<number> {
  const username =
    ctx.string('username') ??
    (await ask('Username', {
      io: ctx.io,
      validate: (v) => (v === '' ? 'the username is empty' : undefined),
    }))
  const password = await askHidden('Password', {
    io: ctx.io,
    validate: (v) => (v === '' ? 'the password is empty' : undefined),
  })
  const label = ctx.string('label') ?? hostname()
  const remember = ctx.bool('remember')
  let token: string
  try {
    token = await passwordLogin({
      core,
      username,
      password,
      label,
      remember,
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    })
  } catch (error) {
    if (error instanceof LoginError) throw new CliError(loginFailed(passwordFailure(error)))
    throw error
  }
  await saveLogin(ctx, deps, { core, token, ...(remember ? { remember: true as const } : {}) })
  const person = await whoOf(core, token)
  ctx.io.stdout.write(
    passwordDone({
      core,
      username: person?.username ?? username,
      role: person?.role,
      remembered: remember,
    }),
  )
  return 0
}

function parseCoreFlagOrUsage(value: string): ReturnType<typeof parseCoreFlag> {
  try {
    return parseCoreFlag(value)
  } catch (error) {
    if (error instanceof CoreFlagError) throw new UsageError(error.message)
    throw error
  }
}

/**
 * The connection of a command, or a `CliError` saying there is none. `interactive` is for the app on a terminal:
 * a saved login is used only when it was remembered (connection.ts); `whoami`, `logout` and scripts use any.
 */
async function connectionOf(
  ctx: CommandContext,
  deps: KeithDeps,
  interactive = false,
): Promise<Connection> {
  let connection: Connection | undefined
  try {
    connection = await resolveConnection({
      core: ctx.string('core'),
      configPath: deps.configPath,
      dataDir: deps.dataDir,
      interactive,
      ...(deps.probe === undefined ? {} : { probe: deps.probe }),
    })
  } catch (error) {
    if (error instanceof CoreFlagError) throw new UsageError(error.message)
    throw error
  }
  if (connection === undefined) throw new CliError(NO_CORE)
  return connection
}

/**
 * Open the app on a resolved connection: `--core`, else a remembered login, else the local socket (a saved login
 * that was not remembered is never used silently: the app asks to sign in). When nothing is found (no `--core`, no
 * remembered login, no local socket) on a terminal, open the Sign in screen on the default address instead of failing;
 * without a terminal, or with a `--core` that did not resolve, it stays the `NO_CORE` error.
 */
async function openApp(
  ctx: CommandContext,
  deps: KeithDeps,
  start: (connection: Connection) => Promise<number | undefined>,
): Promise<number> {
  const terminal = deps.startLogin !== undefined && isInteractive(ctx.io)
  if (ctx.string('core') === undefined && terminal) {
    let connection: Connection | undefined
    try {
      connection = await resolveConnection({
        core: undefined,
        configPath: deps.configPath,
        dataDir: deps.dataDir,
        interactive: true,
        ...(deps.probe === undefined ? {} : { probe: deps.probe }),
      })
    } catch (error) {
      if (error instanceof CoreFlagError) throw new UsageError(error.message)
      throw error
    }
    // nothing reachable and nothing remembered: with a core already stored, still open the app (Home with its orb,
    // the sign-in panel and the disconnected state) on it; with none ever stored, ask for the address first
    if (connection === undefined) {
      const stored = readClientConfig(...(deps.configPath === undefined ? [] : [deps.configPath]))
      if (stored?.core === undefined) return loginScreen(ctx, deps)
      connection = await storedCoreConnection(ctx, deps)
    }
    return (await start(connection)) ?? 0
  }
  return (await start(await connectionOf(ctx, deps, terminal))) ?? 0
}

/** `keith --guest`: no login, no client.json, no local socket; the address is the guest listener's. */
async function guest(ctx: CommandContext, deps: KeithDeps): Promise<number> {
  let url: string
  try {
    url = guestUrlOf(ctx.string('core'))
  } catch (error) {
    if (error instanceof GuestUrlError) throw new UsageError(error.message)
    throw error
  }
  if (deps.startGuest !== undefined) return (await deps.startGuest(url)) ?? 0
  if (!isInteractive(ctx.io)) throw new CliError('guest chat needs a terminal')
  const { runGuestScreen } = await import('./guest-main.tsx')
  return runGuestScreen(url)
}

async function whoami(ctx: CommandContext, deps: KeithDeps): Promise<number> {
  const connection = await connectionOf(ctx, deps)
  const client: KeithClient = clientFor(connection)
  try {
    const me = await client.rpc.auth.whoami()
    const rows: Array<[string, string]> = [
      ['person', `${me.name} (${me.personId}, ${me.role})`],
      ['core', coreLabel(connection)],
      ['via', me.via],
      ['credential', me.credentialKind ?? 'none (local socket)'],
    ]
    for (const [k, v] of rows) ctx.io.stdout.write(`${k.padEnd(11)}${v}\n`)
    return 0
  } catch (error) {
    if (isUnauthorized(error))
      throw new CliError(connection.kind === 'socket' ? SOCKET_LOGGED_OUT : LOGGED_OUT)
    throw new CliError(`could not reach ${coreLabel(connection)}: ${(error as Error).message}`)
  }
}

async function logout(ctx: CommandContext, deps: KeithDeps): Promise<number> {
  const path = deps.configPath ?? defaultConfigPath()
  const stored = readClientConfig(path)
  if (stored === undefined) {
    ctx.io.stdout.write('Not logged in.\n')
    return 0
  }
  const client = clientFor({ kind: 'http', url: stored.core, token: stored.token, source: 'file' })
  // the same sign out as the app's `/logout` (sign-out.ts); only the words around it are the CLI's
  const { unreachable } = await signOut(client, path)
  // one line says what happened to the credential: never "revoked" when the core could not be asked
  if (unreachable) {
    ctx.io.stderr?.write(
      'Logged out on this device; the core could not be reached, so the credential is still valid there: keith-core devices revoke <id>.\n',
    )
    return 0
  }
  ctx.io.stdout.write(`✓ Logged out of ${stored.core}. This device's credential is revoked.\n`)
  return 0
}

/** The subcommands and the default chat of the `keith` program. */
export function keithCommands(deps: KeithDeps): Command[] {
  return [
    defineCommand({
      name: 'home',
      summary: 'Open the Home screen: the orb, the brain trace and the menu (the default command)',
      flags: {
        core: coreFlag,
        guest: {
          type: 'boolean',
          description:
            'chat as an anonymous guest (no login): --core is the guest listener, default http://127.0.0.1:7421',
        },
        'disable-orb': disableOrbFlag,
      },
      examples: ['keith --guest --core http://192.168.1.20:7421', 'keith --disable-orb'],
      run: async (ctx) => {
        if (ctx.bool('guest')) return guest(ctx, deps)
        applyDisableOrb(ctx)
        return openApp(ctx, deps, deps.startHome ?? deps.startChat)
      },
    }),
    defineCommand({
      name: 'chat',
      summary: 'Open the chat directly',
      flags: { core: coreFlag, 'disable-orb': disableOrbFlag },
      examples: ['keith chat --disable-orb'],
      run: async (ctx) => {
        applyDisableOrb(ctx)
        return openApp(ctx, deps, deps.startChat)
      },
    }),
    defineCommand({
      name: 'manage',
      summary: 'Open the management screen (people, devices, nodes, access, budget, audit)',
      flags: { core: coreFlag },
      run: async (ctx) => {
        if (deps.startManage === undefined) throw new CliError('manage needs a terminal')
        return openApp(ctx, deps, deps.startManage)
      },
    }),
    defineCommand({
      name: 'login',
      summary:
        'Log in to a core on another device: opens the sign-in screen on a terminal; flags keep the text flow for scripts',
      flags: {
        core: { ...coreFlag, description: `core URL (default: ${DEFAULT_CORE})` },
        token: {
          type: 'boolean',
          description: 'paste a token instead (hidden prompt, or piped stdin), for scripts',
        },
        password: {
          type: 'boolean',
          description: 'log in with a username and password (asks for them)',
        },
        username: { type: 'string', placeholder: 'name', description: 'username for --password' },
        'password-stdin': {
          type: 'boolean',
          description: 'read the password from piped stdin (one line), for scripts',
        },
        'no-check': {
          type: 'boolean',
          description: 'with --token: save the credential even when the core cannot be reached',
        },
        remember: {
          type: 'boolean',
          description:
            'with --password: keep this device signed in for 30 days, so the app opens signed in',
        },
        device: {
          type: 'boolean',
          description: 'log in with a device code the owner approves on the core machine',
        },
        label: {
          type: 'string',
          placeholder: 'name',
          description: 'name of this device in the core (default: this machine)',
        },
      },
      examples: [
        'keith login --core https://mac.tailnet.ts.net',
        'keith login',
        'keith login --password --username ana',
        'keith login --device',
        'keith login --token',
      ],
      run: (ctx) => login(ctx, deps),
    }),
    defineCommand({
      name: 'logout',
      summary: 'Revoke this device login and forget the token',
      run: (ctx) => logout(ctx, deps),
    }),
    defineCommand({
      name: 'whoami',
      summary: 'Show the core, the person and how you are connected',
      flags: { core: coreFlag },
      run: (ctx) => whoami(ctx, deps),
    }),
    ...lockCommands({
      dataDir: deps.dataDir,
      ...(deps.probe === undefined ? {} : { probe: deps.probe }),
    }),
  ]
}
