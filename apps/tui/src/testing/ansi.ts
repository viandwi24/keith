const ESC = String.fromCharCode(27)

/** Every SGR sequence (colour, bold, dim, inverse). */
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')
/** SGR sequences that set a colour: 30-37, 38, 39, 40-47, 48, 49, 90-97, 100-107. */
const COLOUR = new RegExp(`${ESC}\\[(?:[0-9;]*;)?(?:3[0-9]|4[0-9]|9[0-7]|10[0-7])[;m]`)

/** The text without SGR codes: a coloured cursor cell must not split a word. */
export const stripAnsi = (text: string): string => text.replace(SGR, '')

/**
 * Does the text set a foreground or background colour? Bold, dim, inverse, and cursor moves
 * (`ESC [ 3 A` is "up 3 rows") are not colours: only an SGR sequence counts.
 */
export const hasColour = (text: string): boolean => COLOUR.test(text)
