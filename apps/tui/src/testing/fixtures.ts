import type { AttentionItem } from '@keith/client'
import type { Node, Task } from '@keith/contracts'

/** A task row with sensible defaults. */
export const task = (over: Partial<Task> = {}): Task => ({
  id: 't1',
  parentSessionId: 'front:p1',
  agent: 'cortex.research',
  description: 'research',
  status: 'running',
  steps: 0,
  summary: null,
  error: null,
  createdAt: 0,
  updatedAt: 1,
  finishedAt: null,
  ...over,
})

/** A node row with sensible defaults. */
export const node = (over: Partial<Node> = {}): Node => ({
  id: 'n1',
  name: 'laptop-e',
  os: 'darwin',
  arch: 'arm64',
  version: '0.0.0',
  capabilities: ['system.info', 'shell.exec'],
  drivers: [],
  refused: [],
  allowShell: true,
  status: 'online',
  lastSeenAt: Date.now(),
  createdAt: 1,
  ...over,
})

/** A `motor_remote` approval of a worker, as `GET /attention` lists it. */
export const approval = (
  over: Partial<AttentionItem> & { command?: string; nodeName?: string } = {},
): AttentionItem => {
  const { command = 'df -h', nodeName = 'laptop-e', ...rest } = over
  return {
    id: 'ap1',
    kind: 'approval',
    sessionId: 'task-1',
    parentSessionId: 'front:p1',
    rootSessionId: 'front:p1',
    agent: 'cortex.general',
    description: 'check disk space',
    toolCallId: 'call-1',
    toolName: 'motor_remote',
    input: { node: nodeName, capability: 'shell.exec', input: { command } },
    risk: 'external',
    messageId: 'm1',
    createdAt: 1000,
    answeredWaiting: 0,
    // what the core sends for an item the owner may scope (amygdala `decorate`)
    extra: { scopable: true },
    ...rest,
  } as AttentionItem
}

/** A member's own `shell.exec` request that only the owner can answer (the member's list). */
export const waitingApproval = (
  over: Partial<AttentionItem> & { command?: string } = {},
): AttentionItem =>
  approval({
    id: 'ap-wait',
    parentSessionId: 'front:ana-id',
    rootSessionId: 'front:ana-id',
    extra: { waitingFor: 'owner' },
    ...over,
  })

/** What the owner sees of a member's request: who asked, the node and the whole command. */
export const askedByApproval = (over: Partial<AttentionItem> & { command?: string } = {}) => {
  const { command = 'rm -rf /tmp/build-cache', ...rest } = over
  return approval({
    id: 'ap-asked',
    sessionId: 'task-ana',
    parentSessionId: 'front:ana-id',
    rootSessionId: 'front:ana-id',
    command,
    extra: {
      askedBy: 'ana',
      askedByName: 'Ana',
      node: 'laptop-e',
      capability: 'shell.exec',
      command,
    },
    ...rest,
  })
}
