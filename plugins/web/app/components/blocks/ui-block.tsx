import type { UiBlockEntry } from '@keith/client'
import type {
  ActionsBlock,
  CardBlock,
  HtmlBlock,
  ImageBlock,
  KeyValueBlock,
  ListBlock,
  StackBlock,
  TableBlock,
  UiAction,
  UiBlock,
} from '@keith/protocol'
import { uiBlockToText } from '@keith/protocol'
import { cn } from 'cn'
import { useState } from 'react'
import { useImageSrc } from '../../hooks/use-image-src.ts'
import { Markdown } from '../markdown.tsx'
import { Button } from '../ui/button.tsx'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../ui/card.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table.tsx'
import { useBlockEnv } from './block-context.tsx'

/**
 * Renders UI blocks (docs/contracts/ui-blocks.md) with the app's shadcn/ui components and theme
 * tokens: one renderer per standard type, `html` in a sandboxed iframe, and the fallback text for
 * anything this renderer does not know.
 */

/** The only sandbox the `html` block gets: scripts run, but never with the app's origin. */
export const HTML_SANDBOX = 'allow-scripts'

const DEFAULT_HTML_HEIGHT = 240

type BlockProps<B> = { block: B; messageId: string | undefined }

/** A top-level block with its fallback text (from `ui.render`, or derived for history). */
export function UiBlockView({ entry, messageId }: { entry: UiBlockEntry; messageId: string | undefined }) {
  return (
    <div data-slot="ui-block" data-block-id={entry.block.id} data-block-type={entry.block.type}>
      <BlockView block={entry.block} messageId={messageId} fallbackText={entry.fallbackText} />
    </div>
  )
}

function BlockView({
  block,
  messageId,
  fallbackText,
}: BlockProps<UiBlock> & { fallbackText?: string | undefined }) {
  switch (block.type) {
    case 'markdown':
      return <Markdown text={block.text} />
    case 'card':
      return <CardView block={block} messageId={messageId} />
    case 'list':
      return <ListView block={block} />
    case 'table':
      return <TableView block={block} />
    case 'keyValue':
      return <KeyValueView block={block} />
    case 'image':
      return <ImageView block={block} />
    case 'actions':
      return <ActionsView block={block} messageId={messageId} />
    case 'stack':
      return <StackView block={block} messageId={messageId} />
    case 'html':
      return <HtmlView block={block} />
    default:
      return <FallbackView text={fallbackText ?? fallbackFor(block)} />
  }
}

/** Text for a block this renderer does not know (a newer core may send more types). */
function fallbackFor(block: unknown): string {
  try {
    return uiBlockToText(block as UiBlock)
  } catch {
    return '[unsupported content]'
  }
}

export function FallbackView({ text }: { text: string }) {
  return (
    <p data-slot="ui-fallback" className="text-sm whitespace-pre-wrap text-muted-foreground">
      {text}
    </p>
  )
}

function Children({ blocks, messageId }: { blocks: UiBlock[]; messageId: string | undefined }) {
  return blocks.map((child) => <BlockView key={child.id} block={child} messageId={messageId} />)
}

function CardView({ block, messageId }: BlockProps<CardBlock>) {
  return (
    <Card>
      {block.image ? <BlockImage url={block.image.url} alt={block.image.alt} /> : null}
      <CardHeader>
        <CardTitle>{block.title}</CardTitle>
        {block.subtitle ? <CardDescription>{block.subtitle}</CardDescription> : null}
      </CardHeader>
      {block.body || block.children?.length ? (
        <CardContent className="flex flex-col gap-3">
          {block.body ? <Markdown text={block.body} /> : null}
          {block.children ? <Children blocks={block.children} messageId={messageId} /> : null}
        </CardContent>
      ) : null}
      {block.footer ? (
        <CardFooter className="text-xs text-muted-foreground">{block.footer}</CardFooter>
      ) : null}
    </Card>
  )
}

function ListView({ block }: { block: ListBlock }) {
  const Tag = block.ordered ? 'ol' : 'ul'
  return (
    <Tag className="flex flex-col divide-y rounded-lg border text-sm">
      {block.items.map((item, i) => (
        <li key={i} className="flex items-baseline gap-3 px-3 py-2">
          {block.ordered ? <span className="text-muted-foreground tabular-nums">{i + 1}.</span> : null}
          <div className="min-w-0 flex-1">
            <div className="font-medium">{item.title}</div>
            {item.subtitle ? <div className="text-muted-foreground">{item.subtitle}</div> : null}
          </div>
          {item.meta ? <div className="shrink-0 text-xs text-muted-foreground">{item.meta}</div> : null}
        </li>
      ))}
    </Tag>
  )
}

const ALIGN = { left: 'text-left', right: 'text-right', center: 'text-center' } as const

function TableView({ block }: { block: TableBlock }) {
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            {block.columns.map((col) => (
              <TableHead key={col.key} className={ALIGN[col.align ?? 'left']}>
                {col.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {block.rows.map((row, i) => (
            <TableRow key={i}>
              {block.columns.map((col) => (
                <TableCell key={col.key} className={ALIGN[col.align ?? 'left']}>
                  {row[col.key] ?? ''}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function KeyValueView({ block }: { block: KeyValueBlock }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      {block.pairs.map((pair, i) => (
        <div key={i} className="contents">
          <dt className="text-muted-foreground">{pair.key}</dt>
          <dd className="font-medium">{pair.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function ImageView({ block }: { block: ImageBlock }) {
  return <BlockImage url={block.url} alt={block.alt} width={block.width} height={block.height} />
}

function BlockImage({
  url,
  alt,
  width,
  height,
}: {
  url: string
  alt: string
  width?: number | undefined
  height?: number | undefined
}) {
  const { files } = useBlockEnv()
  const image = useImageSrc(url, files)
  if (image.status !== 'ready') {
    return (
      <div
        data-slot="ui-image-placeholder"
        className="flex min-h-16 items-center justify-center rounded-lg bg-muted px-3 py-4 text-xs text-muted-foreground"
        style={{ ...(width ? { width } : {}), ...(height ? { height } : {}) }}
      >
        {image.status === 'loading' ? 'loading image…' : alt ? `[image: ${alt}]` : '[image]'}
      </div>
    )
  }
  return (
    <img
      src={image.src}
      alt={alt}
      width={width}
      height={height}
      loading="lazy"
      referrerPolicy="no-referrer"
      className="max-w-full rounded-lg object-contain"
    />
  )
}

const ACTION_VARIANT = { primary: 'default', secondary: 'outline', danger: 'destructive' } as const

function ActionsView({ block, messageId }: BlockProps<ActionsBlock>) {
  const env = useBlockEnv()
  const [error, setError] = useState<string | null>(null)
  const click = (action: UiAction) => {
    if (!messageId) return
    setError(
      env.sendAction({
        messageId,
        blockId: block.id,
        actionId: action.id,
        ...('value' in action ? { value: action.value } : {}),
      }),
    )
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-2">
        {block.actions.map((action) => (
          <Button
            key={action.id}
            type="button"
            size="sm"
            variant={ACTION_VARIANT[action.style ?? 'secondary']}
            disabled={!messageId}
            title={messageId ? undefined : 'This block is not attached to a message'}
            data-action-id={action.id}
            onClick={() => click(action)}
          >
            {action.label}
          </Button>
        ))}
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  )
}

function StackView({ block, messageId }: BlockProps<StackBlock>) {
  return (
    <div
      className={cn(
        'flex gap-3',
        block.direction === 'horizontal' ? 'flex-row flex-wrap items-start' : 'flex-col',
      )}
    >
      <Children blocks={block.children} messageId={messageId} />
    </div>
  )
}

function HtmlView({ block }: { block: HtmlBlock }) {
  return (
    <iframe
      title={`interactive content ${block.id}`}
      sandbox={HTML_SANDBOX}
      srcDoc={block.html}
      referrerPolicy="no-referrer"
      loading="lazy"
      className="w-full rounded-lg border bg-background"
      style={{ height: block.height ?? DEFAULT_HTML_HEIGHT }}
    />
  )
}
