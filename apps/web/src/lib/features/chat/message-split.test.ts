import { expect, test } from 'bun:test'
import { toItems } from '@keith/app-model'

type Messages = Parameters<typeof toItems>[0]

test("web rows: an approval note part becomes the person's own row between two assistant rows", () => {
  const messages = [
    {
      id: 'a',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Shall I?' },
        {
          type: 'data-eh.input',
          data: {
            source: 'user',
            text: '[approval note] framed',
            approvalNote: { toolCallId: 'c', toolName: 't', text: 'ya' },
          },
        },
        { type: 'step-start' },
        { type: 'text', text: 'Done.' },
      ],
    },
  ] as unknown as Messages
  const items = toItems(messages)
  expect(items.map((i) => i.kind)).toEqual(['assistant', 'user', 'assistant'])
  expect(items[1]).toMatchObject({ kind: 'user', text: 'ya' })
  expect(new Set(items.map((i) => i.id)).size).toBe(3)
})
