import type { ActionSpec, ManageEnv, Row, SectionData } from '../manage-types.ts'
import { useLoad } from '../use-load.ts'
import { budgetLines, parseUsd, personCells, usd } from './budget-state.ts'

/** Budget: the monthly limit and each person's cap. A member sees their own spend only. */
export function useBudgetSection(env: ManageEnv): SectionData {
  const { client, caps } = env
  const manage = caps.has('budget.manage')
  const load = useLoad(() => client.rpc.budget.get())
  const status = load.data
  const capFor = (person: string, label: string): ActionSpec => ({
    id: 'budget.cap',
    label: 'Set a cap',
    hint: 'monthly, in USD or none',
    fields: [{ id: 'usd', label: 'Cap (USD)', placeholder: '5 or none' }],
    run: async (v) => {
      const amount = parseUsd(v.usd ?? '')
      const row = await client.rpc.budget.setPersonCap({ person, usd: amount })
      return {
        message: `${label}: ${row.limitUsd === null ? 'no cap' : `cap ${usd(row.limitUsd)}`}, ${usd(row.spentUsd)} spent this month`,
      }
    },
  })
  const rows: Row[] = (status?.people ?? []).map((p) => ({
    id: p.personId,
    cells: personCells(p),
    actions: manage ? [capFor(p.username ?? p.personId, p.username ?? p.name)] : [],
  }))
  const setLimit: ActionSpec = {
    id: 'budget.set',
    label: 'Set the monthly limit',
    hint: 'USD or none',
    fields: [
      {
        id: 'usd',
        label: 'Limit (USD)',
        placeholder: '20 or none',
        initial: status?.limitUsd == null ? '' : String(status.limitUsd),
      },
    ],
    run: async (v) => {
      const limitUsd = parseUsd(v.usd ?? '')
      const done = await client.rpc.budget.set({ limitUsd })
      return {
        message: `limit: ${done.limitUsd === null ? 'none' : usd(done.limitUsd)}, ${usd(done.spentUsd)} spent this month`,
      }
    },
  }
  return {
    lines: status === undefined ? [] : budgetLines(status),
    header: ['PERSON', 'SPENT', 'CAP', ''],
    widths: [16, 10, 14],
    rows,
    empty: manage ? 'No people yet.' : '',
    actions: manage ? [setLimit] : [],
    error: load.error,
    loading: load.loading,
    reload: load.reload,
  }
}
