// Cuts streamed reply text into pieces for TTS: sentences, newlines, and a length cap.
// No NLP: a boundary is `.`, `!` or `?` (plus closing quotes/brackets) followed by whitespace, or a
// newline. The pieces partition the pushed text exactly, whitespace included, so the characters
// of the pieces that were spoken add up to `spokenChars`.

/** A piece longer than this is cut at the last space before it (or hard, without one). */
export const DEFAULT_MAX_SENTENCE_CHARS = 240

const BOUNDARY = /[.!?]+["'’”)\]]*\s+|\n\s*/

export interface SentenceSplitter {
  /** Adds text; returns the pieces that are now complete, in order. */
  push(text: string): string[]
  /** No more text: returns what is left (at most one piece). */
  flush(): string[]
}

export function createSentenceSplitter(maxChars = DEFAULT_MAX_SENTENCE_CHARS): SentenceSplitter {
  let buffer = ''

  const take = (): string | null => {
    const match = BOUNDARY.exec(buffer)
    // A boundary whose whitespace reaches the end of the buffer may still grow; that is fine,
    // the next piece then starts with the rest of the whitespace.
    if (match && match.index + match[0].length <= maxChars) {
      const end = match.index + match[0].length
      const piece = buffer.slice(0, end)
      buffer = buffer.slice(end)
      return piece
    }
    if (buffer.length >= maxChars) {
      const space = buffer.lastIndexOf(' ', maxChars - 1)
      const end = space >= maxChars / 2 ? space + 1 : maxChars
      const piece = buffer.slice(0, end)
      buffer = buffer.slice(end)
      return piece
    }
    return null
  }

  return {
    push(text) {
      buffer += text
      const out: string[] = []
      for (let piece = take(); piece !== null; piece = take()) out.push(piece)
      return out
    },
    flush() {
      const out: string[] = []
      for (let piece = take(); piece !== null; piece = take()) out.push(piece)
      if (buffer.length > 0) out.push(buffer)
      buffer = ''
      return out
    },
  }
}
