// The persona and style procedures (`persona.*`, docs/specs/prefrontal.md "RPC", ADR-0029 §2 and §3). The handlers read the
// caller from the context and call the persona and style services, which check the owner, the step-up and the closed values.
// The capability gate and the step-up of the call are the RPC middleware's (`authorize`); the services check the same again, so
// a call that bypasses the gate still changes nothing. A refusal leaves as the RPC error of its code, with `data.reason`.
import type { PersonaView, PersonStyle } from '@keith/contracts'
import { ORPCError } from '@orpc/server'
import { type RpcContext, rpc } from '../../platform/rpc.ts'
import { stepUpDenial } from '../auth/index.ts'
import { type PersonaService, type PrefrontalCaller, PrefrontalError } from './service.ts'
import type { PersonStyleService } from './style.ts'

export interface PrefrontalProcedureDeps {
  persona: PersonaService
  styles: PersonStyleService
}

/** The caller of a persona or style call: the person, the listener, and whether the call stepped up (PIN or local owner). */
export const prefrontalCallerOf = (context: RpcContext): PrefrontalCaller => ({
  by: context.principal.personId,
  via: context.via,
  elevated: stepUpDenial(context.principal, context.via) === undefined,
})

/** A service refusal as the RPC error of its code (`VALIDATION` is `BAD_REQUEST` on the wire); `data.reason` names the case. */
async function refusing<T>(call: () => T | Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (error instanceof PrefrontalError)
      throw new ORPCError(error.code === 'VALIDATION' ? 'BAD_REQUEST' : error.code, {
        message: error.message,
        data: { reason: error.reason ?? null },
      })
    throw error
  }
}

export function prefrontalProcedures(deps: PrefrontalProcedureDeps) {
  const { persona, styles } = deps

  /** The current persona; the first boot seeds it, so an absent one is a broken install, never a normal answer. */
  const current = (): PersonaView => {
    const view = persona.get()
    if (view === undefined) throw new ORPCError('NOT_FOUND', { message: 'there is no persona yet' })
    return view
  }

  return {
    get: rpc.persona.get.handler(() => current()),

    history: rpc.persona.history.handler(({ context }) =>
      refusing(() => persona.history(prefrontalCallerOf(context))),
    ),

    setTemplate: rpc.persona.setTemplate.handler(async ({ input, context }) => {
      await refusing(() => persona.setTemplate(prefrontalCallerOf(context), input.templateId))
      return current()
    }),

    edit: rpc.persona.edit.handler(async ({ input, context }) => {
      await refusing(() => persona.edit(prefrontalCallerOf(context), input.patch))
      return current()
    }),

    restore: rpc.persona.restore.handler(async ({ input, context }) => {
      await refusing(() => persona.restore(prefrontalCallerOf(context), input.version))
      return current()
    }),

    style: {
      get: rpc.persona.style.get.handler(
        ({ context }): PersonStyle => styles.get(prefrontalCallerOf(context)),
      ),

      set: rpc.persona.style.set.handler(({ input, context }) =>
        refusing(() => styles.set(prefrontalCallerOf(context), input.patch)),
      ),

      read: rpc.persona.style.read.handler(({ input, context }) =>
        refusing(() => styles.readStyleAs(prefrontalCallerOf(context), input.personId)),
      ),
    },
  }
}
