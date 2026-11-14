import { Box } from 'ink'
import { G } from './glyphs.ts'
import { Txt } from './text.tsx'

export interface NavItem {
  id: string
  label: string
  /** Muted at the right edge: a count or a state. */
  note?: string | undefined
}

export interface NavListProps {
  items: readonly NavItem[]
  /** Index of the current item. */
  current: number
  /** The list has the keys: the marker is accent; otherwise it is muted and the other pane is live. */
  focused: boolean
  width: number
}

/** The section list of a two-pane screen: `▸` and a bold label on the current item, the others dim. */
export function NavList({ items, current, focused, width }: NavListProps) {
  return (
    <Box flexDirection="column" width={width}>
      {items.map((item, i) => {
        const on = i === current
        return (
          <Box key={item.id} width={width}>
            <Box width={2} flexShrink={0}>
              <Txt tone={focused ? 'accent' : 'muted'} bold>
                {on ? `${G.pointer} ` : '  '}
              </Txt>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Txt bold={on} tone={on && focused ? 'text' : 'muted'} wrap="truncate-end">
                {item.label}
              </Txt>
            </Box>
            {item.note !== undefined && <Txt tone="muted">{` ${item.note}`}</Txt>}
          </Box>
        )
      })}
    </Box>
  )
}
