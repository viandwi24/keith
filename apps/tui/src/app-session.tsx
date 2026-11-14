import {
  createKeithClient,
  createSignIn,
  fileIdentifierMemory,
  type KeithClient,
  LocalLockError,
  localStatus,
  type SignIn,
  type SignInOptions,
  type SignInStore,
  setFirstOwner,
  socketFetch,
  unlockLocal,
} from '@keith/client'
import { Box } from 'ink'
import { useEffect, useState } from 'react'
import { GuestEntry } from './features/guest/index.ts'
import {
  FirstOwnerPanel,
  LoginPanel,
  type LoginResult,
  LoginScreen,
  LogoutScreen,
  UnlockPanel,
} from './features/login/index.ts'
import { LegacyLoginNotice } from './legacy-login.tsx'
import { forgetSession, rememberSession } from './session-vault.ts'
import { replaceClientConfig, signOut } from './sign-out.ts'

/** Test hooks for the Sign in screen (the real timings are the defaults). */
export interface SignInTuning {
  /** Device-code poll period. */
  pollMs?: number
  /** How long `signed in` stays before the app moves on. */
  doneMs?: number
  /** Countdown tick. */
  tickMs?: number
}

export interface SessionScreensProps {
  screen: 'login' | 'logout'
  client: KeithClient
  /** The core as the user named it (`unix:<path>` for the socket). */
  core: string
  /** `client.json` path (`undefined`: the client's default). */
  configPath: string | undefined
  tuning: SignInTuning | undefined
  width: number
  onCancel(): void
  onSignedIn(result: LoginResult): void
  onSignedOut(): void
}

/**
 * Where an http sign-in goes: the credential is kept in memory (session-vault.ts) and written to `client.json` only
 * when the person ticked "remember this device" (`remember: true`, a 30 days idle session). Nothing else reaches disk.
 */
function appStore(configPath: string | undefined): SignInStore {
  return {
    write: async (config) => {
      rememberSession(config.core, config.token)
      if (config.remember !== true) return undefined
      try {
        // a remembered login replaces the one in the file, and that one is revoked (sign-out.ts, FD10-08)
        return await replaceClientConfig(config, configPath)
      } catch (error) {
        // the file failed after the vault took the credential: the vault entry goes too (FD10-14)
        forgetSession(config.core)
        throw error
      }
    },
  }
}

/** The login panel never stretches with the terminal: its content is short, 46 cells at most (and what Home gives). */
export const LOGIN_PANEL_MAX = 46
export const loginPanelWidth = (available: number): number => Math.min(available, LOGIN_PANEL_MAX)

/** The old-login notice has its own width, apart from the panel's: change the panel without reflowing the notice. */
export const LEGACY_NOTICE_MAX = 60
export const legacyNoticeWidth = (available: number): number =>
  Math.min(available, LEGACY_NOTICE_MAX)

/** One controller of this app: keeps the sign-in as `appStore` says, remembers the identifier next to `client.json`. */
function newSignIn(
  core: string,
  configPath: string | undefined,
  tuning: SignInTuning | undefined,
  over: Pick<SignInOptions, 'fetch' | 'store'> = {},
) {
  return createSignIn({
    address: core,
    store: appStore(configPath),
    ...over,
    // the remembered identifier lives next to the credential file; no path, nothing remembered
    ...(configPath === undefined ? {} : { remember: fileIdentifierMemory(configPath) }),
    ...(tuning?.pollMs === undefined ? {} : { pollMs: tuning.pollMs }),
  })
}

export interface LoginPanelHostProps {
  /** The core the panel signs in to (an http(s) address: the socket has no login). */
  core: string
  configPath: string | undefined
  tuning: SignInTuning | undefined
  /** Cells of the panel, borders included. */
  width: number
  onSignedIn(result: LoginResult): void
  /** Guest chat of this core: its listener, and what to do when the visitor takes it (the row shows only when the core says it is available). */
  guest?: { url: string; onGuest(url: string): void; fetch?: typeof fetch } | undefined
}

/**
 * Home's login panel: the controller lives as long as the panel is on screen and starts at once
 * on the identifier box (the core is already known: it is the one that said 401).
 */
export function LoginPanelHost({
  core,
  configPath,
  tuning,
  width,
  onSignedIn,
  guest,
}: LoginPanelHostProps) {
  const [signIn] = useState<SignIn>(() => newSignIn(core, configPath, tuning))
  useEffect(() => {
    void signIn.submitAddress(core)
    return () => signIn.dispose()
  }, [signIn, core])
  return (
    <Box flexDirection="column" alignItems="center">
      <LegacyLoginNotice configPath={configPath} width={legacyNoticeWidth(width)} />
      <LoginPanel
        signIn={signIn}
        width={loginPanelWidth(width)}
        offerRemember
        onDone={onSignedIn}
        {...(tuning?.doneMs === undefined ? {} : { doneMs: tuning.doneMs })}
        {...(tuning?.tickMs === undefined ? {} : { tickMs: tuning.tickMs })}
      />
      {guest !== undefined && (
        <GuestEntry
          url={guest.url}
          onGuest={guest.onGuest}
          {...(guest.fetch === undefined ? {} : { fetch: guest.fetch })}
        />
      )}
    </Box>
  )
}

export interface SocketLoginPanelHostProps {
  /** The core's Unix socket, whose owner needs a session (`local trust: none`). */
  path: string
  configPath: string | undefined
  tuning: SignInTuning | undefined
  width: number
  /** Signed in: the app swaps to a connection that carries the credential (in memory only) and says who signed in. */
  onSignedIn(token: string, name?: string): void
}

/**
 * Home's login panel on the local socket when it serves no implicit owner (the default): the same
 * controller and panel, talking through the socket (zone `loopback`). The credential is kept in memory
 * and handed to the app, never written to a file; the identifier (never a secret) is remembered next to
 * `client.json`. When the core says the owner has no PIN and no password yet, the panel is the first-owner
 * one (the core allows that once, only on the socket).
 */
export function SocketLoginPanelHost({
  path,
  configPath,
  tuning,
  width,
  onSignedIn,
}: SocketLoginPanelHostProps) {
  const [mode, setMode] = useState<'checking' | 'login' | 'first-owner'>('checking')
  useEffect(() => {
    let live = true
    localStatus({ fetch: socketFetch(path) })
      .then((s) => live && setMode(s.needsFirstOwner ? 'first-owner' : 'login'))
      // an older core has no such route: the normal sign in
      .catch(() => live && setMode('login'))
    return () => {
      live = false
    }
  }, [path])
  if (mode === 'checking') return null
  if (mode === 'first-owner') {
    return (
      <FirstOwnerPanel
        width={width}
        onSet={async (pin) => {
          try {
            const made = await setFirstOwner({ fetch: socketFetch(path), pin })
            const me = await createKeithClient({
              baseUrl: SOCKET_CORE,
              fetch: socketFetch(path),
              token: made.credential,
            })
              .rpc.auth.whoami()
              .catch(() => undefined)
            onSignedIn(made.credential, me?.name)
            return undefined
          } catch (error) {
            if (error instanceof LocalLockError && error.reason === 'closed') {
              // somebody set one meanwhile: the normal sign in
              setMode('login')
              return 'an owner sign-in exists now: sign in with it'
            }
            return error instanceof LocalLockError && error.reason === 'refused'
              ? error.message
              : unlockProblem(error)
          }
        }}
      />
    )
  }
  return (
    <SocketSignIn
      path={path}
      configPath={configPath}
      tuning={tuning}
      width={width}
      onSignedIn={onSignedIn}
    />
  )
}

function SocketSignIn({ path, configPath, tuning, width, onSignedIn }: SocketLoginPanelHostProps) {
  const [saved] = useState<{ token?: string }>(() => ({}))
  const [signIn] = useState<SignIn>(() =>
    newSignIn(SOCKET_CORE, configPath, tuning, {
      fetch: socketFetch(path),
      // the credential stays in this object: handed to the app on done, never written anywhere
      store: {
        write: (config) => {
          saved.token = config.token
        },
      },
    }),
  )
  useEffect(() => {
    void signIn.submitAddress(SOCKET_CORE)
    return () => signIn.dispose()
  }, [signIn])
  return (
    <Box flexDirection="column" alignItems="center">
      <LegacyLoginNotice configPath={configPath} width={legacyNoticeWidth(width)} />
      <LoginPanel
        signIn={signIn}
        width={loginPanelWidth(width)}
        onDone={(result) =>
          saved.token !== undefined && onSignedIn(saved.token, result.person?.name)
        }
        {...(tuning?.doneMs === undefined ? {} : { doneMs: tuning.doneMs })}
        {...(tuning?.tickMs === undefined ? {} : { tickMs: tuning.tickMs })}
      />
    </Box>
  )
}

/** The base URL of the controller's requests when it talks through the socket (the host is ignored). */
const SOCKET_CORE = 'http://localhost'

export interface UnlockPanelHostProps {
  /** The core's Unix socket. */
  path: string
  width: number
  /** The socket opened: the app swaps to a fresh connection (new feed, new reads). */
  onUnlocked(): void
}

/** The line that answers a refused unlock. */
export function unlockProblem(error: unknown): string {
  if (error instanceof LocalLockError) {
    if (error.reason === 'invalid') return 'wrong PIN'
    if (error.reason === 'throttled')
      return `too many attempts: wait ${error.retryAfter ?? 'a few'} s and try again`
    return error.message
  }
  return `cannot reach core: ${String(error)}`
}

/** Home's unlock panel on the local socket (`423 locked`): the PIN goes to `/auth/local/unlock`. */
export function UnlockPanelHost({ path, width, onUnlocked }: UnlockPanelHostProps) {
  return (
    <UnlockPanel
      width={width}
      onUnlock={async (pin) => {
        try {
          await unlockLocal({ fetch: socketFetch(path), pin })
        } catch (error) {
          return unlockProblem(error)
        }
        onUnlocked()
        return undefined
      }}
    />
  )
}

/** The controller lives as long as the screen: created when it opens, disposed when it closes. */
function LoginHost({
  core,
  configPath,
  tuning,
  width,
  onCancel,
  onSignedIn,
}: Omit<SessionScreensProps, 'screen' | 'client' | 'onSignedOut'>) {
  const [signIn] = useState<SignIn>(() => newSignIn(core, configPath, tuning))
  useEffect(() => () => signIn.dispose(), [signIn])
  return (
    <Box flexDirection="column">
      <LegacyLoginNotice configPath={configPath} />
      <LoginScreen
        signIn={signIn}
        offerRemember
        initialCore={core}
        onCancel={onCancel}
        onDone={onSignedIn}
        columns={width}
        {...(tuning?.doneMs === undefined ? {} : { doneMs: tuning.doneMs })}
        {...(tuning?.tickMs === undefined ? {} : { tickMs: tuning.tickMs })}
      />
    </Box>
  )
}

/** The Sign in and Sign out screens of the app (docs/specs/tui-login.md, "How the app uses it"). */
export function SessionScreens(props: SessionScreensProps) {
  if (props.screen === 'login') return <LoginHost {...props} />
  return (
    <LogoutScreen
      core={props.core}
      columns={props.width}
      onConfirm={() => signOut(props.client, props.configPath, props.core)}
      onDone={props.onSignedOut}
      onCancel={props.onCancel}
    />
  )
}
