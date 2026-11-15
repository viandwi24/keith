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
