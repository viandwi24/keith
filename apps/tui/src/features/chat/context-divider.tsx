import { GUTTER, Rule, Txt } from '@keith/ui'
import { Box } from 'ink'

/**
 * A rule with a muted label: "new context" at the top of a context after a reset, "conversation compacted" where a `/compact` ended
 * (docs/specs/chat-context.md, "TUI").
 */
export function ContextDivider({
  width,
  label = 'new context',
}: {
  width: number
  label?: string
}) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Rule width={width} />
      <Box paddingLeft={GUTTER}>
        <Txt tone="muted">{label}</Txt>
      </Box>
    </Box>
  )
}
