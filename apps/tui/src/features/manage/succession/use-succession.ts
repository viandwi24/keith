import type { SuccessionOwnerView } from '@keith/contracts'
import type { ActionSpec, ManageEnv, SectionData } from '../manage-types.ts'
import { clock } from '../protocols/protocols-state.ts'
import { useLoad } from '../use-load.ts'
import { eligibleHeirs, parsePauseDays, parseWindow, pauseUntil } from './succession-actions.ts'
import { ownerLines } from './succession-state.ts'

/**
 * Succession (owner only, `succession.manage`): the heir, the window, the pause and the last sign. Every change is a
 * sensitive call, so the step-up prompt opens on it (the guard). The rows are the info lines; the actions are the list.
 */
export function useSuccession(env: ManageEnv): SectionData {
  const { client } = env
  const load = useLoad(async () => {
    const [view, people] = await Promise.all([
      client.rpc.admin.succession.get(),
      client.rpc.admin.people.list(),
    ])
    return { view, heirs: eligibleHeirs(people), now: Date.now() }
  })
  const d = load.data
  const view: SuccessionOwnerView | undefined = d?.view.role === 'owner' ? d.view : undefined
  const now = d?.now ?? Date.now()
  const heirs = d?.heirs ?? []
  const names = heirs.map((p) => p.username ?? p.id)

  const actions: ActionSpec[] =
    view === undefined
      ? []
      : [
          {
            id: 'succession.heir',
            label: 'Set the heir',
            hint:
              names.length === 0 ? 'no member can sign in yet' : 'an active member who can sign in',
            ...(names.length === 0
              ? {}
              : {
                  fields: [{ id: 'heir', label: 'Heir', options: names, initial: names[0] ?? '' }],
                }),
            run: async (v) => {
              const chosen = heirs.find((p) => (p.username ?? p.id) === v.heir)
              if (chosen === undefined) throw new Error('no member can be the heir yet')
              await client.rpc.admin.succession.setHeir({ person: chosen.id })
              return { message: `heir: ${chosen.name}` }
            },
          },
          ...(view.heir === null
            ? []
            : [
                {
                  id: 'succession.clear',
                  label: 'Clear the heir',
                  hint: 'switches the protocol off',
                  confirm: {
                    text: `Clear ${view.heir.name} as the heir? The succession stops until you name one.`,
                  },
                  run: async () => {
                    await client.rpc.admin.succession.clearHeir()
                    return { message: 'heir cleared: the succession is off' }
                  },
                } satisfies ActionSpec,
              ]),
          {
            id: 'succession.window',
            label: 'Set the window',
            hint: 'days of silence before the grace, 7 to 90',
            fields: [
              {
                id: 'days',
                label: 'Days',
                initial: view === undefined ? '' : String(view.windowDays),
              },
            ],
            run: async (v) => {
              const days = parseWindow(v.days ?? '')
              await client.rpc.admin.succession.setWindow({ days })
              return { message: `window: ${days} days` }
            },
          },
          {
            id: 'succession.pause',
            label: 'Pause for a trip',
            hint: 'days, up to 180; a pause counts as a sign',
            fields: [{ id: 'days', label: 'Days', placeholder: '14' }],
            run: async (v) => {
              const until = pauseUntil(parsePauseDays(v.days ?? ''), Date.now())
              await client.rpc.admin.succession.pause({ until: Math.round(until) })
              return { message: `paused until ${clock(until)}` }
            },
          },
          ...(view !== undefined && view.pausedUntil !== null && view.pausedUntil > now
            ? [
                {
                  id: 'succession.resume',
                  label: 'Resume',
                  hint: 'ends the pause now',
                  run: async () => {
                    await client.rpc.admin.succession.resume()
                    return { message: 'succession resumed' }
                  },
                } satisfies ActionSpec,
              ]
            : []),
        ]

  return {
    lines:
      d === undefined
        ? []
        : view === undefined
          ? ['Only the owner changes the succession.']
          : ownerLines(view, now),
    rows: [],
    empty: '',
    actions,
    error: load.error,
    loading: load.loading,
    reload: load.reload,
  }
}
