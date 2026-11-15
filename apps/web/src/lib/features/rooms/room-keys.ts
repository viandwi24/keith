export interface ComposerKey {
  key: string
  shiftKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  isComposing?: boolean
}

/** Enter sends, Shift+Enter is a new line; nothing sends while an IME composes or with another modifier. */
export const sendsRoomMessage = (e: ComposerKey): boolean =>
  e.key === 'Enter' &&
  e.isComposing !== true &&
  e.shiftKey !== true &&
  e.ctrlKey !== true &&
  e.metaKey !== true &&
  e.altKey !== true

/** The placeholder of the message field: a reply to Keith's last line says so. */
export const placeholderOf = (replying: boolean): string =>
  replying ? 'Reply to Keith' : 'Message the room'

/** Why the field is off, in the TUI's words; undefined while the person may speak. */
export function inputOffText(state: {
  ended: boolean
  left: boolean
  canSpeak: boolean
}): string | undefined {
  if (state.ended) return 'The room has ended. Its transcript stays readable.'
  if (state.left) return 'You are no longer in this room.'
  if (!state.canSpeak) return 'Sending is off.'
  return undefined
}
