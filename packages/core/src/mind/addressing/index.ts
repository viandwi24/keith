// Addressing detector (phase 5): whether a group input is addressed to the Mind.
// See docs/architecture/core.md#group-threads. Placeholder: P5-D1 builds the rule pass and the
// utility-model classifier behind this factory.

import type { KeithConfig } from '../../config/types.ts'
import type { Scheduler } from '../../scheduler/types.ts'
import type { Logger } from '../../shared/types.ts'
import type { AddressingDetector, RunLoop } from '../types.ts'

export type AddressingDeps = {
  /** `mind.name` (name mentions) and `mind.group.addressing` ('rules+utility' or 'rules'). */
  config: Pick<KeithConfig, 'mind'>
  /** Runs the classifier: one `utility` step, no tools, `persist: null`. */
  runLoop: RunLoop
  /** The classifier runs in the `foreground` lane, because a human is waiting (I-5). */
  scheduler: Pick<Scheduler, 'run'>
  log: Logger
}

/** Placeholder: every input is addressed (`by: 'default'`), which is the phase-4 behavior. */
export function createAddressing(_deps: AddressingDeps): AddressingDetector {
  return {
    async decide() {
      return { addressed: true, by: 'default' }
    },
  }
}
