// Look vocabulary shared by both clients, as plain types. The TUI's `Tone`, `NoticeLevel`, `ToastLevel` and `ToolLineProps`
// (packages/ui) have the same shape; the web maps a tone to a `--k-*` colour token.

export type Tone =
  | 'text'
  | 'muted'
  | 'accent'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'tool'
  | 'assistant'

export type NoticeLevel = 'info' | 'warning' | 'error'

export type ToastLevel = 'info' | 'success' | 'warning' | 'error'

export interface ToolState {
  /** `✓ 0.4s`, `✕ exit 1`, `waiting for approval`, `00:42`. */
  text: string
  tone: Tone
  /** A running call shows the pulsing glyph before the text. */
  spinner?: boolean
}

/** One tool call as a line: the glyph, the label, a one-line summary, the state and at most 3 output lines. */
export interface ToolLineView {
  glyph: string
  glyphTone?: Tone
  label: string
  summary?: string
  state?: ToolState
  output?: readonly string[]
  more?: number
}
