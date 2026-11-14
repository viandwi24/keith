import {
  MS_HOUR,
  MS_MINUTE,
  type ProtocolProposal,
  type ProtocolRun,
  type ProtocolView,
  type Trigger,
} from '@keith/contracts'
import { G } from '@keith/ui'
import type { NoteSpec, Row } from '../manage-types.ts'

/** A local date and time, `2026-11-10 09:00`. */
export const clock = (ms: number): string => {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** The same time without the year, for a list cell: `11-10 09:00`. */
export const shortClock = (ms: number): string => clock(ms).slice(5)

/** A span in the largest whole unit: `2 h`, `90 min`, `3 d`. */
export const span = (ms: number): string => {
  if (ms >= 24 * MS_HOUR && ms % (24 * MS_HOUR) === 0) return `${ms / (24 * MS_HOUR)} d`
  if (ms >= MS_HOUR && ms % MS_HOUR === 0) return `${ms / MS_HOUR} h`
  return `${Math.round(ms / MS_MINUTE)} min`
}

/** The trigger in one short phrase for a list cell. */
export function triggerLine(trigger: Trigger): string {
  switch (trigger.kind) {
    case 'time':
      return trigger.cron !== undefined
        ? `cron ${trigger.cron}`
        : `once ${shortClock(trigger.at ?? 0)}`
    case 'absence':
      return `absent ${span(trigger.afterMs)}`
    case 'signal':
      return `signal ${trigger.type}`
    case 'event':
      return trigger.afterMs === undefined
        ? `on ${trigger.type}`
        : `${trigger.type} +${span(trigger.afterMs)}`
  }
}

/** The state of a protocol in a status cell: `● on`, `◐ paused until …`, `○ off`. */
export function stateCell(view: ProtocolView, now: number): string {
  if (!view.enabled) return `${G.idle} off`
  if (view.pausedUntil !== null && view.pausedUntil > now)
    return `${G.working} paused until ${shortClock(view.pausedUntil)}`
  return `${G.dot} on`
}

export const isPaused = (view: ProtocolView, now: number): boolean =>
  view.pausedUntil !== null && view.pausedUntil > now

/** The newest run of a protocol, or none. */
export function lastRunOf(
  runs: readonly ProtocolRun[],
  protocolId: string,
): ProtocolRun | undefined {
  let last: ProtocolRun | undefined
  for (const run of runs)
    if (run.protocolId === protocolId && (last === undefined || run.startedAt > last.startedAt))
      last = run
  return last
}

/** The last-run cell: when it started and how it ended; a failed run carries the cross. */
export function runCell(run: ProtocolRun | undefined): string {
  if (run === undefined) return 'no runs yet'
  const word = run.status === 'failed' ? `${G.failed} failed` : run.status
  return `${word} ${shortClock(run.startedAt)}`
}

/** The steps of a definition as a short ladder: `notify, wait, notify`. */
export const stepsLine = (view: { definition: { steps: readonly { kind: string }[] } }): string =>
  view.definition.steps.map((s) => s.kind).join(', ')

export interface ListWho {
  /** The caller's person id: the owner column reads `you` for the caller's own. */
  personId: string
  /** The owner sees every person's protocols, so the list gets an owner column. */
  owner: boolean
}

const who = (owner: string, me: ListWho): string => (owner === me.personId ? 'you' : owner)

/** The cells of a protocol row: name, owner (owner only), trigger, state, last run. */
export function protocolCells(
  view: ProtocolView,
  runs: readonly ProtocolRun[],
  now: number,
  me: ListWho,
): string[] {
  const cells = [
    view.name,
    triggerLine(view.definition.trigger),
    stateCell(view, now),
    runCell(lastRunOf(runs, view.id)),
  ]
  return me.owner ? [cells[0] ?? '', who(view.owner, me), ...cells.slice(1)] : cells
}

/** The cells of a pending proposal: its reason, trigger, `! proposed` and when it expires. */
export function proposalCells(p: ProtocolProposal, me: ListWho): string[] {
  const cells = [
    p.reason,
    triggerLine(p.definition.trigger),
    `${G.warn} proposed`,
    `expires ${shortClock(p.expiresAt)}`,
  ]
  return me.owner ? [cells[0] ?? '', who(p.person, me), ...cells.slice(1)] : cells
}

/** The column headers that match `protocolCells` and `proposalCells`. */
export const headerOf = (me: ListWho): string[] =>
  me.owner
    ? ['NAME', 'OWNER', 'TRIGGER', 'STATE', 'LAST RUN']
    : ['NAME', 'TRIGGER', 'STATE', 'LAST RUN']

/** Column widths of `headerOf`; the last column takes the rest. */
export const widthsOf = (me: ListWho): number[] => (me.owner ? [18, 10, 24, 20] : [20, 24, 20])

/** The protocol's facts for the details note, with its last runs (newest first). */
export function protocolDetail(
  view: ProtocolView,
  runs: readonly ProtocolRun[],
  now: number,
): NoteSpec {
  const mine = runs
    .filter((r) => r.protocolId === view.id)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 5)
  const limits = view.definition.limits
  return {
    title: view.name,
    lines: [
      `owner      ${view.owner}${view.builtIn === null ? '' : ` (built in: ${view.builtIn})`}`,
      `trigger    ${triggerLine(view.definition.trigger)}`,
      `steps      ${stepsLine(view)}`,
      `limits     ${limits.maxRunsPerDay} runs a day, ${limits.maxSteps} steps a run`,
      `state      ${stateCell(view, now)}`,
      'last runs',
      ...(mine.length === 0
        ? ['  none yet']
        : mine.map((r) => `  ${clock(r.startedAt)}  ${r.status}  step ${r.step ?? '-'}`)),
    ],
  }
}

/** The proposal's facts for its details note. */
export function proposalDetail(p: ProtocolProposal): NoteSpec {
  return {
    title: 'Proposed protocol',
    lines: [
      p.reason,
      `trigger    ${triggerLine(p.definition.trigger)}`,
      `steps      ${p.definition.steps.map((s) => s.kind).join(', ')}`,
      `expires    ${clock(p.expiresAt)}`,
      'Confirm to save it as a protocol; dismiss to drop it for good.',
    ],
  }
}

/** The pending proposals only (a confirmed, dismissed or expired one is history). */
export const pendingProposals = (list: readonly ProtocolProposal[]): ProtocolProposal[] =>
  list.filter((p) => p.status === 'pending')

/** Rows of a section: pending proposals first, then the protocols as the core lists them. */
export function protocolRows(input: {
  views: readonly ProtocolView[]
  proposals: readonly ProtocolProposal[]
  runs: readonly ProtocolRun[]
  now: number
  me: ListWho
  actions: {
    proposal(p: ProtocolProposal): Row['actions']
    view(v: ProtocolView): Row['actions']
  }
}): Row[] {
  const proposals: Row[] = pendingProposals(input.proposals).map((p) => ({
    id: `proposal:${p.id}`,
    cells: proposalCells(p, input.me),
    actions: input.actions.proposal(p),
  }))
  const protocols: Row[] = input.views.map((v) => ({
    id: v.id,
    cells: protocolCells(v, input.runs, input.now, input.me),
    actions: input.actions.view(v),
  }))
  return [...proposals, ...protocols]
}

/** The open question of a run that waits on an `ask` step: the run, the question and its options (none when it waits on none). */
export interface OpenAsk {
  runId: string
  text: string
  options: readonly string[]
}

/** The open question of a run, read from its protocol's definition (undefined unless the run waits on an `ask`). */
export function openAskOf(
  view: ProtocolView | undefined,
  run: ProtocolRun | undefined,
): OpenAsk | undefined {
  if (view === undefined || run === undefined || run.status !== 'waiting' || run.step === null)
    return undefined
  const step = view.definition.steps.find((s) => s.id === run.step)
  if (step?.kind !== 'ask') return undefined
  return { runId: run.id, text: step.text, options: step.options ?? [] }
}

/** One line per waiting question: `asks: <question>`, newest run first as the core lists them. */
export function askLines(views: readonly ProtocolView[], runs: readonly ProtocolRun[]): string[] {
  return runs.flatMap((run) => {
    const ask = openAskOf(
      views.find((v) => v.id === run.protocolId),
      run,
    )
    return ask === undefined ? [] : [`asks: ${ask.text}`]
  })
}
