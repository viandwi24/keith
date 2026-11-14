import type { KeithClient } from '@keith/client'
import type { Capability, Whoami } from '@keith/contracts'
import type { Hint, Tone } from '@keith/ui'
import type { ComponentType } from 'react'
import type { Nodes } from '../nodes/index.ts'
import type { StepUp } from '../stepup/index.ts'

/** One input of an action form. */
export interface FieldSpec {
  id: string
  label: string
  /** A hidden input: never drawn, cleared from state once the form is submitted. */
  secret?: boolean
  /** A choice (`←` `→` or space cycle it) instead of free text. */
  options?: readonly string[]
  initial?: string
  /** The form may be submitted without it. */
  optional?: boolean
  placeholder?: string
}

/** A dialog that tells the result: a token or pairing code (`once`) or a plain answer. */
export interface NoteSpec {
  title: string
  lines: readonly string[]
  /** The text is shown this one time and cannot be shown again. */
  once?: boolean
}

export interface Outcome {
  /** One line shown as an info notice. */
  message?: string
  note?: NoteSpec
}

/** Something the person can do in a section: the same procedure a `keith-core` command calls. */
export interface ActionSpec {
  id: string
  label: string
  /** Muted next to the label in the action menu. */
  hint?: string
  fields?: readonly FieldSpec[]
  /** Ask first; `type` is a word the person must type to confirm (transfer owner). */
  confirm?: { text: string; type?: string }
  run(values: Readonly<Record<string, string>>): Promise<Outcome | undefined>
}

export interface Row {
  id: string
  cells: readonly string[]
  tone?: Tone
  /** Shown under the list while the row is selected. */
  detail?: string
  actions: readonly ActionSpec[]
}

/** What a section shows and can do. The hook of the section builds it from the core's answers. */
export interface SectionData {
  /** Info rows above the list (an overview, the limit, the access mode). */
  lines: readonly string[]
  header?: readonly string[]
  /** Cell widths; the last cell takes the rest of the row. */
  widths?: readonly number[]
  rows: readonly Row[]
  /** What the empty list says. */
  empty?: string
  /** Actions that need no row (add, pair, create). The first one is `n`. */
  actions: readonly ActionSpec[]
  error: string | undefined
  loading: boolean
  reload(): void
}

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

export type SectionId =
  | 'overview'
  | 'people'
  | 'groups'
  | 'plugins'
  | 'reviews'
  | 'protocols'
  | 'devices'
  | 'nodes'
  | 'providers'
  | 'persona'
  | 'access'
  | 'succession'
  | 'budget'
  | 'logs'
  | 'privacy'
  | 'audit'

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
