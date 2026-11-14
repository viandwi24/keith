import type { KeithClient } from '@keith/client'
import type { ReactNode } from 'react'
import {
  LoginPanelHost,
  type LoginPanelHostProps,
  type SignInTuning,
  SocketLoginPanelHost,
  UnlockPanelHost,
} from './app-session.tsx'
import type { Connection, SwitchOptions } from './connection.ts'
import { PrivacyPanel } from './features/identity/index.ts'
import { type LoginResult, LogoutScreen } from './features/login/index.ts'
import { SuccessionPanel } from './features/manage/index.ts'
import type { StepUp } from './features/stepup/index.ts'
import { signOut } from './sign-out.ts'

export interface HomePanelInput {
  locked: boolean
  loggedOut: boolean
  /** The root owns the connection, so the app may swap it (`app-root.tsx`). */
  canSwitch: boolean
  standalone: boolean
  /** The core as the user named it. */
  core: string
  swappable: Connection | undefined
  switchConnection?: ((next: Connection, options?: SwitchOptions) => void) | undefined
  configPath: string | undefined
  signInTuning: SignInTuning | undefined
  signedIn(result: LoginResult): void | Promise<void>
  guest: LoginPanelHostProps['guest']
  /** The sign-out confirmation is open (`/logout`, the menu): Home draws it over the orb. */
  logout?: { client: KeithClient; onDone(): void; onCancel(): void } | undefined
  /** `/succession`: the heir's panel (state, and the claim when it is open). */
  succession?:
    | { client: KeithClient; guard: StepUp['guard']; onClaimed(): void; onClose(): void }
    | undefined
  /** The first-login notice, once the core says this person has not seen it (last: it never displaces a sign-in). */
  privacy?: { text: string; onAck(): void } | undefined
}

/**
 * The panel Home draws over the lower orb when the person has to get in, or `undefined`: the PIN
 * panel of a locked socket, the sign in of a signed-out socket session, the sign in of a core the
 * app can swap, the first-login notice.
 */
export function homePanelOf(p: HomePanelInput): ((width: number) => ReactNode) | undefined {
  const { swappable, switchConnection } = p
  const usable = p.canSwitch && !p.standalone
  if (p.succession !== undefined) {
    const { client, guard, onClaimed, onClose } = p.succession
    return (width) => (
      <SuccessionPanel
        client={client}
        guard={guard}
        width={Math.min(width, 46)}
        onClaimed={onClaimed}
        onClose={onClose}
      />
    )
  }
  if (p.logout !== undefined) {
    const { client, onDone, onCancel } = p.logout
    return (width) => (
      <LogoutScreen
        core={p.core}
        panel={{ width: Math.min(width, 46) }}
        onConfirm={() => signOut(client, p.configPath, p.core)}
        onDone={onDone}
        onCancel={onCancel}
      />
    )
  }
  // locked socket: the PIN opens it; the app then swaps to a fresh connection
  if (p.locked && usable && swappable?.kind === 'socket')
    return (width) => (
      <UnlockPanelHost
        path={swappable.path}
        width={width}
        onUnlocked={() => switchConnection?.(swappable, { notice: 'unlocked' })}
      />
    )
  // signed out on the socket (its owner needs a session): the panel signs in through the socket
  if (p.loggedOut && usable && swappable?.kind === 'socket')
    return (width) => (
      <SocketLoginPanelHost
        path={swappable.path}
        configPath={p.configPath}
        tuning={p.signInTuning}
        width={width}
        onSignedIn={(token, name) =>
          switchConnection?.(
            { ...swappable, token, source: 'socket' },
            { notice: name === undefined ? 'signed in' : `signed in as ${name}` },
          )
        }
      />
    )
  // signed out on a core the app can swap: the panel is the way in
  if (p.loggedOut && usable && !p.core.startsWith('unix:'))
    return (width) => (
      <LoginPanelHost
        core={p.core}
        configPath={p.configPath}
        tuning={p.signInTuning}
        width={width}
        onSignedIn={p.signedIn}
        guest={p.guest}
      />
    )
  if (p.privacy !== undefined) {
    const { text, onAck } = p.privacy
    return (width) => <PrivacyPanel text={text} width={width} onDone={onAck} />
  }
  return undefined
}
