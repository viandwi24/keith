import { z } from 'zod'

/** Limits from docs/contracts/ui-blocks.md. */
export const UI_BLOCK_LIMITS = {
  /** Serialized size of one top-level block, in UTF-8 bytes. */
  maxBytes: 256 * 1024,
  /** A top-level block is depth 1; its children are depth 2. */
  maxDepth: 4,
  /** Rows in a `table` block. */
  maxTableRows: 200,
} as const

export const UI_BLOCK_ID_PATTERN = /^[a-z0-9_-]{1,64}$/

/** Block types every node with `ui.render@1` must render. */
export const STANDARD_BLOCK_TYPES = [
  'markdown',
  'card',
  'list',
  'table',
  'keyValue',
  'image',
  'actions',
  'stack',
] as const
export type StandardBlockType = (typeof STANDARD_BLOCK_TYPES)[number]

/** Every block type in the schema: the standard set plus the optional `html` block. */
export const UI_BLOCK_TYPES = [...STANDARD_BLOCK_TYPES, 'html'] as const
export type UiBlockType = (typeof UI_BLOCK_TYPES)[number]

// Types are written by hand because the schema is recursive (card.children, stack.children).

export type MarkdownBlock = { type: 'markdown'; id: string; text: string }
export type UiImageRef = { url: string; alt: string }
export type CardBlock = {
  type: 'card'
  id: string
  title: string
  subtitle?: string | undefined
  body?: string | undefined
  image?: UiImageRef | undefined
  footer?: string | undefined
  children?: UiBlock[] | undefined
}
export type ListItem = { title: string; subtitle?: string | undefined; meta?: string | undefined }
export type ListBlock = { type: 'list'; id: string; items: ListItem[]; ordered?: boolean | undefined }
export type TableColumn = { key: string; label: string; align?: 'left' | 'right' | 'center' | undefined }
export type TableBlock = {
  type: 'table'
  id: string
  columns: TableColumn[]
  rows: Record<string, string | number>[]
}
export type KeyValuePair = { key: string; value: string }
export type KeyValueBlock = { type: 'keyValue'; id: string; pairs: KeyValuePair[] }
export type ImageBlock = {
  type: 'image'
  id: string
  url: string
  alt: string
  width?: number | undefined
  height?: number | undefined
}
export type UiAction = {
  id: string
  label: string
  style?: 'primary' | 'secondary' | 'danger' | undefined
  value?: unknown
}
export type ActionsBlock = { type: 'actions'; id: string; actions: UiAction[] }
export type StackBlock = {
  type: 'stack'
  id: string
  direction: 'vertical' | 'horizontal'
  children: UiBlock[]
}
export type HtmlBlock = { type: 'html'; id: string; html: string; height?: number | undefined }

export type UiBlock =
  | MarkdownBlock
  | CardBlock
  | ListBlock
  | TableBlock
  | KeyValueBlock
  | ImageBlock
  | ActionsBlock
  | StackBlock
  | HtmlBlock

/** True for `https:` URLs, `data:image/*` URIs and core-relative `/v1/files/…` paths. */
export function isAllowedUiUrl(url: string): boolean {
  if (url.startsWith('/v1/files/')) return url.length > '/v1/files/'.length && !url.includes('..')
  if (url.startsWith('data:image/')) return true
  if (!url.startsWith('https:')) return false
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    // Not a parseable URL: reject it.
    return false
  }
}

const BlockId = z.string().regex(UI_BLOCK_ID_PATTERN, 'block id must match [a-z0-9_-]{1,64}')
const UiUrl = z.string().refine(isAllowedUiUrl, 'url must be https:, data:image/* or /v1/files/…')

const MarkdownBlockSchema = z.object({ type: z.literal('markdown'), id: BlockId, text: z.string() })

const CardBlockSchema = z.object({
  type: z.literal('card'),
  id: BlockId,
  title: z.string(),
  subtitle: z.string().optional(),
  body: z.string().optional(),
  image: z.object({ url: UiUrl, alt: z.string() }).optional(),
  footer: z.string().optional(),
  children: z.array(z.lazy(() => UiBlockShape)).optional(),
})

const ListBlockSchema = z.object({
  type: z.literal('list'),
  id: BlockId,
  items: z.array(
    z.object({ title: z.string(), subtitle: z.string().optional(), meta: z.string().optional() }),
  ),
  ordered: z.boolean().optional(),
})

const TableBlockSchema = z.object({
  type: z.literal('table'),
  id: BlockId,
  columns: z
    .array(
      z.object({
        key: z.string().min(1),
        label: z.string(),
        align: z.enum(['left', 'right', 'center']).optional(),
      }),
    )
    .min(1),
  rows: z
    .array(z.record(z.string(), z.union([z.string(), z.number()])))
    .max(UI_BLOCK_LIMITS.maxTableRows, `a table has at most ${UI_BLOCK_LIMITS.maxTableRows} rows`),
})

const KeyValueBlockSchema = z.object({
  type: z.literal('keyValue'),
  id: BlockId,
  pairs: z.array(z.object({ key: z.string(), value: z.string() })),
})

const Pixels = z.number().int().positive()

const ImageBlockSchema = z.object({
  type: z.literal('image'),
  id: BlockId,
  url: UiUrl,
  alt: z.string(),
  width: Pixels.optional(),
  height: Pixels.optional(),
})

const ActionsBlockSchema = z.object({
  type: z.literal('actions'),
  id: BlockId,
  actions: z
    .array(
      z.object({
        id: BlockId,
        label: z.string().min(1),
        style: z.enum(['primary', 'secondary', 'danger']).optional(),
        value: z.unknown().optional(),
      }),
    )
    .min(1),
})

const StackBlockSchema = z.object({
  type: z.literal('stack'),
  id: BlockId,
  direction: z.enum(['vertical', 'horizontal']),
  children: z.array(z.lazy(() => UiBlockShape)),
})

const HtmlBlockSchema = z.object({
  type: z.literal('html'),
  id: BlockId,
  html: z.string().min(1),
  height: Pixels.optional(),
})

/** The recursive shape without the whole-block limits. Internal: use `UiBlock`. */
const UiBlockShape: z.ZodType<UiBlock> = z.discriminatedUnion('type', [
  MarkdownBlockSchema,
  CardBlockSchema,
  ListBlockSchema,
  TableBlockSchema,
  KeyValueBlockSchema,
  ImageBlockSchema,
  ActionsBlockSchema,
  StackBlockSchema,
  HtmlBlockSchema,
])

function childrenOf(block: UiBlock): UiBlock[] {
  if (block.type === 'card') return block.children ?? []
  if (block.type === 'stack') return block.children
  return []
}

/** Nesting depth of a block tree. A block without children has depth 1. */
export function uiBlockDepth(block: UiBlock): number {
  return 1 + Math.max(0, ...childrenOf(block).map(uiBlockDepth))
}

function collectIds(block: UiBlock, into: string[]): string[] {
  into.push(block.id)
  for (const child of childrenOf(block)) collectIds(child, into)
  return into
}

/**
 * A UI block, validated with the limits from the contract: depth ≤ 4, serialized size ≤ 256 KB,
 * allowed URL schemes, and block ids unique within the tree.
 */
export const UiBlock: z.ZodType<UiBlock> = UiBlockShape.superRefine((block, ctx) => {
  const depth = uiBlockDepth(block)
  if (depth > UI_BLOCK_LIMITS.maxDepth) {
    ctx.addIssue({
      code: 'custom',
      message: `block nesting depth ${depth} exceeds ${UI_BLOCK_LIMITS.maxDepth}`,
    })
  }
  const bytes = new TextEncoder().encode(JSON.stringify(block)).length
  if (bytes > UI_BLOCK_LIMITS.maxBytes) {
    ctx.addIssue({
      code: 'custom',
      message: `block is ${bytes} bytes, more than ${UI_BLOCK_LIMITS.maxBytes}`,
    })
  }
  const ids = collectIds(block, [])
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i)
  if (duplicate !== undefined) ctx.addIssue({ code: 'custom', message: `duplicate block id '${duplicate}'` })
})
