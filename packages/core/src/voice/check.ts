// Startup check of the `[voice]` provider ids (P3-I1). The pipeline looks providers up lazily on
// every stream, so without this a typo would only show up as refused streams at runtime.

import { KeithError } from '@keith/sdk'
import type { VoiceConfig } from '../config/types.ts'
import type { VoiceDeps } from './deps.ts'

/**
 * Throws `CONFIG_INVALID` naming the first `voice.vad` / `voice.stt` / `voice.tts` id that no
 * enabled plugin registered, with the ids that are registered. No `[voice]`: nothing to check.
 */
export function checkVoiceProviders(
  config: VoiceConfig | undefined,
  providers: VoiceDeps['providers'],
): void {
  if (!config) return
  for (const role of ['vad', 'stt', 'tts'] as const) {
    const id = config[role]
    const known = providers[role].list().map((p) => p.id)
    if (known.includes(id)) continue
    const registered = known.length > 0 ? known.join(', ') : 'none'
    throw new KeithError(
      'CONFIG_INVALID',
      `voice.${role} = '${id}' names an unknown ${role} provider (registered: ${registered}). Enable the plugin that provides it in plugins.enabled.`,
      { details: { key: `voice.${role}`, id, registered: known } },
    )
  }
}
