import {
  countNodes,
  driverLines,
  formatLastSeen,
  nodeIcon,
  refusedLines,
  sortNodes,
} from '@keith/app-model'
import type { Node, NodeStatus } from '@keith/contracts'

// View models of the Nodes screen: every node as a row, with the TUI's words (driver lines, refused lines, shell policy).

export const NODES_POLL_MS = 30_000

export interface NodeRowView {
  id: string
  name: string
  status: NodeStatus
  icon: string
  tone: 'success' | 'muted' | 'danger'
  platform: string
  version: string
  seen: string
  /** `shell allowed` or `shell off`. */
  shell: string
  shellOn: boolean
  /** `desktop 0.1.0 · screenshot input`: one line per announced driver. */
  drivers: string[]
  /** `refused: iot.switch (unknown capability)`. */
  refused: string[]
}

const TONE: Record<NodeStatus, NodeRowView['tone']> = {
  online: 'success',
  offline: 'muted',
  revoked: 'danger',
}

export function nodeRowsOf(nodes: readonly Node[], now: number): NodeRowView[] {
  return sortNodes(nodes).map((n) => ({
    id: n.id,
    name: n.name,
    status: n.status,
    icon: nodeIcon(n.status),
    tone: TONE[n.status],
    platform: `${n.os}/${n.arch}`,
    version: `v${n.version}`,
    seen: formatLastSeen(n.lastSeenAt, now),
    shell: `shell ${n.allowShell ? 'allowed' : 'off'}`,
    shellOn: n.allowShell,
    drivers: driverLines(n),
    refused: refusedLines(n),
  }))
}

/** `3 nodes · 2 online` (revoked nodes are history and not counted). */
export function nodesSummary(nodes: readonly Node[]): string {
  const { online, total } = countNodes(nodes)
  return `${total} ${total === 1 ? 'node' : 'nodes'} · ${online} online`
}

/** Members get no node events from the core, so their page asks again every 30 s; the owner's list follows the feed. */
export const needsPoll = (role: string | undefined): boolean =>
  role !== undefined && role !== 'owner'

export const NO_NODES = 'No nodes yet. Pair one on the core machine: keith-core pair'
export const NODES_FOOTER =
  'Pair or revoke nodes on the core machine: keith-core pair, keith-core nodes revoke'
