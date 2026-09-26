import type { UiBlock } from './blocks.ts'

/**
 * Plain-text rendering of a UI block, used as `fallbackText` when a tool gives none and by nodes
 * that cannot render a block. Pure and deterministic.
 */
export function uiBlockToText(block: UiBlock): string {
  return render(block).trimEnd()
}

function render(block: UiBlock): string {
  switch (block.type) {
    case 'markdown':
      return block.text
    case 'card': {
      const lines = [block.subtitle ? `${block.title} (${block.subtitle})` : block.title]
      if (block.body) lines.push(block.body)
      if (block.image) lines.push(imageText(block.image.alt))
      for (const child of block.children ?? []) lines.push(render(child))
      if (block.footer) lines.push(block.footer)
      return lines.join('\n')
    }
    case 'list':
      return block.items
        .map((item, i) => {
          const marker = block.ordered ? `${i + 1}.` : '-'
          const subtitle = item.subtitle ? ` — ${item.subtitle}` : ''
          const meta = item.meta ? ` (${item.meta})` : ''
          return `${marker} ${item.title}${subtitle}${meta}`
        })
        .join('\n')
    case 'table': {
      const header = block.columns.map((c) => c.label).join(' | ')
      const rows = block.rows.map((row) => block.columns.map((c) => String(row[c.key] ?? '')).join(' | '))
      return [header, ...rows].join('\n')
    }
    case 'keyValue':
      return block.pairs.map((p) => `${p.key}: ${p.value}`).join('\n')
    case 'image':
      return imageText(block.alt)
    case 'actions':
      return block.actions.map((a) => `[${a.label}]`).join(' ')
    case 'stack':
      return block.children.map(render).join(block.direction === 'horizontal' ? ' · ' : '\n')
    case 'html':
      return '[interactive content]'
  }
}

function imageText(alt: string): string {
  return alt ? `[image: ${alt}]` : '[image]'
}
