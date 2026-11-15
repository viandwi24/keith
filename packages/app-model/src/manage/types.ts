import type { KeithClient } from '@keith/client'
import type { Capability, Node, Whoami } from '@keith/contracts'
import type { Tone } from '../ui-types.ts'

// The shape of a Manage section, shared by both clients (docs/specs/app-model.md). A section is data: info lines, rows with actions and
// section-level actions. The client draws them (Ink in the TUI, a table and drawers in the web) and runs every action through its
// step-up guard.

/** One input of an action form. */
export interface FieldSpec {
  id: string
  label: string
  /** A hidden input: never drawn, cleared from state once the form is submitted. */
  secret?: boolean
  /** A choice (`←` `→` or space cycle it in the TUI, a select in the web) instead of free text. */
  options?: readonly string[]
  initial?: string
  /** The form may be submitted without it. */
  optional?: boolean
  placeholder?: string
  /** Long text: a text area in the web (the TUI draws one line either way). */
  multiline?: boolean
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

/** What a table section shows and can do, before the loading state. */
export interface SectionBody {
  /** Info rows above the list (an overview, the limit, the access mode). */
  lines: readonly string[]
  header?: readonly string[]
  /** Cell widths in the TUI; the last cell takes the rest of the row. */
  widths?: readonly number[]
  rows: readonly Row[]
  /** What the empty list says. */
  empty?: string
  /** Actions that need no row (add, pair, create). The first one is `n` in the TUI. */
  actions: readonly ActionSpec[]
}

/** What a section hook returns: the body plus the load state. */
export interface SectionData extends SectionBody {
  error: string | undefined
  loading: boolean
  reload(): void
}

/** What a section model gets: the client, who is asking, and what that role grants (the server still enforces every call). */
export interface SectionEnv {
  client: KeithClient
  me: Whoami
  caps: ReadonlySet<string>
  /** The live node registry when the client has one (the TUI); the sections read the list themselves otherwise. */
  nodes?: readonly Node[] | undefined
  /** How many rows a long list (Audit, Privacy) reads; the section's own default when absent. */
  limit?: number | undefined
}

/** A table section as two pure steps: read what it needs, then build its body from that (undefined while loading). */
export interface SectionModel<D = unknown> {
  load(): Promise<D>
  build(data: D | undefined): SectionBody
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

/** The capabilities that show a section (`authenticated`: always). */
export type SectionRead = readonly (Capability | 'authenticated')[]
