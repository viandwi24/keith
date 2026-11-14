import { Dialog, dialogInner, G, GUTTER, KeyHints, Notice, Txt } from '@keith/ui'
import { Box } from 'ink'
import type { QuestionItem, Settled } from './question-state.ts'

export interface QuestionCardProps {
  item: QuestionItem
  /** Width of the painted row. */
  width: number
  /** The card that takes keys: its cursor, and whether the keys are on it (`tab`). */
  open?: { cursor: number; focused: boolean }
  /** Settled here: the answer or the closed note replaces the options. */
  settled?: Settled
}

/**
 * A protocol's question in the chat. The newest open question with options is a frame with the options: `tab` gives
 * it the keys (1-n or ↑↓ and enter answer, `tab` gives them back). A settled card shows what was answered and takes no
 * keys. An older question is the plain notice it always was.
 */
export function QuestionCard({ item, width, open, settled }: QuestionCardProps) {
  if (settled?.kind === 'answered')
    return (
      <Box flexDirection="column" paddingLeft={GUTTER}>
        <Txt>{`Keith asks: ${item.text}`}</Txt>
        <Txt tone="muted">{`answered: ${settled.option}`}</Txt>
      </Box>
    )
  if (settled?.kind === 'closed')
    return (
      <Box flexDirection="column" paddingLeft={GUTTER}>
        <Txt>{`Keith asks: ${item.text}`}</Txt>
        <Txt tone="muted">question closed</Txt>
      </Box>
    )
  if (open === undefined) {
    // a question without options, or an older one: the answer is a reply in this chat
    const options =
      item.options.length === 0
        ? 'answer here in the chat'
        : `answer here: ${item.options.join(' · ')}`
    return (
      <Box paddingLeft={GUTTER}>
        <Notice level="info" rows={[`Keith asks: ${item.text}`, options]} />
      </Box>
    )
  }
  const { cursor, focused } = open
  return (
    <Dialog
      title="Keith asks"
      focused={focused}
      width={width}
      footer={
        focused ? (
          <KeyHints
            hints={[
              { key: `1-${item.options.length}`, action: 'answer' },
              { key: '↑↓', action: 'move' },
              { key: 'enter', action: 'send' },
              { key: 'tab', action: 'back' },
            ]}
            width={dialogInner(width)}
          />
        ) : (
          <Txt tone="muted">tab to answer</Txt>
        )
      }
    >
      <Txt>{item.text}</Txt>
      {item.options.map((option, i) => {
        const on = focused && i === cursor
        return (
          <Txt key={option} tone={on ? 'accent' : 'muted'}>
            {`${on ? G.prompt : ' '} ${i + 1}  ${option}`}
          </Txt>
        )
      })}
    </Dialog>
  )
}
