import { type Tone, Txt } from './text.tsx'

export interface BadgeProps {
  glyph: string
  tone: Tone
  label?: string
  /** The word is muted and only the glyph carries the tone (`● live`). */
  quietLabel?: boolean
}

/** A glyph and a word in a tone: `● live`, `✕ logged out`, `◐ Cortex ×2`. */
export function Badge({ glyph, tone, label, quietLabel = false }: BadgeProps) {
  return (
    <>
      <Txt tone={tone}>{glyph}</Txt>
      {label !== undefined && <Txt tone={quietLabel ? 'muted' : tone}> {label}</Txt>}
    </>
  )
}
