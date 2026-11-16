import type { KeithPlugin } from '@keith/host'
import maps from '@keith/plugin-maps'
import notes from '@keith/plugin-notes'
import reminders from '@keith/plugin-reminders'
import web from '@keith/plugin-web'

/**
 * The plugins built into this core, in boot order. A static list: no discovery, no install flow (ADR-0016).
 * A built-in plugin is added here and as a dependency of `apps/core` (`plugins/<id>`). `web` comes first: it declares the
 * extension points of the web workspace that others contribute to (ADR-0038). Maps (`plugins/maps.md`) contributes the `maps:map` window. All are on by default; the owner can turn one off with the setting `plugins.<id>.enabled` (docs/specs/plugins.md).
 */
export const BUILTIN_PLUGINS: readonly KeithPlugin[] = [web, notes, reminders, maps]
