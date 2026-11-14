import type { KeithClient } from '@keith/client'
import type { CommandEnv } from './app-commands.ts'
import type { SignInTuning } from './app-session.tsx'
import type { Connection, SwitchOptions } from './connection.ts'
import type { BrainTuning } from './features/brain/index.ts'
import type { HomeMotion } from './features/home/index.ts'

/** The props of `App` (app.tsx). */
export interface AppProps {
  client: KeithClient
  /** The core as the user named it: an http(s) URL or `unix:<path>` (shown in the header and `/whoami`). */
  core: string
  /** Terminal size; default is the real one (tests set them, `ink-testing-library` fixes 100 columns). */
  columns?: number
  rows?: number
  /** Fade and render period of the brain panel (tests shorten them). */
  brain?: BrainTuning
  /** How often the spend in the header is read again (default 60 s; tests shorten it). */
  budgetPollMs?: number
  /**
   * The screen the app opens on: `home` (`keith`, the default), `chat` (`keith chat`) or `manage`
   * (`keith manage`: no chat, Esc quits) or `login` (the Sign in screen first; Esc goes Home).
   */
  start?: 'home' | 'chat' | 'manage' | 'login'
  /** The connection `client` was built from (the root owns it: `app-root.tsx`). */
  connection?: Connection
  /** Replace the connection: the root rebuilds the app on the new client (`app-root.tsx`). */
  switchConnection?(next: Connection, options?: SwitchOptions): void
  /** Open guest chat on a guest listener (the root draws it in place of the app); without it Home offers no guest entry. */
  enterGuest?(url: string): void
  /** Test hook: the `fetch` of the guest status check on the sign-in panel. */
  guestFetch?: typeof fetch
  /** `client.json` path the Sign in and Sign out screens write and remove (`undefined`: the client's default). */
  configPath?: string | undefined
  /** Timings of the Sign in screen (tests shorten them). */
  signInTuning?: SignInTuning
  /** Cell width over cell height, detected at start (`cli.tsx`); `[` `]` and `ctrl+o` `ctrl+p` adjust it for the session. */
  cellAspect?: number
  /** The orb header on the chat (default on; a test turns it off to assert the compact layout). */
  header?: boolean
  /** How often a member's node list is read again while the sidebar shows it (default 30 s). */
  nodesPollMs?: number
  /** Home's intro and idle hide (`AppRoot` fills it from the config; default: intro on, hide after 60 s). */
  motion?: HomeMotion
  /** Wheel reporting, for `/mouse` (`cli.tsx` owns the terminal mode; tests may pass a fake). */
  mouse?: CommandEnv['mouse']
}
