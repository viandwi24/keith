/**
 * Make server-supplied text inert before it is drawn. Twin of `packages/cli/src/sanitize.ts` (no workspace
 * imports in either package); both tests run the same table of cases.
 */

// Patterns are built from source strings through `rx`: a literal `new RegExp('...')` gets rewritten back to a
// regex literal by biome (useRegexLiterals), and biome then flags the control characters in it.
const rx = (source: string) => new RegExp(source, 'g')
const OSC_LIKE = rx('\\u001b[\\]PX^_][\\s\\S]*?(?:\\u0007|\\u001b\\\\|$)')
const CSI = rx('\\u001b\\[[0-?]*[ -/]*[@-~]?')
/** C1 CSI (U+009B), the one-byte form of ESC [: its parameters and final byte go with it. */
const C1_CSI = rx('\\u009b[0-?]*[ -/]*[@-~]?')
const ESC_PAIR = rx('\\u001b[\\s\\S]?')
const C1_STRING = rx('\\u009d[\\s\\S]*?(?:\\u0007|\\u009c|$)')
const BIDI = /[‪-‮⁦-⁩]/g
/** C0 and C1 controls except `\n` (kept with `newlines: true`). */
const CONTROL_KEEP_NEWLINES = rx('[\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f]')
/** Every C0 and C1 control. */
const CONTROL_ALL = rx('[\\u0000-\\u001f\\u007f-\\u009f]')

/**
 * Remove C0 and C1 controls, ESC sequences (CSI, OSC including OSC 52, DCS), DEL and bidirectional
 * overrides. `\n` stays only with `{ newlines: true }`; otherwise it becomes a space. `\r` never stays.
 */
export function stripControl(text: string, options: { newlines?: boolean } = {}): string {
  const keepNewlines = options.newlines === true
  return text
    .replace(OSC_LIKE, '')
    .replace(C1_STRING, '')
    .replace(CSI, '')
    .replace(C1_CSI, '')
    .replace(ESC_PAIR, '')
    .replace(BIDI, '')
    .replace(/\r\n?|\n/g, keepNewlines ? '\n' : ' ')
    .replace(keepNewlines ? CONTROL_KEEP_NEWLINES : CONTROL_ALL, (c) => (c === '\t' ? ' ' : ''))
}

/** Strip every string inside a React children value (strings and arrays of them); elements pass through. */
export function safeChildren<T>(children: T, newlines = true): T {
  if (typeof children === 'string') return stripControl(children, { newlines }) as T
  if (Array.isArray(children)) return children.map((c) => safeChildren(c, newlines)) as T
  return children
}
