import { Box, Text } from 'ink'
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react'
import { G } from './glyphs.ts'
import { type Hint, KeyHints } from './key-hints.tsx'
import { Rich } from './rich-text.tsx'
import { GUTTER } from './spacing.ts'
import { Txt } from './text.tsx'
import { useTheme } from './theme-context.tsx'

/** What the footer says: key hints, or one sentence (a confirmation) in `warning`. */
export type FooterContent = readonly Hint[] | string

interface Slot {
  override: FooterContent | undefined
  set(content: FooterContent | undefined): void
}

const Context = createContext<Slot>({ override: undefined, set: () => {} })

/** Holds the footer a screen asked for (`useFooter`); the app renders it with `<FooterRow>`. */
export function FooterProvider({ children }: { children: ReactNode }) {
  const [override, set] = useState<FooterContent | undefined>()
  const value = useMemo(() => ({ override, set }), [override])
  return <Context.Provider value={value}>{children}</Context.Provider>
}

/** The footer a screen asked for with `useFooter`, or `undefined` (a `ScreenFrame` host draws it as its legend). */
export function useFooterContent(): FooterContent | undefined {
  return useContext(Context).override
}

/** A screen or dialog sets the footer while it is mounted (and clears it on unmount). */
export function useFooter(content: FooterContent | undefined): void {
  const { set } = useContext(Context)
  const key = JSON.stringify(content ?? null)
  useEffect(() => {
    set(content)
    return () => set(undefined)
  }, [key, set])
}

/** A legend row: the hints (dropped by priority to fit `width`) or one sentence in `warning`. */
export function LegendRow({ content, width }: { content: FooterContent; width?: number }) {
  return typeof content === 'string' ? (
    <Rich text={content} tone="warning" />
  ) : (
    <KeyHints hints={content} {...(width === undefined ? {} : { width })} />
  )
}

/** A bare separator line `width` cells wide, dim, no text (above and below the chat input). */
export function Rule({ width }: { width: number }) {
  return (
    <Box width={width} flexShrink={0} height={1} overflow="hidden">
      <Txt tone="muted" wrap="truncate">
        {G.hrule.repeat(width)}
      </Txt>
    </Box>
  )
}

/**
 * A bare vertical separator one column wide and `height` rows high, in the `border` token (the colour
 * of the frames; no colour prop at all in `none` depth), between the conversation and the sidebar.
 */
export function VRule({ height }: { height: number }) {
  const theme = useTheme()
  return (
    <Box width={1} height={height} flexShrink={0} overflow="hidden">
      <Text {...theme.fg('border')} wrap="truncate">
        {Array.from({ length: height }, () => G.rule).join('\n')}
      </Text>
    </Box>
  )
}

/** The footer row: the override when a screen set one, else `fallback`. */
export function FooterRow({
  fallback,
  width,
}: {
  fallback: FooterContent
  /** Cells the legend may take (default: no fitting). */
  width?: number
}) {
  const { override } = useContext(Context)
  const content = override ?? fallback
  return (
    <Box paddingLeft={GUTTER} flexShrink={0}>
      <LegendRow content={content} {...(width === undefined ? {} : { width: width - GUTTER })} />
    </Box>
  )
}
