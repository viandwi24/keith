import { z } from 'zod'
import { CapabilityIdSchema, RefusalReasonSchema } from './node-capabilities.ts'

/** Connection state of a paired node. */
export const NodeStatusSchema = z.enum(['online', 'offline', 'revoked'])
export type NodeStatus = z.infer<typeof NodeStatusSchema>

/** A driver a node announced (its name and version). Options are never shown here. */
export const NodeDriverSchema = z.object({ name: z.string(), version: z.string() })
export type NodeDriver = z.infer<typeof NodeDriverSchema>

/** An announced capability the core refused; the node stays online with its accepted ones. */
export const NodeRefusedSchema = z.object({
  id: z.string(),
  schemaVersion: z.number().int(),
  reason: RefusalReasonSchema,
})
export type NodeRefused = z.infer<typeof NodeRefusedSchema>

/** One row of the node registry. */
export const NodeSchema = z.object({
  id: z.string(),
  /** Slug the owner and the agent use to address the node. */
  name: z.string(),
  os: z.string(),
  arch: z.string(),
  /** Keith version the node runs. */
  version: z.string(),
  /** The accepted capability ids (v3 drivers included); a node with a refused one is still listed. */
  capabilities: z.array(CapabilityIdSchema),
  /** Drivers the node announced (protocol 3); empty for a v1 or v2 node. */
  drivers: z.array(NodeDriverSchema).default([]),
  /** Capabilities the core refused, with the reason, shown to the owner in the Nodes section. */
  refused: z.array(NodeRefusedSchema).default([]),
  /** Node-side policy: whether `shell.exec` is enabled. */
  allowShell: z.boolean(),
  status: NodeStatusSchema,
  /** Epoch ms of the last heartbeat; null if never connected. */
  lastSeenAt: z.number().nullable(),
  /** Epoch ms. */
  createdAt: z.number(),
})
export type Node = z.infer<typeof NodeSchema>

/** Activity event type emitted when a node row changes. */
export const NODE_CHANGED = 'node-changed'

export const NodeChangedPayloadSchema = z.object({ node: NodeSchema })
export type NodeChangedPayload = z.infer<typeof NodeChangedPayloadSchema>

/** Pairing code for `nodes.pair`, shown once to the owner. */
export const PairingCodeSchema = z.object({
  /** Formatted `ABCD-EFGH`. */
  code: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
  /** Epoch ms. */
  expiresAt: z.number(),
  /** Command to run on the new node. */
  joinCommand: z.string(),
})
export type PairingCode = z.infer<typeof PairingCodeSchema>

// Settings (docs/specs/node-drivers.md, "Settings"): the calls per hour one person may make to a capability that runs without
// asking (`approval: 'never'`, the sandbox). Stored in the settings repo as `nodes.sandbox.maxPerHourPerPerson`; read by the
// motor at each call, so a change applies to the next call.
export const NODE_CALL_LIMIT_DEFAULT = 60
export const NODE_CALL_LIMIT_MIN = 1
export const NODE_CALL_LIMIT_MAX = 1000

export const NodeSettingsSchema = z.object({
  maxPerHourPerPerson: z.number().int().min(NODE_CALL_LIMIT_MIN).max(NODE_CALL_LIMIT_MAX),
})
export type NodeSettings = z.infer<typeof NodeSettingsSchema>
