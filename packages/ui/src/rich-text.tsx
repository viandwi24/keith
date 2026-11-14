import { Text } from 'ink'
import type { ReactNode } from 'react'
import { type Tone, Txt } from './text.tsx'
import { useTheme } from './theme-context.tsx'

/** `/command` words (not paths like `/memories/x`) outside backticks. */
const COMMAND = /(?<=^|\s)\/[a-z][a-z-]*(?![\w/-]|\.\w)/g

/**
 * Text where commands and hints are `accent`: a backtick pair marks a command, and a bare
 * `/word` is one too. Where colour is off the backticks stay, so the command is still marked.
 */
export function Rich({ text, tone = 'text' }: { text: string; tone?: Tone }) {
  const t = useTheme()
  const keepTicks = t.depth === 'none'
  const parts = text.split('`')
  return (
    <Text>
      {parts.map((part, i) => {
        // an odd count of backticks leaves the last piece unmatched: it stays plain
        const quoted = i % 2 === 1 && i < parts.length - 1
        if (quoted) {
          return (
            <Txt key={i} tone="accent">
              {keepTicks ? `\`${part}\`` : part}
            </Txt>
          )
        }
        const plain = i % 2 === 1 ? `\`${part}` : part
        const out: ReactNode[] = []
        let last = 0
        for (const m of plain.matchAll(COMMAND)) {
          const at = m.index ?? 0
          if (at > last) out.push(plain.slice(last, at))
          out.push(
            <Txt key={`${i}:${at}`} tone="accent">
              {m[0]}
            </Txt>,
          )
          last = at + m[0].length
        }
        if (last < plain.length) out.push(plain.slice(last))
        return (
          <Txt key={i} tone={tone}>
            {out}
          </Txt>
        )
      })}
    </Text>
  )
}
