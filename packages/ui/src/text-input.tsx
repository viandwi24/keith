import { Box, useInput, usePaste } from 'ink'
import { useRef } from 'react'
import { G } from './glyphs.ts'
import { Txt } from './text.tsx'
import { wrapRows } from './text-width.ts'

export interface TextInputProps {
  value: string
  onChange(value: string): void
  onSubmit(value: string): void
  /** Show `•` instead of the characters (secrets). */
  mask?: boolean
  placeholder?: string
  focus?: boolean
  /** Cells available for the text; the draft is wrapped to it. Default 80. */
  width?: number
  /** The draft shows at most this many rows (the last ones); default 6. */
  maxRows?: number
  /** Allow `shift+enter` / `alt+enter` / `ctrl+j` / `\` + enter / paste to add newlines (the chat input; not the reason input). */
  multiline?: boolean
}

const normalize = (text: string): string => text.replace(/\r\n?/g, '\n')

/**
 * A text field on Ink's `useInput` (Ink ships no text field). Keys can arrive faster than React
 * re-renders (typing fast, a paste), so edits apply to the latest value in a ref, not to the
 * `value` of the last render. `enter` submits; `shift+enter` (a terminal with the Kitty keyboard protocol), `alt+enter`,
 * `ctrl+j`, or `\` then `enter`, adds a newline;
 * a bracketed paste arrives whole through `usePaste` with its newlines and is never submitted.
 * The cursor is one inverse cell at the end.
 */
export function TextInput({
  value,
  onChange,
  onSubmit,
  mask,
  placeholder,
  focus = true,
  width = 80,
  maxRows = 6,
  multiline = false,
}: TextInputProps) {
  const latest = useRef(value)
  latest.current = value
  const set = (next: string) => {
    latest.current = next
    onChange(next)
  }
  useInput(
    (input, key) => {
      if (key.return) {
        if (multiline && (key.shift || key.meta)) return set(`${latest.current}\n`)
        const text = latest.current
        // `\` then enter: the backslash becomes a newline
        if (multiline && text.endsWith('\\')) return set(`${text.slice(0, -1)}\n`)
        return onSubmit(text)
      }
      if (multiline && (input === '\n' || (key.ctrl && input === 'j')))
        return set(`${latest.current}\n`)
      if (key.backspace || key.delete) return set(Array.from(latest.current).slice(0, -1).join(''))
      if (key.ctrl || key.meta || key.escape || key.tab || key.upArrow || key.downArrow) return
      if (key.pageUp || key.pageDown || key.home || key.end) return
      if (input === '') return
      const text = normalize(input)
      set(latest.current + (multiline ? text : text.replaceAll('\n', ' ')))
    },
    { isActive: focus },
  )
  usePaste(
    (text) => {
      const clean = normalize(text)
      set(latest.current + (multiline ? clean : clean.replaceAll('\n', ' ')))
    },
    { isActive: focus },
  )
  if (value === '' && placeholder !== undefined) {
    const [first = '', ...rest] = Array.from(placeholder)
    return (
      <Box flexShrink={1}>
        {focus ? <Txt inverse>{first}</Txt> : <Txt tone="muted">{first}</Txt>}
        <Txt tone="muted">{rest.join('')}</Txt>
      </Box>
    )
  }
  const dim = !focus
  const shown = mask === true ? value.replace(/[^\n]/g, G.mask) : value
  const rows = shown.split('\n').flatMap((line) => wrapRows(line, width - 1))
  const visible = rows.slice(-maxRows)
  return (
    <Box flexDirection="column" flexShrink={1}>
      {visible.map((row, i) => (
        <Box key={i}>
          <Txt {...(dim ? { tone: 'muted' as const } : {})}>{row === '' ? ' ' : row}</Txt>
          {i === visible.length - 1 && focus && <Txt inverse> </Txt>}
        </Box>
      ))}
    </Box>
  )
}
