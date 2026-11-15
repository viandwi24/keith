import type { SectionData, SectionId } from '@keith/app-model/manage'
import type { KeithClient } from '@keith/client'
import type { Capability, Whoami } from '@keith/contracts'
import type { Hint } from '@keith/ui'
import type { ComponentType } from 'react'
import type { Nodes } from '../nodes/index.ts'
import type { StepUp } from '../stepup/index.ts'

/** What a section hook gets. */
export interface ManageEnv {
  client: KeithClient
  /** Runs an action; a `KEITH_STEP_UP_REQUIRED` refusal opens the PIN prompt and retries once. */
  guard: StepUp['guard']
  me: Whoami
  /** What `me.role` grants (the server still enforces every call). */
  caps: ReadonlySet<string>
  /** The app's node registry (live through the activity feed). */
  nodes: Nodes
}

export interface SectionDef {
  id: SectionId
  title: string
  /** The section shows when the person has any of these (`authenticated`: always). */
  read: readonly (Capability | 'authenticated')[]
  /** The hook that loads the section; called once per mount of the section host. */
  use(env: ManageEnv): SectionData
}

/** What a pane section gets: the same size, focus, legend and navigation as a table section's host. */
export interface PaneProps {
  env: ManageEnv
  /** Cells of the pane, its frame included; `height` is the rows its frame may take. */
  width: number
  height: number
  /** The frame's top-right tag (`2/8`) and a muted bottom tag (the role of a member). */
  count?: string
  bottom?: string
  /** Two panes (the section list stands at the left): `tab` goes back to the list. */
  wide: boolean
  focus: boolean
  active: boolean
  onLegend(hints: readonly Hint[]): void
  onNav(key: 'tab' | 'left' | 'right'): void
  onClose(): void
}

/**
 * A section that draws its own pane and keys instead of a row list (Logs: levels, a filter, a raw view). It loads what it
 * shows itself, so it has no `use`: its component calls its hook.
 */
export interface PaneSectionDef {
  id: SectionId
  title: string
  read: readonly (Capability | 'authenticated')[]
  pane: ComponentType<PaneProps>
}

export type ManageSection = SectionDef | PaneSectionDef

export type {
  ActionSpec,
  FieldSpec,
  NoteSpec,
  Outcome,
  Row,
  SectionData,
  SectionId,
} from '@keith/app-model/manage'
