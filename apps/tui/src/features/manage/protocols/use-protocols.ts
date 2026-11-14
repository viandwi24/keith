import { MS_HOUR, type ProtocolView } from '@keith/contracts'
import { codeOf, messageOf } from '../../chat/question-state.ts'
import type { ActionSpec, ManageEnv, Row, SectionData } from '../manage-types.ts'
import { useLoad } from '../use-load.ts'
import { reminderSave } from './protocols-reminder.ts'
import {
  askLines,
  clock,
  headerOf,
  isPaused,
  type ListWho,
  lastRunOf,
  openAskOf,
  proposalDetail,
  protocolDetail,
  protocolRows,
  widthsOf,
} from './protocols-state.ts'

/** Runs read for the last-run column and the details (the newest of all the person's protocols). */
const RUN_LIMIT = 100

const number = (text: string | undefined, what: string): number => {
  const n = Number((text ?? '').trim())
  if (!Number.isFinite(n) || n <= 0 || (text ?? '').trim() === '') throw new Error(`enter ${what}`)
  return n
}

/**
 * Protocols: the person's own (the owner also sees every person's and `keith`'s). Pending proposals are the top rows; a
 * row opens its details, pauses or resumes, or deletes it (asked first). The first action is a reminder: a time and a
 * text make a protocol of the reminder ladder. The owner also sets the engine limits and the approval ping.
 */
export function useProtocols(env: ManageEnv): SectionData {
  const { client, me } = env
  const owner = me.role === 'owner'
  const load = useLoad(async () => {
    const [list, runs, proposals] = await Promise.all([
      client.rpc.protocols.list(),
      client.rpc.protocols.runs({ limit: RUN_LIMIT }),
      client.rpc.protocols.proposals(),
    ])
    const settings = owner ? await client.rpc.protocols.settings.get() : undefined
    const approvals = owner ? await client.rpc.admin.approvals.get() : undefined
    return {
      views: list.protocols,
      runs: runs.runs,
      proposals: proposals.proposals,
      settings,
      approvals,
      now: Date.now(),
    }
  })
  const d = load.data
  const now = d?.now ?? Date.now()
  const who: ListWho = { personId: me.personId, owner }

  const details = (view: ProtocolView): ActionSpec => ({
    id: 'protocol.details',
    label: 'Details',
    hint: 'definition and last runs',
    run: async () => ({ note: protocolDetail(view, d?.runs ?? [], now) }),
  })

  const viewActions = (view: ProtocolView): readonly ActionSpec[] => {
    const pause: ActionSpec = isPaused(view, now)
      ? {
          id: 'protocol.resume',
          label: 'Resume',
          run: async () => {
            await client.rpc.protocols.pause({ id: view.id, until: null })
            return { message: `${view.name}: resumed` }
          },
        }
      : {
          id: 'protocol.pause',
          label: 'Pause',
          hint: 'for some hours',
          fields: [{ id: 'hours', label: 'Hours', initial: '24' }],
          run: async (v) => {
            const until = Date.now() + number(v.hours, 'a number of hours') * MS_HOUR
            await client.rpc.protocols.pause({ id: view.id, until: Math.round(until) })
            return { message: `${view.name}: paused until ${clock(until)}` }
          },
        }
    const remove: ActionSpec = {
      id: 'protocol.delete',
      label: 'Delete',
      confirm: { text: `Delete "${view.name}"? This cannot be undone.` },
      run: async () => {
        await client.rpc.protocols.delete({ id: view.id })
        return { message: `${view.name}: deleted` }
      },
    }
    const ask = openAskOf(view, lastRunOf(d?.runs ?? [], view.id))
    const answer: ActionSpec[] =
      ask === undefined
        ? []
        : [
            {
              id: 'protocol.answer',
              label: 'Answer',
              hint: 'the question the run waits on',
              fields: [
                ask.options.length > 0
                  ? {
                      id: 'option',
                      label: 'Answer',
                      options: ask.options,
                      initial: ask.options[0] ?? '',
                    }
                  : { id: 'text', label: 'Answer', placeholder: 'your answer' },
              ],
              run: async (v) => {
                const input =
                  ask.options.length > 0
                    ? { runId: ask.runId, option: v.option ?? '' }
                    : { runId: ask.runId, text: (v.text ?? '').trim() }
                if (ask.options.length === 0 && input.text === '')
                  throw new Error('enter an answer')
                try {
                  await client.rpc.protocols.answer(input)
                } catch (error) {
                  if (codeOf(error) === 'CONFLICT') throw new Error('question closed')
                  throw new Error(messageOf(error))
                }
                return { message: `${view.name}: answered` }
              },
            },
          ]
    return [...answer, details(view), pause, ...(view.builtIn === null ? [remove] : [])]
  }

  const proposalActions = (
    p: NonNullable<typeof d>['proposals'][number],
  ): readonly ActionSpec[] => [
    {
      id: 'proposal.confirm',
      label: 'Confirm',
      hint: 'save it as a protocol',
      run: async () => {
        const saved = await client.rpc.protocols.confirm({ id: p.id })
        return { message: `saved: ${saved.name}` }
      },
    },
    {
      id: 'proposal.dismiss',
      label: 'Dismiss',
      hint: 'drop it for good',
      run: async () => {
        await client.rpc.protocols.dismiss({ id: p.id })
        return { message: `dismissed: ${p.reason}` }
      },
    },
    {
      id: 'proposal.details',
      label: 'Details',
      run: async () => ({ note: proposalDetail(p) }),
    },
  ]

  const reminder: ActionSpec = {
    id: 'reminder.new',
    label: 'New reminder',
    hint: 'a text at a time',
    fields: [
      { id: 'text', label: 'Remind me to', placeholder: 'call Ana back' },
      { id: 'when', label: 'When', placeholder: '18:30 or 2026-11-12 09:00' },
    ],
    run: async (v) => {
      const saved = await client.rpc.protocols.save(
        reminderSave({ text: v.text ?? '', when: v.when ?? '' }, Date.now()),
      )
      const at = saved.definition.trigger.kind === 'time' ? saved.definition.trigger.at : undefined
      return { message: `reminder set for ${at === undefined ? 'the time' : clock(at)}` }
    },
  }

  const ownerActions: readonly ActionSpec[] = !owner
    ? []
    : [
        {
          id: 'protocols.limits',
          label: 'Set the limits',
          hint: 'tick, per person, runs a day',
          fields: [
            { id: 'tick', label: 'Tick (ms)', initial: String(d?.settings?.tickMs ?? '') },
            {
              id: 'perPerson',
              label: 'Protocols per person',
              initial: String(d?.settings?.maxPerPerson ?? ''),
            },
            {
              id: 'runsDay',
              label: 'Runs a day per person',
              initial: String(d?.settings?.maxPerPersonRunsPerDay ?? ''),
            },
          ],
          run: async (v) => {
            const s = await client.rpc.protocols.settings.set({
              tickMs: number(v.tick, 'a tick in ms'),
              maxPerPerson: number(v.perPerson, 'a number'),
              maxPerPersonRunsPerDay: number(v.runsDay, 'a number'),
            })
            return {
              message: `limits: tick ${s.tickMs} ms, ${s.maxPerPerson} per person, ${s.maxPerPersonRunsPerDay} runs a day`,
            }
          },
        },
        {
          id: 'protocols.ping',
          label: 'Set the expiry ping',
          hint: 'hours before an approval expires',
          fields: [
            {
              id: 'hours',
              label: 'Ping (hours before expiry)',
              initial: String(d?.approvals?.pingBeforeHours ?? ''),
            },
          ],
          run: async (v) => {
            const a = await client.rpc.admin.approvals.set({
              pingBeforeHours: number(v.hours, 'a number of hours'),
            })
            return { message: `approvals: ping ${a.pingBeforeHours} h before expiry` }
          },
        },
      ]

  const rows: Row[] =
    d === undefined
      ? []
      : protocolRows({
          views: d.views,
          proposals: d.proposals,
          runs: d.runs,
          now,
          me: who,
          actions: { proposal: proposalActions, view: viewActions },
        })

  return {
    lines: d === undefined ? [] : askLines(d.views, d.runs),
    header: headerOf(who),
    widths: widthsOf(who),
    rows,
    empty: 'No protocols yet. n sets a reminder.',
    actions: [reminder, ...ownerActions],
    error: load.error,
    loading: load.loading,
    reload: load.reload,
  }
}
