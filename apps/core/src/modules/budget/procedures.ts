import { ORPCError } from '@orpc/server'
import { rpc } from '../../platform/rpc.ts'
import type { PeopleService } from '../people/index.ts'
import type { Budget } from './budget.ts'

/** oRPC `budget.get`, `budget.set` and `budget.setPersonCap` (the Keith contract). */
export function budgetProcedures(budget: Budget, people: Pick<PeopleService, 'list' | 'get'>) {
  const row = async (ref: string) => {
    const p = await people.get(ref).catch(() => undefined)
    if (p === undefined) throw new ORPCError('NOT_FOUND', { message: `no person ${ref}` })
    return p
  }
  return {
    // a manager sees the global limit and everyone; anyone else only their own spend and cap
    get: rpc.budget.get.handler(async ({ context }) => {
      if (!context.capabilities.has('budget.manage'))
        return budget.statusOf(context.principal.personId)
      const everyone = await people.list()
      return {
        ...budget.status(),
        people: everyone.map((p) => ({
          personId: p.id,
          username: p.username,
          name: p.name,
          ...budget.person(p.id),
        })),
      }
    }),
    set: rpc.budget.set.handler(({ input }) => budget.set(input.limitUsd)),
    setPersonCap: rpc.budget.setPersonCap.handler(async ({ input }) => {
      const p = await row(input.person)
      return {
        personId: p.id,
        username: p.username,
        name: p.name,
        ...budget.setPersonCap(p.id, input.usd),
      }
    }),
  }
}
