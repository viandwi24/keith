import { Box, Text } from 'ink'
import { G } from './glyphs.ts'
import { type Block, type Inline, parseMarkdown } from './markdown-parse.ts'
import { stripControl } from './safe-text.ts'
import { Txt } from './text.tsx'
import { cells } from './text-width.ts'
import { useTheme } from './theme-context.tsx'

/** A fenced block longer than this shows `SHOWN` lines and `… n more lines`. */
const CODE_LIMIT = 30
const CODE_SHOWN = 25

function Inlines({ parts, bold = false }: { parts: readonly Inline[]; bold?: boolean }) {
  const t = useTheme()
  return (
    <>
      {parts.map((p, i) => {
        const key = i
        if (p.t === 'bold') {
          return (
            <Txt key={key} tone="assistant" bold>
              {p.s}
            </Txt>
          )
        }
        if (p.t === 'code') {
          // no paint behind code: an accent word in colour, backticks where colour is off
          return t.depth === 'none' ? (
            <Txt key={key} tone="assistant">{`\`${p.s}\``}</Txt>
          ) : (
            <Txt key={key} tone="accent">
              {p.s}
            </Txt>
          )
        }
        if (p.t === 'link') {
          return (
            <Txt key={key} tone="assistant" {...(bold ? { bold: true } : {})}>
              {p.s}
              <Txt tone="muted">{` (${p.url})`}</Txt>
            </Txt>
          )
        }
        return (
          <Txt key={key} tone="assistant" {...(bold ? { bold: true } : {})}>
            {p.s}
          </Txt>
        )
      })}
    </>
  )
}

function CodeBlock({
  lang,
  lines,
  width,
}: {
  lang: string
  lines: readonly string[]
  width: number
}) {
  const hidden = lines.length > CODE_LIMIT ? lines.length - CODE_SHOWN : 0
  const shown = hidden > 0 ? lines.slice(0, CODE_SHOWN) : lines
  const gutter = (
    <Box flexShrink={0}>
      <Txt tone="muted">{G.rule} </Txt>
    </Box>
  )
  return (
    <Box width={width} flexDirection="column">
      {lang !== '' && (
        <Box justifyContent="flex-end">
          <Txt tone="muted">{lang}</Txt>
        </Box>
      )}
      {shown.map((line, i) => (
        <Box key={i}>
          {gutter}
          <Txt tone="assistant" wrap="truncate-end">
            {line === '' ? ' ' : line}
          </Txt>
        </Box>
      ))}
      {hidden > 0 && (
        <Box>
          {gutter}
          <Txt tone="muted">{`${G.ellipsis} ${hidden} more lines`}</Txt>
        </Box>
      )}
    </Box>
  )
}

function BlockView({ block, width }: { block: Block; width: number }) {
  if (block.t === 'heading') {
    return (
      <Text>
        <Inlines parts={block.inline} bold />
      </Text>
    )
  }
  if (block.t === 'para') {
    return (
      <Box flexDirection="column">
        {block.lines.map((line, i) => (
          <Text key={i}>
            <Inlines parts={line} />
          </Text>
        ))}
      </Box>
    )
  }
  if (block.t === 'li') {
    return (
      <Box paddingLeft={block.depth * 2 + 2}>
        <Box flexShrink={0} width={block.marker.length + 1}>
          <Txt tone="assistant">{block.marker}</Txt>
        </Box>
        <Box flexShrink={1}>
          <Text>
            <Inlines parts={block.inline} />
          </Text>
        </Box>
      </Box>
    )
  }
  if (block.t === 'quote') {
    return (
      <Box>
        <Box flexShrink={0}>
          <Txt tone="muted">{G.rule} </Txt>
        </Box>
        <Box flexDirection="column" flexShrink={1}>
          {block.lines.map((line, i) => (
            <Text key={i}>
              <Inlines parts={line} />
            </Text>
          ))}
        </Box>
      </Box>
    )
  }
  if (block.t === 'table') {
    const fits = block.lines.every((l) => cells(l) <= width)
    return fits ? (
      <Box flexDirection="column">
        {block.lines.map((l, i) => (
          <Txt key={i} tone="assistant">
            {l}
          </Txt>
        ))}
      </Box>
    ) : (
      <CodeBlock lang="" lines={block.lines} width={width} />
    )
  }
  return <CodeBlock lang={block.lang} lines={block.lines} width={width} />
}

/** Terminal markdown: headings bold, bullets, inline code, fenced blocks on `surface`. */
export function Markdown({ text, width }: { text: string; width: number }) {
  const blocks = parseMarkdown(stripControl(text, { newlines: true }))
  return (
    <Box flexDirection="column" width={width}>
      {blocks.map((block, i) => (
        <Box
          key={i}
          flexDirection="column"
          marginTop={i === 0 || (block.t === 'li' && blocks[i - 1]?.t === 'li') ? 0 : 1}
        >
          <BlockView block={block} width={width} />
        </Box>
      ))}
    </Box>
  )
}
