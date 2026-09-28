// Addressing detector (phase 5): whether a group input is addressed to the Mind. A cheap rule pass
// decides most inputs; with `mind.group.addressing = "rules+utility"` the `utility` model decides
// the rest. Still unsure means not addressed. See docs/architecture/core.md#group-threads.

import type { KeithConfig } from '../../config/types.ts'
import type { Scheduler } from '../../scheduler/types.ts'
import type { Logger } from '../../shared/types.ts'
import type { AddressingDetector, AddressingVerdict, RunLoop } from '../types.ts'
import { classify } from './classifier.ts'
import { decideByRules } from './rules.ts'

export type AddressingDeps = {
  /** `mind.name` (name mentions) and `mind.group.addressing` ('rules+utility' or 'rules'). */
  config: Pick<KeithConfig, 'mind'>
  /** Runs the classifier: one `utility` step, no tools, `persist: null`. */
  runLoop: RunLoop
  /** The classifier runs in the `foreground` lane, because a human is waiting (I-5). */
  scheduler: Pick<Scheduler, 'run'>
  log: Logger
}

const UNSURE: AddressingVerdict = { addressed: false, by: 'unsure' }

export function createAddressing(deps: AddressingDeps): AddressingDetector {
  const log = deps.log.child({ component: 'addressing' })
  return {
    async decide(a) {
      let verdict: AddressingVerdict
      try {
        verdict = decideByRules({
          mindName: deps.config.mind.name,
          input: a.input,
          recent: a.recent,
          participantNames: a.participantNames,
        })
      } catch (error) {
        log.warn('addressing rules failed', {
          threadId: a.threadId,
          error: error instanceof Error ? error.name : typeof error,
        })
        return UNSURE
      }
      if (verdict.by !== 'unsure' || deps.config.mind.group.addressing !== 'rules+utility') return verdict
      return classify({ ...deps, log }, a)
    },
  }
}
