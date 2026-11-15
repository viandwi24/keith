// Conversational consent, wired (ADR-0036, docs/specs/amygdala.md "Asked in conversation"): the seam where the person's chat message
// answers a request asked in conversation, and the voice that asks the front agent to say a worker's request. compose.ts and
// compose-regions.ts call these; the logic lives in `modules/amygdala`.

import type { HarnessAgent, SessionLock } from 'eharness'
import type { ActivityStore } from 'eharness/activity'
import {
  type AttentionOptions,
  type ClientAuth,
  type Consent,
  type ConsentNotes,
  createConsentConversation,
  createConsentVoice,
  type FreshApproval,
} from './modules/amygdala/index.ts'
import type { Audit } from './modules/audit/index.ts'
import type { Delivery } from './modules/delivery/index.ts'
import { type ProviderService, resolveRoleModel } from './modules/providers/index.ts'
import type { ChatMessagePort } from './modules/thalamus/index.ts'
import type { Logger } from './platform/logger.ts'
import { type FrontGenerationOf, frontSessionId, frontSessionOptions } from './platform/sessions.ts'

export interface ConsentWiringDeps {
  attention: AttentionOptions
  consent: Pick<Consent, 'registry'>
  clients: ClientAuth
  generations: FrontGenerationOf
  store: ActivityStore
  audit: Audit
  providers: ProviderService
  /** Wraps the classifier's model so its calls reach the activity logs (`observeAux`). */
  observe?: (
    name: string,
    personId: string,
    model: Awaited<ReturnType<typeof resolveRoleModel>>,
  ) => Awaited<ReturnType<typeof resolveRoleModel>>
  ttlMs: () => number
  logger: Logger
  /** The front agent and the shared lock: a worker's answer reaches the front session as an input (queued when it is busy). */
  agent: HarnessAgent
  lock: SessionLock
  /** The notes the front agent reads with those inputs (`consent-note.ts`; its plugin sits on the front agent). */
  notes: ConsentNotes
}

/** The chat seam of thalamus: the person's message may answer a request asked in conversation. */
export function createConsentPort(deps: ConsentWiringDeps): ChatMessagePort {
  const conversation = createConsentConversation({
    attention: deps.attention,
    registry: deps.consent.registry,
    generations: deps.generations,
    store: deps.store,
    audit: deps.audit,
    clients: deps.clients,
    ttlMs: deps.ttlMs,
    warn: (message) => deps.logger.warn(message),
    // the person's answer to a worker's request goes to the front session like any message; a busy session (a worker report
    // wake holds the lock) queues it instead of answering 409 (eharness spec 11 §6.2)
    forward: async ({ personId, text, note }) => {
      const id = frontSessionId(personId, deps.generations.current(personId))
      deps.notes.put(id, text, note)
      try {
        const run = deps.agent
          .session(id, frontSessionOptions(id, deps.lock))
          .send(text, { ifBusy: 'queue' })
        // not awaited: a queued run is accepted only when its turn starts, which may be a long turn away
        void run.accepted.then((refused) => {
          if (refused === undefined) return
          deps.notes.drop(id, text, note)
          deps.logger.warn(
            `consent: the answer was not accepted by the front session: ${refused.code}`,
          )
        })
        void run.result.catch(() => undefined)
      } catch (error) {
        deps.notes.drop(id, text, note)
        throw error
      }
    },
    // the small call runs on the front role's model with a tiny prompt (no cheaper role exists); thinking is off for it
    model: async (personId) => {
      const model = await resolveRoleModel('front', deps.providers, 'consent')
      return deps.observe === undefined ? model : deps.observe('consent', personId, model)
    },
  })
  return { message: (call) => conversation.message(call) }
}

/** The voice of a worker's request: `watchPending` calls it for each new approval; it audits and wakes the front agent. */
export function createConsentVoiceHook(
  deps: Pick<ConsentWiringDeps, 'attention' | 'consent' | 'audit' | 'ttlMs' | 'logger'> & {
    delivery: Pick<Delivery, 'deliver'>
  },
): (fresh: FreshApproval) => Promise<void> {
  return createConsentVoice({
    attention: deps.attention,
    registry: deps.consent.registry,
    delivery: deps.delivery,
    audit: deps.audit,
    ttlMs: deps.ttlMs,
    warn: (message) => deps.logger.warn(message),
  })
}
