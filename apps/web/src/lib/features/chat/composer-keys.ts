// What a key does in the composer. Pure: the textarea's handler passes the event's fields and runs the answer.

export interface ComposerKey {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  /** An IME composition is running (Enter then picks a candidate, it does not send). */
  isComposing: boolean
}

export interface ComposerState {
  /** The slash menu has entries to choose from. */
  menu: boolean
  /** A turn runs (Esc stops it). */
  busy: boolean
}

export type ComposerAction =
  | 'send'
  | 'newline'
  | 'complete'
  | 'menu-up'
  | 'menu-down'
  | 'close-menu'
  | 'stop'
  | 'none'

export function composerAction(event: ComposerKey, state: ComposerState): ComposerAction {
  if (event.isComposing) return 'none'
  switch (event.key) {
    case 'Enter':
      // Shift+Enter is a new line; the browser inserts it
      return event.shiftKey ? 'newline' : 'send'
    case 'Tab':
      return state.menu && !event.shiftKey ? 'complete' : 'none'
    case 'ArrowUp':
      return state.menu ? 'menu-up' : 'none'
    case 'ArrowDown':
      return state.menu ? 'menu-down' : 'none'
    case 'Escape':
      if (state.menu) return 'close-menu'
      return state.busy ? 'stop' : 'none'
    default:
      return 'none'
  }
}
