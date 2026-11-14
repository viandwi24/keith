import type { ReactNode } from 'react'
import { FramePanel } from './frame-panel.tsx'

export interface PanelProps {
  title: string
  /** Muted tag at the right of the top border: `2 running`, `1/2 online`. */
  count?: string
  /** `+n more /tasks`, a tag in the bottom border: the panel does not show every row. */
  more?: { n: number; command: string }
  /** Cells, borders included. */
  width: number
  children?: ReactNode
}

/** A sidebar panel: a frame with the title in the top border, the count at its right and the `+n more` tag below. */
export function Panel({ title, count, more, width, children }: PanelProps) {
  return (
    <FramePanel
      width={width}
      top={[{ text: title }]}
      {...(count === undefined ? {} : { topRight: [{ text: count }] })}
      {...(more !== undefined && more.n > 0
        ? { bottom: [{ text: `+${more.n} more ${more.command}` }] }
        : {})}
      padX={1}
    >
      {children}
    </FramePanel>
  )
}
