// The context procedures (`chat.newContext`, `chat.compact`, `chat.generations`, `chat.history`; docs/specs/chat-context.md
// "RPC", ADR-0030 §8). The handlers read the caller from the context and call the context service, which works on the
// caller's own front session only: no call takes a person id. No step-up (ADR-0030 §8). A refusal leaves as the RPC error of
// its code, with `data.reason` (`CONFLICT` for the refusals, `NOT_FOUND` for an unknown generation).
import { ORPCError } from '@orpc/server'
import { type RpcContext, rpc } from '../../platform/rpc.ts'
import { type ChatCaller, ChatContextError, type ContextService } from './context-service.ts'

export interface ChatProcedureDeps {
  context: ContextService
}

/** The caller of a context call: the signed-in person (the session's principal) and the listener of the call. */
export const chatCallerOf = (context: RpcContext): ChatCaller => ({
  by: context.principal.personId,
  via: context.via,
})

/** A service refusal as the RPC error of its code, with `data.reason` (null for NOT_FOUND). */
async function refusing<T>(call: () => T | Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (error instanceof ChatContextError)
      throw new ORPCError(error.code, {
        message: error.message,
        data: { reason: error.reason ?? null },
      })
    throw error
  }
}

export function chatProcedures(deps: ChatProcedureDeps) {
  const { context } = deps
  return {
    newContext: rpc.chat.newContext.handler(({ input, context: rpcContext }) =>
      refusing(() => context.newContext(chatCallerOf(rpcContext), { flush: input.flush })),
    ),

    compact: rpc.chat.compact.handler(({ input, context: rpcContext }) =>
      refusing(() => context.compact(chatCallerOf(rpcContext), input)),
    ),

    generations: rpc.chat.generations.handler(({ context: rpcContext }) =>
      refusing(() => context.generations(chatCallerOf(rpcContext))),
    ),

    history: rpc.chat.history.handler(({ input, context: rpcContext }) =>
      refusing(() => context.history(chatCallerOf(rpcContext), input)),
    ),
  }
}
