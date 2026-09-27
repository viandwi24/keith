// The core's side of the event bus. Contract: docs/contracts/events.md. Implemented by events/
// (task P1-A1).

import type { EventBus } from '@keith/sdk'
import type { PluginScoped } from '../plugins/types.ts'

/**
 * The bus as the core uses it. The core may emit in any namespace; plugins get a scoped view
 * (`forPlugin`) that only emits in the plugin's namespace, validates payloads against schemas from
 * `define`, and tags handler errors with the plugin id.
 */
export interface CoreEventBus extends EventBus, PluginScoped<EventBus> {
  /** Resolves when every handler queued so far has run. For tests and shutdown. */
  idle(): Promise<void>
}
