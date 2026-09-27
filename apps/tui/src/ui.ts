import type { ChatState, SendResult } from '@keith/client'
import {
  BoxRenderable,
  bold,
  type CliRenderer,
  dim,
  fg,
  type KeyEvent,
  ScrollBoxRenderable,
  StyledText,
  TextareaRenderable,
  type TextChunk,
  TextRenderable,
} from '@opentui/core'
import { entryViews, historyLine, type Segment, statusLine } from './view.ts'

/**
 * The conversation screen, drawn with OpenTUI's core renderables (ADR-0010). It holds no
 * protocol logic: it renders `ChatState` through `view.ts` and forwards keys to `ChatActions`.
 */

export type ChatActions = {
  send(text: string): SendResult
  cancel(): boolean
  /** Loads the page of history before the oldest shown message (`ChatClient.loadOlder`). */
  loadOlder(): void
  quit(): void
}

export type ChatScreen = {
  update(state: ChatState): void
  readonly input: TextareaRenderable
  /** The conversation log (exposed for tests: `scrollTop`, `scrollHeight`). */
  readonly log: ScrollBoxRenderable
  destroy(): void
}

export const HINT = 'Enter send · Ctrl+J newline · PgUp/PgDn scroll · Esc cancel · Ctrl+C quit'

const COLORS = {
  user: '#8ab4f8',
  assistant: '#e8eaed',
  proactive: '#f2b8ff',
  prefix: '#9aa0a6',
  warn: '#fdd663',
  error: '#f28b82',
  info: '#81c995',
} as const

function chunk(segment: Segment): TextChunk {
  switch (segment.style) {
    case 'user':
      return fg(COLORS.user)(segment.text)
    case 'assistant':
      return fg(COLORS.assistant)(segment.text)
    case 'proactive':
      return bold(fg(COLORS.proactive)(segment.text))
    case 'prefix':
      return fg(COLORS.prefix)(segment.text)
    case 'tool':
    case 'muted':
      return dim(segment.text)
    case 'tool-failed':
      return dim(fg(COLORS.error)(segment.text))
    case 'info':
      return fg(COLORS.info)(segment.text)
    case 'warn':
      return fg(COLORS.warn)(segment.text)
    case 'error':
      return fg(COLORS.error)(segment.text)
  }
}

export function mountChat(renderer: CliRenderer, actions: ChatActions): ChatScreen {
  const layout = new BoxRenderable(renderer, { id: 'chat', flexDirection: 'column', flexGrow: 1 })
  const status = new TextRenderable(renderer, { id: 'status', content: '', height: 1, fg: COLORS.prefix })
  const log = new ScrollBoxRenderable(renderer, {
    id: 'log',
    flexGrow: 1,
    stickyScroll: true,
    stickyStart: 'bottom',
    contentOptions: { flexDirection: 'column', gap: 0 },
  })
  const inputBox = new BoxRenderable(renderer, { id: 'input-box', border: true, flexShrink: 0 })
  const input = new TextareaRenderable(renderer, {
    id: 'input',
    minHeight: 1,
    maxHeight: 8,
    wrapMode: 'word',
    placeholder: 'Message Keith',
    keyBindings: [
      { name: 'return', action: 'submit' },
      { name: 'kpenter', action: 'submit' },
      { name: 'return', shift: true, action: 'newline' },
      { name: 'return', meta: true, action: 'newline' },
      { name: 'linefeed', action: 'newline' },
    ],
    onSubmit: () => {
      const result = actions.send(input.plainText)
      if (result.ok) {
        input.setText('')
        hint.content = HINT
      } else if (result.reason === 'offline') {
        hint.content = 'not connected: your message is kept'
      } else if (result.reason === 'too-long') {
        hint.content = 'message too long'
      }
    },
  })
  const hint = new TextRenderable(renderer, { id: 'hint', content: HINT, height: 1, fg: COLORS.prefix })

  inputBox.add(input)
  layout.add(status)
  layout.add(log)
  layout.add(inputBox)
  layout.add(hint)
  renderer.root.add(layout)
  input.focus()

  // The first row of the log: whether older history can be loaded. The message lines follow it.
  const historyText = new TextRenderable(renderer, {
    id: 'history',
    content: '',
    height: 1,
    fg: COLORS.prefix,
  })
  log.add(historyText)

  let destroyed = false
  let current: ChatState | null = null
  let lines: { key: string; text: TextRenderable; signature: string }[] = []
  // Distance from the scroll position to the bottom of the log, kept across a prepended page so
  // the lines the user is looking at stay in place.
  let anchorFromBottom: number | null = null

  const makeLine = (key: string, segments: Segment[], signature: string, index?: number) => {
    const text = new TextRenderable(renderer, {
      content: new StyledText(segments.map(chunk)),
      wrapMode: 'word',
    })
    log.add(text, index)
    return { key, text, signature }
  }

  /** How many views come before the current lines, or -1 when the lines don't line up with them. */
  const prependedCount = (views: { key: string }[]): number => {
    if (lines.length === 0) return 0
    const first = views.findIndex((v) => v.key === lines[0]?.key)
    if (first === -1 || first + lines.length > views.length) return -1
    return lines.every((line, i) => line.key === views[first + i]?.key) ? first : -1
  }

  const renderEntries = (state: ChatState) => {
    const views = entryViews(state)
    // Streaming appends, in-place updates and a prepended older page keep the existing lines.
    // Anything else (a history reload after reconnect) rebuilds the list.
    const prepended = prependedCount(views)
    if (prepended === -1) {
      for (const line of lines) {
        log.remove(line.text)
        line.text.destroy()
      }
      lines = []
    } else if (prepended > 0) {
      anchorFromBottom = log.scrollHeight - log.scrollTop
      const older = views
        .slice(0, prepended)
        // Index 0 of the log is the history line.
        .map((view, i) => makeLine(view.key, view.segments, JSON.stringify(view.segments), i + 1))
      lines = [...older, ...lines]
    }
    for (const [i, view] of views.entries()) {
      const signature = JSON.stringify(view.segments)
      const line = lines[i]
      if (!line) {
        lines.push(makeLine(view.key, view.segments, signature))
      } else if (line.signature !== signature) {
        line.text.content = new StyledText(view.segments.map(chunk))
        line.signature = signature
      }
    }
  }

  const loadOlder = () => {
    if (current?.history.hasMore && !current.history.loading) actions.loadOlder()
  }

  // Runs after the scroll box has taken the new content height (its own size handler runs first).
  const onContentResize = () => {
    if (anchorFromBottom === null) return
    log.scrollTop = log.scrollHeight - anchorFromBottom
    anchorFromBottom = null
  }
  log.content.on('resize', onContentResize)

  // Reaching the top of a log taller than the view (mouse wheel, PgUp) loads the previous page.
  const onScroll = ({ position }: { position: number }) => {
    if (position === 0 && anchorFromBottom === null && log.scrollHeight > log.viewport.height) loadOlder()
  }
  log.verticalScrollBar.on('change', onScroll)

  const onKey = (key: KeyEvent) => {
    if (key.ctrl && key.name === 'c') {
      key.preventDefault()
      actions.quit()
      return
    }
    if (key.name === 'escape') {
      key.preventDefault()
      actions.cancel()
      return
    }
    if (key.name === 'pageup') {
      key.preventDefault()
      // Already at the top (or nothing to scroll): ask for the previous page.
      if (log.scrollTop === 0) loadOlder()
      else log.scrollBy(-0.5, 'viewport')
      return
    }
    if (key.name === 'pagedown') {
      key.preventDefault()
      log.scrollBy(0.5, 'viewport')
    }
  }
  renderer.keyInput.on('keypress', onKey)

  return {
    input,
    log,
    update(state) {
      if (destroyed) return
      current = state
      status.content = statusLine(state)
      historyText.content = historyLine(state)
      renderEntries(state)
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      renderer.keyInput.off('keypress', onKey)
      log.verticalScrollBar.off('change', onScroll)
      log.content.off('resize', onContentResize)
      renderer.root.remove(layout)
      layout.destroyRecursively()
    },
  }
}
