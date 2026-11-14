import { GUTTER, TextInput, Txt } from '@keith/ui'
import { Box } from 'ink'

export interface InputBandProps {
  /** Width of the left column. */
  width: number
  draft: string
  onDraft(value: string): void
  onSubmit(value: string): void
  /** The band has the keys; without them it reads `tab to return to chat`. */
  focus: boolean
  /** A turn runs: the placeholder reads `esc to stop`. */
  busy: boolean
  /** Commands matching a draft that starts with `/`, shown on one row above the band. */
  hints?: readonly string[] | undefined
  /** The empty-input text while the band has the keys and no turn runs (default: the chat's). */
  placeholder?: string
}

/** The input band between the chat's two rules: the prompt and the draft (growing with newlines), the command hints above. */
export function InputBand({
  width,
  draft,
  onDraft,
  onSubmit,
  focus,
  busy,
  hints,
  placeholder: idle = 'type a message, or /help',
}: InputBandProps) {
  const placeholder = !focus ? 'tab to return to chat' : busy ? 'esc to stop' : idle
  return (
    <Box flexDirection="column" flexShrink={0}>
      {hints !== undefined && (
        <Box paddingLeft={GUTTER} marginTop={1} flexWrap="wrap">
          {hints.map((h, i) => (
            <Box key={h} marginRight={2} flexShrink={0}>
              <Txt tone={i === 0 && hints.length === 1 ? 'accent' : 'accent'}>{h}</Txt>
            </Box>
          ))}
        </Box>
      )}
      <Box width={width} paddingLeft={GUTTER} paddingRight={1}>
        <TextInput
          focus={focus}
          multiline
          value={draft}
          width={Math.max(10, width - GUTTER - 1)}
          placeholder={placeholder}
          onChange={onDraft}
          onSubmit={onSubmit}
        />
      </Box>
    </Box>
  )
}
