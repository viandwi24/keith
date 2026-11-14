/** The one glyph set (tui-design section 3): every glyph is one cell wide and none is an emoji. */
export const G = {
  /** ok, online, live, the assistant's dot */
  dot: '●',
  /** in progress: running task, cortex with workers, reconnecting, amygdala waiting */
  working: '◐',
  /** off, idle, offline, queued */
  idle: '○',
  done: '✓',
  /** failure */
  failed: '✕',
  stopped: '■',
  /** a task waits on an approval or input */
  waiting: '‖',
  timedOut: '⊘',
  interrupted: '↯',
  /** a proactive message (a worker report that woke the front agent) */
  proactive: '◆',
  warn: '!',
  /** the selected row of a list: accent, with a bold label */
  pointer: '▸',
  /** prompt, user-message marker, tool call, latest event */
  prompt: '›',
  /** Keith's mark in a room transcript (accent): the speaker of Keith's lines */
  keith: 'K',
  /** rule: tool output gutter, the sides of a frame */
  rule: '│',
  hrule: '─',
  sep: '·',
  ellipsis: '…',
  shell: '$',
  bullet: '•',
  /** masked input */
  mask: '•',
  down: '↓',
} as const
