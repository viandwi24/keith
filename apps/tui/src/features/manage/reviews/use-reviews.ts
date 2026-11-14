import type { ManageEnv, SectionData } from '../manage-types.ts'
import { useLoad } from '../use-load.ts'
import { reviewActions } from './reviews-actions.ts'
import { REVIEWS_HEADER, REVIEWS_WIDTHS, reviewRow } from './reviews-state.ts'

/** Reviews: what plugins hold for the owner (`admin.reviews.list`, pending); approve or deny. Owner only. */
export function useReviews(env: ManageEnv): SectionData {
  const { client } = env
  const load = useLoad(() => client.rpc.admin.reviews.list({ status: 'pending' }))
  const rows = load.data ?? []
  return {
    lines: [],
    header: REVIEWS_HEADER,
    widths: REVIEWS_WIDTHS,
    rows: rows.map((r) => reviewRow(r, reviewActions(client, r))),
    empty: 'Nothing is waiting for you.',
    actions: [],
    error: load.error,
    loading: load.loading,
    reload: load.reload,
  }
}
