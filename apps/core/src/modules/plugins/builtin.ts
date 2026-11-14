import type { KeithPlugin } from '@keith/host'
import notes from '@keith/plugin-notes'
import reminders from '@keith/plugin-reminders'

/**
 * The plugins built into this core, in boot order. A static list: no discovery, no install flow (ADR-0016).
 * A built-in plugin is added here and as a dependency of `apps/core` (`plugins/<id>`). Notes and Reminders are on
 * by default; the owner can turn one off with the setting `plugins.<id>.enabled` (docs/specs/plugins.md).
 */
export const BUILTIN_PLUGINS: readonly KeithPlugin[] = [notes, reminders]
