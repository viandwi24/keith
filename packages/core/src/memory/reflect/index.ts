// Reflection (phase 4, ADR-0014): idle threads become inferred memories and relationship notes.
// See docs/architecture/memory.md#reflection.

import type { KeithConfig } from '../../config/types.ts'
import type { CoreEventBus } from '../../events/types.ts'
import type { RunLoop } from '../../mind/types.ts'
import type { Scheduler } from '../../scheduler/types.ts'
import type { Clock, Ids, Logger } from '../../shared/types.ts'
import type { Repositories } from '../../storage/types.ts'
import type { MemoryJob, MemoryService, Reflector } from '../types.ts'
import { createReflectionJob } from './job.ts'
import { createReflector } from './reflector.ts'

export type ReflectionDeps = {
  /** `memory.reflect` drives the job; `mind` gives the time zone and the Mind's name for prompts. */
  config: Pick<KeithConfig, 'memory' | 'mind'>
  repos: Pick<Repositories, 'threads' | 'messages' | 'memories' | 'relationships' | 'persons'>
  /** New memories go through `write`, so `memory.written` is emitted. */
  memory: MemoryService
  /** Utility-model calls: `modelRole: 'utility'`, no tools, one step, `persist: null`. */
  runLoop: RunLoop
  /** Passes run in the `background` lane. */
  scheduler: Pick<Scheduler, 'run'>
  /** The job subscribes to `scheduler.ticked`; the reflector emits `memory.reflected`. */
  events: CoreEventBus
  clock: Clock
  ids: Ids
  log: Logger
}

export type Reflection = { reflector: Reflector; job: MemoryJob }

/** Builds the reflector and its tick-driven job. Bootstrap starts the job (P4-I1). */
export function createReflection(deps: ReflectionDeps): Reflection {
  const reflector = createReflector(deps)
  return { reflector, job: createReflectionJob({ ...deps, reflector }) }
}
