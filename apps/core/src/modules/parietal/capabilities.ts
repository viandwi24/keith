// The client capability registry (docs/specs/parietal.md, "Client capability registry and route"; ADR-0023 §5). These are the
// things a client can be asked to do. Ids are exactly the ADR's (`notify`, `open.view`, `location.share`), never prefixed.
// Only the person's own turns and the delivery route may call them (`parietal.callClient`).

import {
  type DeliveryRequest,
  RENDER_CAPABILITY_IDS,
  type RenderCapability,
  RenderCapabilitySchema,
} from '@keith/contracts'
import { z } from 'zod'

/** The client capabilities the core knows. A client that announces another id is never asked. */
export const CLIENT_CAPABILITY_IDS = ['notify', 'open.view', 'location.share'] as const
export type ClientCapabilityId = (typeof CLIENT_CAPABILITY_IDS)[number]

/** The most text a `notify` shows (the client's toast); a longer delivery text is clipped for the client only. */
export const NOTIFY_TEXT_MAX = 500

export interface ClientCapabilitySpec {
  id: ClientCapabilityId
  /** `write` changes what the person sees or does; `external` leaves the device (opt-in on the client). */
  risk: 'write' | 'external'
  /** The input a call carries; `callClient` refuses an input that does not parse. */
  input: z.ZodType
  /** True when a delivery can carry its request into this capability (`deliveryInput`). */
  deliverable: boolean
}

export const NotifyInputSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  text: z.string().min(1).max(NOTIFY_TEXT_MAX),
  level: z.enum(['info', 'warning', 'error']).optional(),
})

export const OpenViewInputSchema = z.object({
  view: z.string().regex(/^(plugin:[a-z0-9_-]+:[a-z0-9_-]+|room:[a-z0-9_-]+|tasks|protocols)$/),
  args: z.record(z.string(), z.unknown()).optional(),
})

export const LocationShareInputSchema = z.object({
  precision: z.enum(['city', 'coarse']),
})

export const CLIENT_CAPABILITIES: Record<ClientCapabilityId, ClientCapabilitySpec> = {
  notify: { id: 'notify', risk: 'write', input: NotifyInputSchema, deliverable: true },
  'open.view': { id: 'open.view', risk: 'write', input: OpenViewInputSchema, deliverable: false },
  'location.share': {
    id: 'location.share',
    risk: 'external',
    input: LocationShareInputSchema,
    deliverable: false,
  },
}

/**
 * The rendering ids a client declares on register (ADR-0029 §5, `presence.ts`). They are not in `CLIENT_CAPABILITY_IDS`: the core
 * never asks a client for them, it reads them to choose the mode of an answer. A client declares neither: plain text.
 */
export const CLIENT_RENDER_IDS = RENDER_CAPABILITY_IDS

/** True for a rendering id a client may declare (a closed set: `render.table` is not one). */
export function isClientRenderId(value: string): value is RenderCapability {
  return RenderCapabilitySchema.safeParse(value).success
}

/** True for an id of the registry (a string from a request or a client record may be anything). */
export function isClientCapabilityId(value: string): value is ClientCapabilityId {
  return (CLIENT_CAPABILITY_IDS as readonly string[]).includes(value)
}

/**
 * The input a delivery gives a deliverable capability: `notify` shows the request text, clipped to the client's limit.
 * `undefined` for a capability no delivery can carry (the planner then offers no client route for it).
 */
export function deliveryInput(capability: string, request: DeliveryRequest): unknown | undefined {
  if (capability === 'notify') return { text: request.text.slice(0, NOTIFY_TEXT_MAX) }
  return undefined
}
