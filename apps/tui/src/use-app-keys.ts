import { useInput } from 'ink'
import type { Dispatch, SetStateAction } from 'react'
import type { Screen } from './app-screens.tsx'
import { stepAspect } from './platform/cell-size.ts'

export interface AppKeysInput {
  screen: Screen
  /** Where Esc goes back to from a plain screen. */
  origin: 'home' | 'chat'
  chatBusy: boolean
  /** The approval bar has the keys. */
  barHasKeys: boolean
  stepUpOpen: boolean
  loggedOut: boolean
  /** The sidebar is hidden now (`ctrl+b` shows it). */
  sidebarHidden: boolean
  setScreen(screen: Screen): void
  goHome(): void
  openLogin(): void
  setCellAspect: Dispatch<SetStateAction<number>>
  setSidebarPref(shown: boolean): void
  toggleTasks(): void
  /** A key was pressed: the person is here (the presence reporter's `touch`). */
  touch(): void
}

/**
 * The keys of the app itself, below every screen's own. Esc has one meaning per state: a plain
 * screen goes back to where it came from; the idle chat goes Home; while a turn runs it stops the
 * turn (the chat does that itself, as does Home) and nothing else. A focused approval bar keeps its
 * own Esc.
 */
export function useAppKeys(k: AppKeysInput): void {
  const { screen, stepUpOpen, loggedOut, barHasKeys } = k
  // any key is presence: the reporter says `active` on its next heartbeat (docs/specs/parietal.md)
  useInput(() => k.touch())
  useInput(
    (_, key) => {
      if (!key.escape) return
      if (
        screen === 'help' ||
        screen === 'trace' ||
        screen === 'nodes' ||
        screen === 'budget' ||
        screen === 'presence'
      )
        k.setScreen(k.origin)
      else if (screen === 'chat' && !k.chatBusy && !barHasKeys) k.goHome()
    },
    { isActive: !stepUpOpen },
  )
  // the logged-out block of the chat offers the same sign in as Home's panel
  useInput(
    (_, key) => {
      if (key.return) k.openLogin()
    },
    { isActive: loggedOut && screen === 'chat' && !stepUpOpen },
  )
  // ctrl+g goes Home from the chat at any time; a running turn keeps streaming (the chat stays mounted)
  useInput(
    (input, key) => {
      if (key.ctrl && input === 'g' && screen === 'chat') k.goHome()
    },
    { isActive: !loggedOut },
  )
  // a hidden key: the orb's roundness by hand where the terminal does not report its cell size
  useInput(
    (input, key) => {
      const home = screen === 'home'
      if ((key.ctrl && input === 'o') || (home && input === '['))
        k.setCellAspect((a) => stepAspect(a, -1))
      if ((key.ctrl && input === 'p') || (home && input === ']'))
        k.setCellAspect((a) => stepAspect(a, 1))
    },
    { isActive: (screen === 'home' || screen === 'chat') && !stepUpOpen && !barHasKeys },
  )
  useInput(
    (input, key) => {
      if (key.ctrl && input === 'b') k.setSidebarPref(k.sidebarHidden)
      if (key.ctrl && input === 't') k.toggleTasks()
    },
    { isActive: !loggedOut && !stepUpOpen && screen !== 'view' },
  )
}
