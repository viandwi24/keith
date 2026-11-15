import { reviewActions } from './reviews-actions.ts'
import { REVIEWS_HEADER, REVIEWS_WIDTHS, reviewRow } from './reviews-state.ts'
import type { SectionEnv, SectionModel } from './types.ts'

/** Reviews: what plugins hold for the owner (`admin.reviews.list`, pending); approve or deny. Owner only. */
export function reviewsSection({ client }: SectionEnv) {
  return {
    load: () => client.rpc.admin.reviews.list({ status: 'pending' }),
    build: (rows) => ({
      lines: [],
      header: REVIEWS_HEADER,
      widths: REVIEWS_WIDTHS,
      rows: (rows ?? []).map((r) => reviewRow(r, reviewActions(client, r))),
      empty: 'Nothing is waiting for you.',
      actions: [],
    }),
  } satisfies SectionModel<Awaited<ReturnType<typeof client.rpc.admin.reviews.list>>>
}
