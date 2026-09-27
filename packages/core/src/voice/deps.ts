// What the voice pipeline needs from the rest of the core. Built by bootstrap (P3-I1).

import type { SttProvider, TtsProvider, VadProvider } from '@keith/sdk'
import type { VoiceConfig } from '../config/types.ts'
import type { ThreadManager } from '../mind/types.ts'
import type { AttachmentRegistry } from '../server/types.ts'
import type { Clock, Ids, Logger, NodeId } from '../shared/types.ts'

export type VoiceDeps = {
  /** The provider lists (`CoreProviderRegistries` fits). Looked up by id on every stream/reply. */
  providers: {
    vad: { list(): VadProvider[] }
    stt: { list(): SttProvider[] }
    tts: { list(): TtsProvider[] }
  }
  /** `config.voice`. Undefined: voice is off. */
  config: VoiceConfig | undefined
  threads: Pick<ThreadManager, 'input' | 'voiceActivity'>
  /** Frames to nodes: JSON (`audio.start` / `audio.end` / `audio.stop`) and kind-2 binary chunks. */
  nodes: Pick<AttachmentRegistry, 'send' | 'sendBinary'>
  /** The capabilities a connected node declared in `hello` (`audio.out@1` gates speech output). */
  capabilities(nodeId: NodeId): readonly string[]
  ids: Ids
  clock: Clock
  log: Logger
}

/** A bare ULID (stream ids, frame ids) from the prefixed generator. */
export function bareUlid(ids: Ids): string {
  const id = ids.next('trn')
  return id.slice(id.indexOf('_') + 1)
}

export function findProvider<P extends { id: string }>(list: { list(): P[] }, id: string): P | undefined {
  return list.list().find((p) => p.id === id)
}
