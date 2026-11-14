import { Text } from 'ink'
import type { ReactNode } from 'react'
import { safeChildren } from './safe-text.ts'
import type { Token } from './theme.ts'
import { useTheme } from './theme-context.tsx'

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

const TOKEN: Record<Exclude<Tone, 'muted'>, Token> = {
  text: 'text',
  accent: 'accent',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  info: 'info',
  tool: 'tool',
  assistant: 'assistant-message',
}

export interface TxtProps {
  tone?: Tone
  bold?: boolean
  inverse?: boolean
  wrap?: 'wrap' | 'truncate-end' | 'truncate' | 'truncate-middle' | 'truncate-start'
  children?: ReactNode
}

/** Themed text: the only way a feature colours a word. */
export function Txt({ tone = 'text', bold, inverse, wrap, children }: TxtProps) {
  const t = useTheme()
  const color = tone === 'muted' ? t.muted() : t.fg(TOKEN[tone])
  return (
    <Text
      {...color}
      {...(bold === true ? { bold: true } : {})}
      {...(inverse === true ? { inverse: true } : {})}
      {...(wrap === undefined ? {} : { wrap })}
    >
      {safeChildren(children)}
    </Text>
  )
}
