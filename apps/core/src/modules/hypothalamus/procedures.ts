// The protocol procedures (`protocols.*`, docs/specs/hypothalamus.md "RPC"). The handlers call the service with the
// caller of the turn; a `ProtocolError` becomes the RPC error of its code. The owner's pre-approval of an `act` over TCP
// needs a step-up (ADR-0022): the one check here that the contract metadata cannot express per input.

import type { ProtocolRunsRepo } from '@keith/db'
import { ORPCError } from '@orpc/server'
import { type RpcContext, rpc } from '../../platform/rpc.ts'
import { stepUpDenial } from '../auth/index.ts'
import type { AgendaService } from './agenda.ts'
import type { AnswerInput, AnswerOutcome } from './drive.ts'
import type { ProposalService } from './proposals.ts'
import type { ProtocolCaller, ProtocolService } from './service.ts'
import type { ProtocolSettingsReader } from './settings.ts'
import { ProtocolError } from './views.ts'

export interface ProtocolProcedureDeps {
  settings: ProtocolSettingsReader
  service: ProtocolService
  proposals: ProposalService
  /** Read by `answer` to check the caller is the person the run acts for (one principal per run, ADR-0020 §2). */
  runs: Pick<ProtocolRunsRepo, 'get'>
  /** The engine's answer (the same call the agent's `protocol_answer` tool makes). */
  answer(input: AnswerInput): Promise<AnswerOutcome>
}

const callerOf = (context: RpcContext): ProtocolCaller => ({
  id: context.principal.personId,
  role: context.principal.role,
  capabilities: context.capabilities,
  via: context.via,
})

/** Runs a service call; a refusal leaves as the RPC error of its code and reason, any other error is not the caller's. */
function refusing<T>(call: () => T): T {
  try {
    return call()
  } catch (error) {
    if (error instanceof ProtocolError) {
      // `data.reason` is the machine reason of the refusal (`author-rule`, `cap`, ...), null when there is none
      throw new ORPCError(error.code, {
        message: error.message,
        data: { reason: error.reason ?? null },
      })
    }
    throw error
  }
}

/** The RPC code of an engine refusal: a question that is not the caller's is as good as absent. */
const ANSWER_REFUSAL: Record<
  Exclude<AnswerOutcome['status'], 'answered'>,
  [code: string, message: string]
> = {
  'not-waiting': ['CONFLICT', 'the question is not open for an answer'],
  'not-open': ['CONFLICT', 'the question is not open for an answer'],
  lost: ['CONFLICT', 'the question is not open for an answer'],
  'not-yours': ['NOT_FOUND', 'there is no such question'],
  'bad-option': ['BAD_REQUEST', 'the answer is not one of the options of the question'],
}

export function protocolProcedures(deps: ProtocolProcedureDeps) {
  const { service, settings, proposals, runs } = deps
  return {
    list: rpc.protocols.list.handler(({ context }) => ({
      protocols: refusing(() => service.list(callerOf(context))),
    })),
    get: rpc.protocols.get.handler(({ input, context }) =>
      refusing(() => service.get(callerOf(context), input.id)),
    ),
    save: rpc.protocols.save.handler(({ input, context }) => {
      if (input.approve === true) {
        const denied = stepUpDenial(context.principal, context.via)
        if (denied !== undefined)
          throw new ORPCError(denied.code, { status: 403, message: denied.message })
      }
      return refusing(() => service.save(callerOf(context), input))
    }),
    setEnabled: rpc.protocols.setEnabled.handler(({ input, context }) =>
      refusing(() => service.setEnabled(callerOf(context), input.id, input.enabled)),
    ),
    pause: rpc.protocols.pause.handler(({ input, context }) =>
      refusing(() => service.pause(callerOf(context), input.id, input.until)),
    ),
    delete: rpc.protocols.delete.handler(({ input, context }) => {
      refusing(() => service.remove(callerOf(context), input.id))
      return { ok: true as const }
    }),
    runs: rpc.protocols.runs.handler(({ input, context }) => ({
      runs: refusing(() => service.runs(callerOf(context), input)),
    })),
    answer: rpc.protocols.answer.handler(async ({ input, context }) => {
      const caller = callerOf(context)
      // a run of another person is as good as absent: a member never answers another's question, and the owner does
      // not answer a member's (the run acts for one person; ADR-0020 §2)
      const run = runs.get(input.runId)
      if (run === undefined || run.person !== caller.id) {
        throw new ORPCError('NOT_FOUND', { message: 'there is no such question' })
      }
      const outcome = await deps.answer({
        runId: input.runId,
        by: caller.id,
        ...(input.option === undefined ? {} : { option: input.option }),
        ...(input.text === undefined ? {} : { text: input.text }),
      })
      if (outcome.status !== 'answered') {
        const [code, message] = ANSWER_REFUSAL[outcome.status]
        throw new ORPCError(code, { message, data: { reason: outcome.status } })
      }
      // the kind of answer only: the text of a free answer is never written to the audit log
      context.record('protocol.answer', {
        runId: input.runId,
        subject: caller.id,
        kind: input.option === undefined ? 'text' : 'option',
      })
      return { ok: true as const, runId: input.runId, status: 'answered' as const }
    }),
    proposals: rpc.protocols.proposals.handler(({ context }) => ({
      proposals: refusing(() => proposals.proposals(callerOf(context))),
    })),
    confirm: rpc.protocols.confirm.handler(({ input, context }) =>
      refusing(() => proposals.confirm(callerOf(context), input.id)),
    ),
    dismiss: rpc.protocols.dismiss.handler(({ input, context }) => {
      refusing(() => proposals.dismiss(callerOf(context), input.id))
      return { ok: true as const }
    }),
    settings: {
      get: rpc.protocols.settings.get.handler(() => settings.values()),
      set: rpc.protocols.settings.set.handler(({ input, context }) => {
        let change: ReturnType<ProtocolSettingsReader['set']>
        try {
          change = settings.set(input)
        } catch (error) {
          if (error instanceof RangeError)
            throw new ORPCError('BAD_REQUEST', { message: error.message })
          throw error
        }
        context.record('settings.protocols.set', change)
        return settings.values()
      }),
    },
  }
}

export interface AgendaProcedureDeps {
  agenda: AgendaService
}

/** The `agenda.*` procedures (hypothalamus.md "RPC input and output schemas"): the caller's own items, refusals as RPC errors. */
export function agendaProcedures(deps: AgendaProcedureDeps) {
  const { agenda } = deps
  return {
    list: rpc.agenda.list.handler(({ input, context }) => ({
      items: refusing(() => agenda.list(callerOf(context), input)),
    })),
    add: rpc.agenda.add.handler(({ input, context }) =>
      refusing(() => agenda.add(callerOf(context), input).item),
    ),
    done: rpc.agenda.done.handler(({ input, context }) =>
      refusing(() => agenda.done(callerOf(context), input.id)),
    ),
    cancel: rpc.agenda.cancel.handler(({ input, context }) =>
      refusing(() => agenda.cancel(callerOf(context), input.id)),
    ),
  }
}
