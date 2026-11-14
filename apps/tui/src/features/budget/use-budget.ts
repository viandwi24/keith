import type { KeithClient } from '@keith/client'
import type { BudgetStatus } from '@keith/contracts'
import { useCallback, useEffect, useState } from 'react'

export interface BudgetHandle {
  budget: BudgetStatus | undefined
  /** Read the budget again (a `budget-changed` event, a resync). */
  reload(): void
}

/** The month's budget: read at mount, on `reload()` and every `pollMs` (default 60 s). */
export function useBudget(client: KeithClient, pollMs = 60_000): BudgetHandle {
  const [budget, setBudget] = useState<BudgetStatus | undefined>()
  const reload = useCallback(() => {
    client.rpc.budget
      .get()
      .then(setBudget)
      .catch(() => undefined) // the next event or tick tries again; the header keeps the last value
  }, [client])
  useEffect(() => {
    reload()
    const timer = setInterval(reload, pollMs)
    return () => clearInterval(timer)
  }, [reload, pollMs])
  return { budget, reload }
}
