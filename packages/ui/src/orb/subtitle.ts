import { cells } from '../text-width.ts'
import { subtitleRowsWith, wordWrapWith } from './wrap.ts'

/** Wrap text at spaces into rows of at most `width` cells; a word longer than a row is cut. */
export const wordWrap = (text: string, width: number): string[] => wordWrapWith(text, width, cells)

/** The newest `maxRows` wrapped rows of a text: what the subtitle shows. */
export const subtitleRows = (text: string, width: number, maxRows = 2): string[] =>
  subtitleRowsWith(text, width, cells, maxRows)

/** Centre a row inside `width` cells (left padding only; the row is not padded on the right). */
export function centerRow(text: string, width: number): string {
  return ' '.repeat(Math.max(0, Math.floor((width - cells(text)) / 2))) + text
}
