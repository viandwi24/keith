import type { KeithClient } from '@keith/client'
import type { ReviewView } from '@keith/contracts'
import type { ActionSpec } from '../manage-types.ts'
import { requesterName, requestNote } from './reviews-state.ts'

/** Every action on one pending review; each is one `client.rpc.admin.reviews.*` call, as `keith-core reviews` makes. */
export function reviewActions(client: KeithClient, r: ReviewView): ActionSpec[] {
  const api = client.rpc.admin.reviews
  const who = requesterName(r)
  const op = `${r.plugin}.${r.operation}`
  return [
    {
      id: 'reviews.show',
      label: 'Show the request',
      hint: 'the full input, as data',
      run: async () => ({ note: requestNote(r) }),
    },
    {
      id: 'reviews.approve',
      label: 'Approve',
      hint: 'runs it as the requester',
      confirm: {
        text: `Run ${op} as ${who}? It runs with their rights, checked now.`,
      },
      run: async () => {
        const done = await api.approve({ id: r.id })
        return {
          message:
            done.outcome === 'ok'
              ? `approved: ${op} ran as ${who}`
              : `approved, but it did not run (${done.outcome ?? 'no outcome'})`,
        }
      },
    },
    {
      id: 'reviews.deny',
      label: 'Deny',
      hint: 'the requester can read the reason',
      fields: [{ id: 'reason', label: 'Reason', optional: true, placeholder: 'optional' }],
      run: async (v) => {
        const reason = (v.reason ?? '').trim()
        await api.deny({ id: r.id, ...(reason === '' ? {} : { reason }) })
        return { message: `denied: ${op} for ${who}` }
      },
    },
  ]
}
