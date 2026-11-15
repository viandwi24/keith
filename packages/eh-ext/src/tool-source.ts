// Why it lives here: eharness reads a tool's risk from its metadata (`toolTraits`) but has no notion of where a result comes from
// or whether a write can be undone; Keith declares both next to `risk` (ADR-0036). Replace with an upstream trait if eharness
// ever adds a provenance trait.
import type { ToolSource } from '@keith/contracts'

const SOURCES: ReadonlySet<string> = new Set<ToolSource>(['trusted', 'outside'])

/**
 * What Keith knows about the tools eharness ships (their metadata is eharness' own, so Keith cannot declare it): where their
 * results come from, and, for the web tools, the risk consent reads (`consentRisk`: a fetch has an outside source but changes
 * nothing, so eharness' `external` risk does not make it ask). Everything not listed here and not declared in metadata is `outside`.
 */
export const EHARNESS_TOOL_TRAITS: Readonly<
  Record<string, { source: ToolSource; consentRisk?: 'read' }>
> = {
  web_fetch: { source: 'outside', consentRisk: 'read' },
  web_search: { source: 'outside', consentRisk: 'read' },
  // a delegation: the worker's report comes back as the result
  agent: { source: 'outside' },
  agent_output: { source: 'outside' },
  agent_stop: { source: 'trusted' },
  send_message: { source: 'outside' },
  // the person's own memory: Keith's state
  memory_view: { source: 'trusted' },
  memory_create: { source: 'trusted' },
  memory_str_replace: { source: 'trusted' },
  memory_insert: { source: 'trusted' },
  memory_delete: { source: 'trusted' },
  memory_rename: { source: 'trusted' },
  todo_write: { source: 'trusted' },
  datetime: { source: 'trusted' },
  sleep: { source: 'trusted' },
  // workspace files hold what the worker downloaded: reading them is reading outside text
  list_files: { source: 'outside' },
  read_file: { source: 'outside' },
  grep: { source: 'outside' },
  glob: { source: 'outside' },
  write_file: { source: 'trusted' },
  edit_file: { source: 'trusted' },
  delete_file: { source: 'trusted' },
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
