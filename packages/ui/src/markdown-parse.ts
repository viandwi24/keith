/** The markdown subset of the terminal (tui-design 6.4), parsed without a dependency. */

export type Inline =
  | { t: 'text'; s: string }
  | { t: 'bold'; s: string }
  | { t: 'code'; s: string }
  | { t: 'link'; s: string; url: string }

export type Block =
  | { t: 'heading'; level: number; inline: Inline[] }
  | { t: 'para'; lines: Inline[][] }
  | { t: 'li'; marker: string; depth: number; inline: Inline[] }
  | { t: 'quote'; lines: Inline[][] }
  | { t: 'code'; lang: string; lines: string[] }
  | { t: 'table'; lines: string[] }

const INLINE = /(\*\*(.+?)\*\*)|(`([^`\n]+)`)|(!?\[([^\]\n]*)\]\(([^)\s]+)\))/g

/** `**bold**`, `` `code` ``, `[text](url)`; `_em_` stays plain, images show as their alt text. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0
    if (at > last) out.push({ t: 'text', s: text.slice(last, at) })
    if (m[2] !== undefined) out.push({ t: 'bold', s: m[2] })
    else if (m[4] !== undefined) out.push({ t: 'code', s: m[4] })
    else if (m[0].startsWith('!')) out.push({ t: 'text', s: m[6] || m[7] || '' })
    else out.push({ t: 'link', s: m[6] ?? '', url: m[7] ?? '' })
    last = at + m[0].length
  }
  if (last < text.length) out.push({ t: 'text', s: text.slice(last) })
  return out
}

const FENCE = /^\s*```\s*([\w+#.-]*)\s*$/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/
const TABLE = /^\s*\|.*\|?\s*$/

/** Blocks of a markdown text. An unclosed fence (a streaming answer) is a code block so far. */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const fence = FENCE.exec(line)
    if (fence !== null) {
      const body: string[] = []
      i++
      while (i < lines.length && !FENCE.test(lines[i] ?? '')) body.push(lines[i++] ?? '')
      i++ // the closing fence
      blocks.push({ t: 'code', lang: fence[1] ?? '', lines: body })
      continue
    }
    if (line.trim() === '') {
      i++
      continue
    }
    const heading = HEADING.exec(line)
    if (heading !== null) {
      blocks.push({
        t: 'heading',
        level: (heading[1] ?? '#').length,
        inline: parseInline(heading[2] ?? ''),
      })
      i++
      continue
    }
    const item = LIST.exec(line)
    if (item !== null) {
      const marker = /^\d/.test(item[2] ?? '') ? `${(item[2] ?? '').replace(/\)$/, '.')}` : '•'
      blocks.push({
        t: 'li',
        marker,
        depth: Math.floor((item[1] ?? '').length / 2),
        inline: parseInline(item[3] ?? ''),
      })
      i++
      continue
    }
    if (QUOTE.test(line)) {
      const quoted: Inline[][] = []
      while (i < lines.length && QUOTE.test(lines[i] ?? '')) {
        quoted.push(parseInline(QUOTE.exec(lines[i] ?? '')?.[1] ?? ''))
        i++
      }
      blocks.push({ t: 'quote', lines: quoted })
      continue
    }
    if (TABLE.test(line)) {
      const rows: string[] = []
      while (i < lines.length && TABLE.test(lines[i] ?? '')) rows.push(lines[i++] ?? '')
      blocks.push({ t: 'table', lines: rows })
      continue
    }
    const para: Inline[][] = []
    while (i < lines.length) {
      const l = lines[i] ?? ''
      if (
        l.trim() === '' ||
        FENCE.test(l) ||
        HEADING.test(l) ||
        LIST.test(l) ||
        QUOTE.test(l) ||
        TABLE.test(l)
      )
        break
      para.push(parseInline(l))
      i++
    }
    blocks.push({ t: 'para', lines: para })
  }
  return blocks
}
