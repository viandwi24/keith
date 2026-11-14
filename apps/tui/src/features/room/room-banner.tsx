import { Txt } from '@keith/ui'
import { Box } from 'ink'
import type { RoomBanner } from './room-state.ts'

export interface RoomBannerRowProps {
  banner: RoomBanner
  /** Columns of the row; the text is cut at the end when it is longer. */
  width: number
}

/**
 * The room banner, one row: `● Room "Planning" · Ana, Duta, Keith · /room`. Accent while the room is active, muted while only
 * invitations are out (tui-design, Room). The text is built by `bannerOf`; the room name is server text, drawn through `Txt`.
 */
export function RoomBannerRow({ banner, width }: RoomBannerRowProps) {
  return (
    <Box width={width} height={1} flexShrink={0}>
      <Txt tone={banner.tone === 'accent' ? 'accent' : 'muted'} wrap="truncate-end">
        {banner.text}
      </Txt>
    </Box>
  )
}
