// Markdown as a tree of plain nodes for Svelte components (docs/specs/web.md, "Chat"). The parse is `@keith/ui/markdown` (the
// terminal's subset, no dependency); this module groups list items into lists, splits tables into cells and checks every link.
// Nothing here makes HTML: a component draws each node as elements, so model output never reaches `{@html}`.
import { type Block, type Inline, parseMarkdown } from '@keith/ui/markdown'

export type InlineNode =
  | { t: 'text'; s: string }
  | { t: 'bold'; s: string }
  | { t: 'code'; s: string }
  /** `href` is undefined for a link the page does not follow (only http, https and mailto are); then it shows as text. */
  | { t: 'link'; s: string; href: string | undefined }

export interface ListItemNode {
  inline: InlineNode[]
  children: ListNode[]
}

export interface ListNode {
  t: 'list'
  ordered: boolean
  items: ListItemNode[]
}

export type TableAlign = 'left' | 'center' | 'right'

export type MdNode =
  | { t: 'heading'; level: number; inline: InlineNode[] }
  | { t: 'para'; lines: InlineNode[][] }
  | ListNode
  | { t: 'quote'; lines: InlineNode[][] }
  | { t: 'code'; lang: string; text: string }
  | { t: 'table'; head: InlineNode[][]; align: TableAlign[]; rows: InlineNode[][][] }

const SAFE_LINK = /^(?:https?:\/\/|mailto:)/i

/** The URL of a link when the page may follow it: http, https or mailto; never `javascript:` or `data:`. */
export function safeHref(url: string): string | undefined {
  const trimmed = url.trim()
  return SAFE_LINK.test(trimmed) ? trimmed : undefined
}

export function inlineNodes(inline: readonly Inline[]): InlineNode[] {
  return inline.map((part): InlineNode => {
    if (part.t === 'link') return { t: 'link', s: part.s || part.url, href: safeHref(part.url) }
    return part
  })
}

const SEPARATOR_CELL = /^\s*:?-{1,}:?\s*$/

/** The cells of one table row: the outer pipes are dropped and an escaped pipe stays in its cell. */
export function cellsOf(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return body.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim())
}

function alignOf(cell: string): TableAlign {
  const t = cell.trim()
  if (t.startsWith(':') && t.endsWith(':')) return 'center'
  return t.endsWith(':') ? 'right' : 'left'
}

function tableOf(lines: readonly string[]): MdNode {
  const parsed = lines.map(cellsOf)
  const separator = parsed[1]
  const hasHead = separator?.every((c) => SEPARATOR_CELL.test(c))
  const head = hasHead ? (parsed[0] ?? []) : []
  const align = hasHead ? (separator ?? []).map(alignOf) : []
  const body = hasHead ? parsed.slice(2) : parsed
  const cell = (text: string): InlineNode[] => inlineNodes(flat(text))
  return {
    t: 'table',
    head: head.map(cell),
    align,
    rows: body.map((row) => row.map(cell)),
  }
}

/** One line of text as inline nodes (a table cell). */
function flat(text: string): Inline[] {
  const first = parseMarkdown(text)[0]
  return first?.t === 'para' ? (first.lines[0] ?? []) : [{ t: 'text', s: text }]
}

/** Consecutive list items become lists: a deeper item opens a child list under the item before it. */
function listsOf(items: readonly Extract<Block, { t: 'li' }>[]): ListNode {
  const root: ListNode = { t: 'list', ordered: items[0]?.marker !== '•', items: [] }
  const stack: ListNode[] = [root]
  const depths: number[] = [items[0]?.depth ?? 0]
  for (const item of items) {
    let depth = item.depth
    while (stack.length > 1 && depth < (depths[stack.length - 1] ?? 0)) {
      stack.pop()
      depths.pop()
    }
    const top = depths[stack.length - 1] ?? 0
    if (depth > top) {
      const parent = stack[stack.length - 1]?.items.at(-1)
      if (parent !== undefined) {
        const child: ListNode = { t: 'list', ordered: item.marker !== '•', items: [] }
        parent.children.push(child)
        stack.push(child)
        depths.push(depth)
      } else depth = top
    }
    stack[stack.length - 1]?.items.push({ inline: inlineNodes(item.inline), children: [] })
  }
  return root
}

/** The nodes of a Markdown text. An unclosed fence (a streaming answer) is a code block so far. */
export function markdownNodes(source: string): MdNode[] {
  const out: MdNode[] = []
  const blocks = parseMarkdown(source)
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i] as Block
    switch (block.t) {
      case 'heading':
        out.push({ t: 'heading', level: block.level, inline: inlineNodes(block.inline) })
        break
      case 'para':
        out.push({ t: 'para', lines: block.lines.map(inlineNodes) })
        break
      case 'quote':
        out.push({ t: 'quote', lines: block.lines.map(inlineNodes) })
        break
      case 'code':
        out.push({ t: 'code', lang: block.lang, text: block.lines.join('\n') })
        break
      case 'table':
        out.push(tableOf(block.lines))
        break
      case 'li': {
        const run: Extract<Block, { t: 'li' }>[] = [block]
        while (blocks[i + 1]?.t === 'li') run.push(blocks[++i] as Extract<Block, { t: 'li' }>)
        out.push(listsOf(run))
        break
      }
    }
  }
  return out
}
