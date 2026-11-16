/**
 * The consent effect of parietal's input-aware tools (ADR-0039 §1; docs/specs/workspace.md "Consent", node-drivers.md "Client calls").
 * Decided from the input alone, as `tool.approve` requires (it is re-run on re-validation).
 *
 * - `workspace`: changes only what the person sees, can be undone and sends nothing anywhere, so it is `none`. The one way a window
 *   could carry data out is a destination in its params (`web:browser { url }`, `web:media { url }`): an `open` or `params` whose
 *   params hold one is `egress` with those destinations as `url` targets. Plugin pages reach only the hosts their plugin declared.
 * - `client_call`: `location.share` sends where the person is, so it is `egress`; a notice, a view or a screen switch for the person
 *   themself is `none`.
 */
import type { ConsentCallEffect } from '@keith/contracts'
import { CLIENT_CALL_TOOL } from './client-tools.ts'
import { WORKSPACE_TOOL } from './workspace-tool.ts'

/**
 * A string that names a destination: a scheme right before a non-space (`https:`, `mailto:a@b`, `javascript:`) or `//host`, or holds
 * `://`. A label such as `Route: Surabaya` (a word, a colon, a space) is not one.
 */
const DESTINATION = /^\s*([a-z][a-z0-9+.-]*:(?!\s|$)|\/\/)|:\/\//i

/** Every destination string in a params value (any depth; past depth 4 the value itself counts as one). */
function destinations(value: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 4) {
    out.push(JSON.stringify(value) ?? '')
    return out
  }
  if (typeof value === 'string') {
    if (DESTINATION.test(value)) out.push(value)
  } else if (Array.isArray(value)) {
    for (const v of value) destinations(v, depth + 1, out)
  } else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) destinations(v, depth + 1, out)
  }
  return out
}

export function workspaceConsentEffect(
  toolName: string,
  input: unknown,
): ConsentCallEffect | undefined {
  if (toolName !== WORKSPACE_TOOL) return undefined
  if (input === null || typeof input !== 'object') return undefined
  const { action, params } = input as { action?: unknown; params?: unknown }
  if (typeof action !== 'string') return undefined
  if (action === 'open' || action === 'params') {
    const found = destinations(params)
    if (found.length > 0) return { effect: 'egress', targets: found, targetKind: 'url' }
  }
  return { effect: 'none' }
}

export function clientCallConsentEffect(
  toolName: string,
  input: unknown,
): ConsentCallEffect | undefined {
  if (toolName !== CLIENT_CALL_TOOL) return undefined
  const capability = (input as { capability?: unknown } | null)?.capability
  if (capability === 'location.share') return { effect: 'egress' }
  if (capability === 'notify' || capability === 'open.view' || capability === 'workspace.show')
    return { effect: 'none' }
  return undefined
}
