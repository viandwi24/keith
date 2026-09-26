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
import { entryViews, type Segment, statusLine } from './view.ts'

/**
 * The conversation screen, drawn with OpenTUI's core renderables (ADR-0010). It holds no
 * protocol logic: it renders `ChatState` through `view.ts` and forwards keys to `ChatActions`.
 */

export type ChatActions = {
  send(text: string): SendResult
  cancel(): boolean
  quit(): void
}

export type ChatScreen = {
  update(state: ChatState): void
  readonly input: TextareaRenderable
  destroy(): void
}

export const HINT = 'Enter send · Ctrl+J newline · Esc cancel · Ctrl+C quit'

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

  let destroyed = false
  let lines: { key: string; text: TextRenderable; signature: string }[] = []

  const makeLine = (key: string, segments: Segment[], signature: string) => {
    const text = new TextRenderable(renderer, {
      content: new StyledText(segments.map(chunk)),
      wrapMode: 'word',
    })
    log.add(text)
    return { key, text, signature }
  }

  const renderEntries = (state: ChatState) => {
    const views = entryViews(state)
    // Streaming appends and in-place updates keep the existing lines. Anything else (a history
    // reload after reconnect) rebuilds the list.
    const keepsOrder = lines.length <= views.length && lines.every((line, i) => line.key === views[i]?.key)
    if (!keepsOrder) {
      for (const line of lines) {
        log.remove(line.text)
        line.text.destroy()
      }
      lines = []
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

  const onKey = (key: KeyEvent) => {
    if (key.ctrl && key.name === 'c') {
      key.preventDefault()
      actions.quit()
      return
    }
    if (key.name === 'escape') {
      key.preventDefault()
      actions.cancel()
    }
  }
  renderer.keyInput.on('keypress', onKey)

  return {
    input,
    update(state) {
      if (destroyed) return
      status.content = statusLine(state)
      renderEntries(state)
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      renderer.keyInput.off('keypress', onKey)
      renderer.root.remove(layout)
      layout.destroyRecursively()
    },
  }
}
