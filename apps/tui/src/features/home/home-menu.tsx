import { FramePanel, Txt } from '@keith/ui'
import { Box } from 'ink'
import { isGroup, type MenuEntry } from './menu-state.ts'

export const MENU_WIDTH = 22
const GAP = 2
const DETAIL_MAX = 52

export interface HomeMenuProps {
  items: readonly MenuEntry[]
  selected: number
  /** The open group's title: a muted first row above its entries. */
  title?: string | undefined
  /** The read-only box beside the list: its title and live lines (`undefined`: closed). */
  detail: { title: string; lines: readonly string[] } | undefined
  columns: number
  /** The core is unreachable: every entry but Logout is dimmed (not `▸`/bold). */
  offline?: boolean
  /** Rows the list may take; a longer list scrolls to keep the selection in view. */
  maxRows?: number
}

/** The HUD list (no outer frame, no background): `▸` and a bold label on the selection, the rest dim. */
export function HomeMenu({
  items,
  selected,
  title,
  detail,
  columns,
  offline = false,
  maxRows,
}: HomeMenuProps) {
  // the group's title is a row too: it comes off the budget
  const visible =
    maxRows === undefined ? items.length : Math.max(3, maxRows - (title === undefined ? 0 : 1))
  const start = Math.max(0, Math.min(selected - visible + 1, items.length - visible))
  const boxWidth = Math.max(16, Math.min(columns - 4 - MENU_WIDTH - GAP, DETAIL_MAX))
  return (
    <Box alignItems="flex-end">
      <Box flexDirection="column" width={MENU_WIDTH} flexShrink={0}>
        {title !== undefined && <Txt tone="muted">{`  ${title}`}</Txt>}
        {items.map((item, i) => {
          if (i < start || i >= start + visible) return null
          // a group opens a submenu, so it is never dimmed offline; a leaf is, except Logout
          const dimmed = offline && !isGroup(item) && item.id !== 'logout'
          const on = i === selected && !dimmed
          return (
            <Box key={item.id}>
              {on ? (
                <>
                  <Txt tone="accent">▸</Txt>
                  <Txt bold>{` ${item.title}`}</Txt>
                </>
              ) : (
                <Txt tone="muted">{`${i === selected ? '▸' : ' '} ${item.title}`}</Txt>
              )}
              {item.flag !== undefined && <Txt tone="warning">{` ${item.flag}`}</Txt>}
              {isGroup(item) && <Txt tone="muted">{' ▸'}</Txt>}
            </Box>
          )
        })}
      </Box>
      {detail !== undefined && (
        <Box marginLeft={GAP} flexShrink={0}>
          <FramePanel
            width={boxWidth}
            top={[{ text: detail.title }]}
            lines={Array.from(
              { length: Math.max(2, detail.lines.length) },
              (_, i) => ` ${detail.lines[i] ?? ''}`,
            )}
          />
        </Box>
      )}
    </Box>
  )
}
