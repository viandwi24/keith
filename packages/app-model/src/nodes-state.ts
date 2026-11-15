import {
  NODE_CHANGED,
  type Node,
  NodeChangedPayloadSchema,
  type NodeStatus,
  type RefusalReason,
} from '@keith/contracts'
import { G } from '@keith/ui/tokens'

const REFUSAL_LABEL: Record<RefusalReason, string> = {
  'unknown-capability': 'unknown capability',
  'unsupported-schema': 'unsupported schema',
  'driver-mismatch': 'driver mismatch',
  'wrong-layer': 'wrong layer',
}

/**
 * One line per driver a node announced: `desktop 0.1.0 · screenshot input` (the capabilities without the driver
 * prefix). An accepted capability no driver owns (a node that announced none) goes on one line of its own ids.
 */
export function driverLines(node: Node): string[] {
  const prefixOf = (name: string) => `${name}.`
  const lines = node.drivers.map((driver) => {
    const caps = node.capabilities
      .filter((id) => id.startsWith(prefixOf(driver.name)))
      .map((id) => id.slice(prefixOf(driver.name).length))
    return `${driver.name} ${driver.version}${caps.length > 0 ? ` · ${caps.join(' ')}` : ''}`
  })
  const orphans = node.capabilities.filter(
    (id) => !node.drivers.some((driver) => id.startsWith(prefixOf(driver.name))),
  )
  if (orphans.length > 0) lines.push(orphans.join(', '))
  return lines
}

/** Muted, one per refused capability: `refused: iot.switch (unknown capability)`. */
export function refusedLines(node: Node): string[] {
  return node.refused.map((r) => `refused: ${r.id} (${REFUSAL_LABEL[r.reason]})`)
}

/** The node of a `node-changed` record, or undefined for any other record or a bad payload. */
export function nodeChangedOf(record: { type: string; payload: unknown }): Node | undefined {
  if (record.type !== NODE_CHANGED) return undefined
  const parsed = NodeChangedPayloadSchema.safeParse(record.payload)
  return parsed.success ? parsed.data.node : undefined
}

const ICON: Record<NodeStatus, string> = { online: G.dot, offline: G.idle, revoked: G.failed }
export const nodeIcon = (status: NodeStatus): string => ICON[status]

const ORDER: Record<NodeStatus, number> = { online: 0, offline: 1, revoked: 2 }

/** Online first, then offline, then revoked; by name inside a group. */
export function sortNodes(nodes: Iterable<Node>): Node[] {
  return [...nodes].sort(
    (a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name),
  )
}

/**
 * Merge a fetched list with `touched`: nodes changed by events while the request was in flight.
 * The list is the base (a node missing from it is gone), but an event that arrived meanwhile is
 * newer than the response, so it wins.
 */
export function mergeNodes(list: readonly Node[], touched: ReadonlyMap<string, Node>): Node[] {
  const byId = new Map(list.map((n) => [n.id, n]))
  for (const [id, node] of touched) byId.set(id, node)
  return sortNodes(byId.values())
}

export interface NodeCounts {
  online: number
  total: number
}

/** Revoked nodes are history, not part of the fleet. */
export function countNodes(nodes: readonly Node[]): NodeCounts {
  const live = nodes.filter((n) => n.status !== 'revoked')
  return { online: live.filter((n) => n.status === 'online').length, total: live.length }
}

/** `just now`, `5 s ago`, `3 min ago`, `2 h ago`, `never`. */
export function formatLastSeen(lastSeenAt: number | null, now: number): string {
  if (lastSeenAt === null) return 'never'
  const s = Math.max(0, Math.floor((now - lastSeenAt) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s} s ago`
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86_400)} d ago`
}

/** `09:58`: whole seconds left until `expiresAt`, rounded down (never more than the real time left), never negative. */
export function formatCountdown(expiresAt: number, now: number): string {
  const total = Math.max(0, Math.floor((expiresAt - now) / 1000))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}
