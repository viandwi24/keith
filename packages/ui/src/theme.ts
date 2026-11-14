export type ThemeName = 'dark' | 'light'
export type ColorDepth = 'truecolor' | '256' | '16' | 'none'

/** Semantic colour tokens (tui-design section 2). Features never name a colour. */
export type Token =
  | 'bg'
  | 'border'
  | 'text'
  | 'text-muted'
  | 'accent'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'user-message'
  | 'assistant-message'
  | 'tool'
  | 'orb-idle'
  | 'orb-thinking'
  | 'orb-speaking'
  | 'region-wernicke'
  | 'region-hippocampus'
  | 'region-parietal'
  | 'region-hypothalamus'
  | 'region-corpus-callosum'
  | 'region-prefrontal'

interface Swatch {
  hex: string
  ansi: number
}

const DARK: Record<Token, Swatch> = {
  bg: { hex: '#16181d', ansi: 234 },
  border: { hex: '#363b47', ansi: 237 },
  text: { hex: '#d5d8df', ansi: 253 },
  'text-muted': { hex: '#8990a0', ansi: 245 },
  accent: { hex: '#8ab4f8', ansi: 111 },
  success: { hex: '#8ccf9a', ansi: 114 },
  warning: { hex: '#e3c07c', ansi: 180 },
  danger: { hex: '#ec8a8f', ansi: 210 },
  info: { hex: '#7fc4d4', ansi: 116 },
  'user-message': { hex: '#22252c', ansi: 235 },
  'assistant-message': { hex: '#d5d8df', ansi: 253 },
  tool: { hex: '#a4abba', ansi: 145 },
  'orb-idle': { hex: '#d4d4d4', ansi: 252 },
  'orb-thinking': { hex: '#a5b4fc', ansi: 147 },
  'orb-speaking': { hex: '#ffffff', ansi: 231 },
  'region-wernicke': { hex: '#c4b5fd', ansi: 183 },
  'region-hippocampus': { hex: '#f472b6', ansi: 205 },
  'region-parietal': { hex: '#ffa366', ansi: 215 },
  'region-hypothalamus': { hex: '#facc15', ansi: 220 },
  'region-corpus-callosum': { hex: '#5eead4', ansi: 115 },
  'region-prefrontal': { hex: '#a3e635', ansi: 149 },
}

const LIGHT: Record<Token, Swatch> = {
  bg: { hex: '#fafafa', ansi: 231 },
  border: { hex: '#c8ccd3', ansi: 252 },
  text: { hex: '#23272e', ansi: 235 },
  'text-muted': { hex: '#616877', ansi: 243 },
  accent: { hex: '#2563c9', ansi: 26 },
  success: { hex: '#2c7a4b', ansi: 29 },
  warning: { hex: '#946200', ansi: 94 },
  danger: { hex: '#c0363e', ansi: 124 },
  info: { hex: '#1d7488', ansi: 30 },
  'user-message': { hex: '#e8eaee', ansi: 254 },
  'assistant-message': { hex: '#23272e', ansi: 235 },
  tool: { hex: '#4f5665', ansi: 240 },
  'orb-idle': { hex: '#4b5563', ansi: 240 },
  'orb-thinking': { hex: '#4f5fd6', ansi: 62 },
  'orb-speaking': { hex: '#111318', ansi: 233 },
  'region-wernicke': { hex: '#6d4fc9', ansi: 98 },
  'region-hippocampus': { hex: '#c02679', ansi: 162 },
  'region-parietal': { hex: '#b35c00', ansi: 130 },
  'region-hypothalamus': { hex: '#8a6100', ansi: 136 },
  'region-corpus-callosum': { hex: '#0f766e', ansi: 23 },
  'region-prefrontal': { hex: '#4d7c0f', ansi: 64 },
}

export const PALETTES: Record<ThemeName, Record<Token, Swatch>> = { dark: DARK, light: LIGHT }

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
