// Why it lives here: eharness reads a tool's risk from its metadata (`toolTraits`) but has no notion of where a result comes from
// or whether a write can be undone; Keith declares both next to `risk` (ADR-0036). Replace with an upstream trait if eharness
// ever adds a provenance trait.
import type { ToolEffect, ToolSource } from '@keith/contracts'

const SOURCES: ReadonlySet<string> = new Set<ToolSource>(['trusted', 'outside'])

/**
 * What Keith knows about the tools eharness ships (their metadata is eharness' own, so Keith cannot declare it): where their
 * results come from, and, for the web tools, the risk consent reads (`consentRisk`: a fetch has an outside source but changes
 * nothing, so eharness' `external` risk does not make it ask). Everything not listed here and not declared in metadata is `outside`.
 */
export const EHARNESS_TOOL_TRAITS: Readonly<
  Record<string, { source: ToolSource; consentRisk?: 'read'; effect?: ToolEffect }>
> = {
  // a GET to a URL from outside text could carry data in its query; asking before every fetch would break research, so this
  // channel is accepted (ADR-0039 §5)
  web_fetch: { source: 'outside', consentRisk: 'read', effect: 'none' },
  web_search: { source: 'outside', consentRisk: 'read', effect: 'none' },
  // a delegation: the worker's report comes back as the result; the worker's own calls pass the same guard
  agent: { source: 'outside', effect: 'none' },
  agent_output: { source: 'outside', effect: 'none' },
  agent_stop: { source: 'trusted', effect: 'none' },
  send_message: { source: 'outside', effect: 'egress' },
  // the person's own memory: Keith's state
  memory_view: { source: 'trusted', effect: 'none' },
  memory_create: { source: 'trusted', effect: 'local' },
  memory_str_replace: { source: 'trusted', effect: 'local' },
  memory_insert: { source: 'trusted', effect: 'local' },
  memory_delete: { source: 'trusted', effect: 'destructive' },
  memory_rename: { source: 'trusted', effect: 'local' },
  todo_write: { source: 'trusted', effect: 'local' },
  datetime: { source: 'trusted', effect: 'none' },
  sleep: { source: 'trusted', effect: 'none' },
  // workspace files hold what the worker downloaded: reading them is reading outside text; the worker's folder is scratch space
  list_files: { source: 'outside', effect: 'none' },
  read_file: { source: 'outside', effect: 'none' },
  grep: { source: 'outside', effect: 'none' },
  glob: { source: 'outside', effect: 'none' },
  write_file: { source: 'trusted', effect: 'local' },
  edit_file: { source: 'trusted', effect: 'local' },
  delete_file: { source: 'trusted', effect: 'local' },
}

const EFFECTS: ReadonlySet<string> = new Set<ToolEffect>([
  'none',
  'local',
  'behavior',
  'egress',
  'destructive',
])

/**
 * The declared effect of a tool (ADR-0039 §1): `metadata.effect` when valid, else the table of eharness tools by name, else undefined
 * (consent then falls back to the tool's risk). Pure; never throws.
 */
export function toolEffect(metadata: unknown, toolName?: string): ToolEffect | undefined {
  if (metadata !== null && typeof metadata === 'object') {
    const declared = (metadata as { effect?: unknown }).effect
    if (typeof declared === 'string' && EFFECTS.has(declared)) return declared as ToolEffect
  }
  if (toolName !== undefined && Object.hasOwn(EHARNESS_TOOL_TRAITS, toolName))
    return EHARNESS_TOOL_TRAITS[toolName]?.effect
  return undefined
}

/** The effect a tool's eharness risk stands for when nothing declares one (ADR-0039 §1). */
export function effectOfRisk(risk: string | undefined): ToolEffect | undefined {
  if (risk === 'read') return 'none'
  if (risk === 'write') return 'local'
  if (risk === 'external') return 'egress'
  if (risk === 'destructive') return 'destructive'
  return undefined
}

/**
 * The source of a tool: `metadata.source` when it is valid (declared by Keith), else the table of eharness tools by name, else
 * `outside`. Pure; never throws. Reads metadata like eharness `toolTraits`.
 */
export function toolSource(metadata: unknown, toolName?: string): ToolSource {
  if (metadata !== null && typeof metadata === 'object') {
    const declared = (metadata as { source?: unknown }).source
    if (typeof declared === 'string' && SOURCES.has(declared)) return declared as ToolSource
  }
  if (toolName !== undefined && Object.hasOwn(EHARNESS_TOOL_TRAITS, toolName))
    return EHARNESS_TOOL_TRAITS[toolName]?.source ?? 'outside'
  return 'outside'
}

/** Whether Keith declared a valid `metadata.source` (a test reads this: a Keith-owned tool must declare it). */
export function declaresSource(metadata: unknown): boolean {
  if (metadata === null || typeof metadata !== 'object') return false
  const declared = (metadata as { source?: unknown }).source
  return typeof declared === 'string' && SOURCES.has(declared)
}

/** True when `metadata.reversible` is `true`: a write whose last change Keith can undo (`undo_last`, ADR-0036 §4). */
export function toolReversible(metadata: unknown): boolean {
  return (
    metadata !== null &&
    typeof metadata === 'object' &&
    (metadata as { reversible?: unknown }).reversible === true
  )
}

/**
 * Whether a tool runs its own confirmation outside the model (`metadata.selfConfirmed: true`; e.g. `room_post` creates a request the
 * person confirms with the exact text): conversational consent (ADR-0036) stays out of it, so the person is not asked twice.
 */
export function toolSelfConfirmed(metadata: unknown): boolean {
  return (
    metadata !== null &&
    typeof metadata === 'object' &&
    (metadata as { selfConfirmed?: unknown }).selfConfirmed === true
  )
}

/** The risk consent reads for an eharness tool whose own risk is too coarse (the web tools), when Keith knows one. */
export function eharnessConsentRisk(toolName: string): 'read' | undefined {
  return Object.hasOwn(EHARNESS_TOOL_TRAITS, toolName)
    ? EHARNESS_TOOL_TRAITS[toolName]?.consentRisk
    : undefined
}
