import { afterEach, describe, expect, test } from 'bun:test'
import { Field } from './field.tsx'
import { ListRow } from './list-row.tsx'
import { Markdown } from './markdown.tsx'
import { cleanup } from './testing/render.ts'
import { show } from './testing/show.tsx'
import { Txt } from './text.tsx'

afterEach(cleanup)

const HOSTILE = 'lap\u001b[2Jtop\u001b]52;c;aGk=\u0007‮'

describe('server text is drawn inert', () => {
  test('Txt, ListRow, Field and Markdown draw no escape sequence', async () => {
    const view = (node: React.ReactElement) => show(node, { columns: 40, depth: 'none' })
    for (const node of [
      <Txt>{HOSTILE}</Txt>,
      <ListRow columns={[{ text: HOSTILE }]} width={30} />,
      <Field label="Label" value={HOSTILE} focused={false} width={30} />,
      <Markdown text={HOSTILE} width={30} />,
    ]) {
      const frame = (await view(node)).frame()
      expect(frame).toContain('laptop')
      expect(frame).not.toContain('\u001b')
      expect(frame).not.toContain('‮')
    }
  })
})
