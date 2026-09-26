import { parseCoreFrame } from '../src/frames/core-to-node.ts'
import { parseNodeFrame } from '../src/frames/node-to-core.ts'
import { UiBlock } from '../src/ui/blocks.ts'

export type DocExample = { kind: 'frame' | 'block'; line: number; source: string }
export type DocExampleFailure = DocExample & { reason: string }

/** Extracts every ` ```json frame ` and ` ```json block ` fence from a markdown document. */
export function extractExamples(markdown: string): DocExample[] {
  const examples: DocExample[] = []
  const lines = markdown.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const open = /^```json (frame|block)\s*$/.exec(lines[i] ?? '')
    if (!open) continue
    const kind = open[1] as DocExample['kind']
    const body: string[] = []
    let j = i + 1
    while (j < lines.length && lines[j] !== '```') body.push(lines[j++] ?? '')
    examples.push({ kind, line: i + 1, source: body.join('\n') })
    i = j
  }
  return examples
}

/** Parses one example: a frame must parse in one direction (node → core or core → node). */
export function checkExample(example: DocExample): string | null {
  let value: unknown
  try {
    value = JSON.parse(example.source)
  } catch (error) {
    return `invalid JSON: ${(error as Error).message}`
  }
  if (example.kind === 'block') {
    const result = UiBlock.safeParse(value)
    return result.success ? null : result.error.issues.map((i) => i.message).join('; ')
  }
  const asNode = parseNodeFrame(value)
  if (asNode.ok) return null
  const asCore = parseCoreFrame(value)
  if (asCore.ok) return null
  return asNode.code === 'UNKNOWN_FRAME' ? asCore.message : asNode.message
}

/** Returns every example in the document that does not parse. */
export function checkDocExamples(markdown: string): DocExampleFailure[] {
  return extractExamples(markdown).flatMap((example) => {
    const reason = checkExample(example)
    return reason === null ? [] : [{ ...example, reason }]
  })
}
