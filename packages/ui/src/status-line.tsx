import type { StatusInfo } from './connection-mark.tsx'
import { TitleRow } from './title-row.tsx'

export type { ConnectionKind } from './connection-mark.tsx'

export interface StatusLineProps {
  status: StatusInfo
  width: number
}

/** The compact header (under 80 columns or 20 rows): `✳ K E I T H` centred, the glyph carries the connection. */
export function StatusLine({ status, width }: StatusLineProps) {
  return <TitleRow width={width} status={status} />
}
