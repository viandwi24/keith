import { PALETTES, type ThemeName, type Token } from './tokens.ts'

export type { ThemeName, Token }
export { PALETTES }

export type ColorDepth = 'truecolor' | '256' | '16' | 'none'

/** `bg` is the background the palette was tuned against (the orb fades toward it): never painted, so it resolves to nothing in 16 and none depth. */
const BACKGROUNDS: ReadonlySet<Token> = new Set<Token>(['bg'])

/** 16-colour names; a token missing here is unset (the terminal's own foreground). */
const SIXTEEN: Partial<Record<Token, string>> = {
  'text-muted': 'gray',
  border: 'gray',
  accent: 'blue',
  success: 'green',
  warning: 'yellow',
  danger: 'red',
  info: 'cyan',
  'orb-thinking': 'blue',
  'region-wernicke': 'magenta',
  'region-hippocampus': 'magenta',
  'region-parietal': 'blue',
  'region-hypothalamus': 'yellow',
  'region-corpus-callosum': 'green',
  'region-prefrontal': 'white',
}

export type ColorProps = { color?: string }
export type BgProps = { backgroundColor?: string }

export interface Theme {
  name: ThemeName
  depth: ColorDepth
  /** The colour a token resolves to at this depth, or `undefined` when it resolves to nothing. */
  color(token: Token): string | undefined
  /** `{ color }` for a foreground token, `{}` when unset (spread it into a `Text`). */
  fg(token: Token): ColorProps
  /** `{ backgroundColor }` for a fill token, `{}` when unset. Only `user-message` is ever painted (tui-design section 2). */
  bg(token: Token): BgProps
  /** Muted text: `dimColor` in none depth (the only tool there), else the muted colour. */
  muted(): ColorProps | { dimColor: true }
}

/** Pure: the tokens of a theme at a colour depth. */
export function resolveTheme({ theme, depth }: { theme: ThemeName; depth: ColorDepth }): Theme {
  const palette = PALETTES[theme]
  const color = (token: Token): string | undefined => {
    if (depth === 'none') return undefined
    if (depth === 'truecolor') return palette[token].hex
    if (depth === '256') return `ansi256(${palette[token].ansi})`
    return BACKGROUNDS.has(token) ? undefined : SIXTEEN[token]
  }
  return {
    name: theme,
    depth,
    color,
    fg: (token) => {
      const c = color(token)
      return c === undefined ? {} : { color: c }
    },
    bg: (token) => {
      const c = color(token)
      return c === undefined ? {} : { backgroundColor: c }
    },
    muted() {
      return depth === 'none' ? { dimColor: true } : this.fg('text-muted')
    },
  }
}
