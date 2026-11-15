// Ink-free colour tables and glyphs (`@keith/ui/tokens`): the web client reads them without Ink or React.
export { G } from './glyphs.ts'

export type ThemeName = 'dark' | 'light'

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

export interface Swatch {
  hex: string
  ansi: number
}

export const DARK: Record<Token, Swatch> = {
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

export const LIGHT: Record<Token, Swatch> = {
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
