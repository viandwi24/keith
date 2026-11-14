import type { KeithClient } from '@keith/client'
import type { Screen } from './app-screens.tsx'
import { type Connection, type SwitchOptions, signedInConnection } from './connection.ts'
import type { ChatNotice } from './features/chat/index.ts'
import type { LoginResult } from './features/login/index.ts'
import { guestUrlOfCore } from './guest-url.ts'
import { revokeOnQuit } from './quit-revoke.ts'

export interface SessionActionsInput {
  client: KeithClient
  core: string
  /** The connection `client` was built from (the root owns it: `app-root.tsx`). */
  swappable: Connection | undefined
  switchConnection?: ((next: Connection, options?: SwitchOptions) => void) | undefined
  enterGuest?: ((url: string) => void) | undefined
  guestFetch?: typeof fetch | undefined
  configPath: string | undefined
  origin: 'home' | 'chat'
  go(screen: Screen): void
  setScreen(screen: Screen): void
  /** Open Home's sign-out confirmation panel. */
  openLogoutPanel(): void
  say(notice: ChatNotice): void
}

/** Sign in and out: they need the root that owns the connection; without it the app says so. */
export function sessionActionsOf(p: SessionActionsInput) {
  const { swappable, switchConnection, client } = p
  const canSwitch = switchConnection !== undefined
  // the guest row of the sign-in panel: this core's guest listener, taken only when the core says it is available
  const guestUrl = guestUrlOfCore(p.core)
  const guest =
    p.enterGuest !== undefined && guestUrl !== undefined
      ? {
          url: guestUrl,
          onGuest: p.enterGuest,
          ...(p.guestFetch === undefined ? {} : { fetch: p.guestFetch }),
        }
      : undefined
  const info = (text: string) => p.say({ level: 'info', rows: [text] })
  const openLogin = () => {
    // the socket's sign in is Home's panel (its login screen is for a core with an address)
    if (swappable?.kind === 'socket' && canSwitch) p.setScreen('home')
    else if (canSwitch) p.go('login')
    else info('Signing in needs the keith app.')
  }
  const openLogout = () => {
    if (swappable?.kind === 'socket' && swappable.token !== undefined && canSwitch) {
      // a session on the socket (`local trust: none`): revoke it, drop it from memory, and the panel asks again
      const socket = swappable
      void client
        .revokeSelf()
        .catch(() => undefined)
        .finally(() => {
          switchConnection?.({ kind: 'socket', path: socket.path, source: 'socket' })
        })
    } else if (swappable?.kind === 'socket')
      info('The local socket needs no login: nothing to sign out.')
    else if (canSwitch) p.openLogoutPanel()
    else info('Signing out needs the keith app.')
  }
  const signedIn = async (result: LoginResult) => {
    const next = await signedInConnection(result.core, p.configPath)
    if (next === undefined || switchConnection === undefined) return p.setScreen(p.origin)
    const signedInAs =
      result.person === undefined ? 'signed in' : `signed in as ${result.person.name}`
    switchConnection(next, {
      notice: result.note === undefined ? signedInAs : `${signedInAs}; ${result.note}`,
    })
  }
  /** Home opens signed out; `notice` (when given) is the one success toast the new app shows. */
  const signedOut = (notice?: string) => {
    if (swappable?.kind !== 'http' || switchConnection === undefined) return p.setScreen('home')
    // the same core with no credential: Home opens signed out, its sign-in panel the way in
    switchConnection(
      { kind: 'http', url: swappable.url, source: 'file' },
      notice === undefined ? {} : { notice },
    )
  }
  /** `/quit`: a sign-in that is not remembered is revoked first (2 s at most), then the app exits. */
  const quit = (exit: () => void) => {
    if (swappable === undefined) return exit()
    void revokeOnQuit(swappable, client, p.configPath).finally(exit)
  }
  return { canSwitch, guest, openLogin, openLogout, signedIn, signedOut, quit }
}
