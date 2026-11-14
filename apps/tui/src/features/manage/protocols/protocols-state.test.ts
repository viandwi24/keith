import { describe, expect, test } from 'bun:test'
import { MS_DAY, MS_HOUR, MS_MINUTE, type ProtocolRun, type ProtocolView } from '@keith/contracts'
import { createFakeProtocols, NOW } from '../../../testing/fake-protocols.ts'
import { reminderDefinition } from './protocols-reminder.ts'
import {
  askLines,
  clock,
  headerOf,
  lastRunOf,
  openAskOf,
  proposalCells,
  protocolCells,
  protocolDetail,
  protocolRows,
  runCell,
  shortClock,
  span,
  stateCell,
  triggerLine,
  widthsOf,
} from './protocols-state.ts'

const view = (over: Partial<ProtocolView> = {}): ProtocolView => ({
  id: 'p1',
  owner: 'ana-id',
  name: 'Call Bo back',
  builtIn: null,
  enabled: true,
  pausedUntil: null,
  version: 1,
  definition: reminderDefinition('Call Bo back', NOW + MS_HOUR),
  updatedAt: NOW,
  ...over,
})

const run = (over: Partial<ProtocolRun> = {}): ProtocolRun => ({
  id: 'r',
  protocolId: 'p1',
  version: 1,
  person: 'ana-id',
  triggerRef: 'at:1',
  status: 'done',
  step: 'remind',
  visits: {},
  wakeAt: null,
  costUsd: 0,
  startedAt: NOW - MS_HOUR,
  updatedAt: NOW,
  endedAt: NOW,
  ...over,
})

describe('triggerLine', () => {
  test('a cron, a one-time reminder, an absence, a signal and an event read in one phrase', () => {
    expect(triggerLine({ kind: 'time', cron: '0 9 * * *' })).toBe('cron 0 9 * * *')
    expect(triggerLine({ kind: 'time', at: NOW })).toBe(`once ${shortClock(NOW)}`)
    expect(triggerLine({ kind: 'absence', person: 'ana-id', afterMs: 2 * MS_HOUR })).toBe(
      'absent 2 h',
    )
    expect(triggerLine({ kind: 'signal', type: 'client.connected' })).toBe(
      'signal client.connected',
    )
    expect(triggerLine({ kind: 'event', type: 'delivery.failed' })).toBe('on delivery.failed')
    expect(triggerLine({ kind: 'event', type: 'delivery.failed', afterMs: 90 * MS_MINUTE })).toBe(
      'delivery.failed +90 min',
    )
  })

  test('span uses the largest whole unit', () => {
    expect(span(MS_DAY)).toBe('1 d')
    expect(span(3 * MS_HOUR)).toBe('3 h')
    expect(span(45 * MS_MINUTE)).toBe('45 min')
  })
})

describe('stateCell', () => {
  test('on, paused until a time (only while the pause lasts), off', () => {
    expect(stateCell(view(), NOW)).toBe('● on')
    expect(stateCell(view({ pausedUntil: NOW + MS_HOUR }), NOW)).toBe(
      `◐ paused until ${shortClock(NOW + MS_HOUR)}`,
    )
    expect(stateCell(view({ pausedUntil: NOW - 1 }), NOW)).toBe('● on')
    expect(stateCell(view({ enabled: false }), NOW)).toBe('○ off')
  })
})

describe('runs', () => {
  test('the newest run of a protocol is its last run; a failed one carries the cross', () => {
    const runs = [
      run({ id: 'old', startedAt: NOW - 5 * MS_HOUR }),
      run({ id: 'new' }),
      run({ id: 'x', protocolId: 'p2' }),
    ]
    expect(lastRunOf(runs, 'p1')?.id).toBe('new')
    expect(lastRunOf(runs, 'none')).toBeUndefined()
    expect(runCell(undefined)).toBe('no runs yet')
    expect(runCell(run({ status: 'failed', startedAt: NOW }))).toBe(`✕ failed ${shortClock(NOW)}`)
    expect(runCell(run({ status: 'waiting', startedAt: NOW }))).toBe(`waiting ${shortClock(NOW)}`)
  })
})

describe('cells and headers', () => {
  test('a member sees four columns; the owner adds the owner column', () => {
    const cells = protocolCells(view(), [run()], NOW, { personId: 'ana-id', owner: false })
    expect(cells).toHaveLength(headerOf({ personId: 'ana-id', owner: false }).length)
    expect(cells[0]).toBe('Call Bo back')
    expect(cells[3]).toContain('done')
    const owned = protocolCells(view({ owner: 'keith' }), [], NOW, {
      personId: 'ana-id',
      owner: true,
    })
    expect(owned).toHaveLength(headerOf({ personId: 'ana-id', owner: true }).length)
    expect(owned[1]).toBe('keith')
    expect(protocolCells(view(), [], NOW, { personId: 'ana-id', owner: true })[1]).toBe('you')
    expect(widthsOf({ personId: 'a', owner: true })).toHaveLength(
      headerOf({ personId: 'a', owner: true }).length - 1,
    )
  })

  test('a proposal row reads as proposed and shows its expiry', () => {
    const [p] = createFakeProtocols().proposals
    expect(p).toBeDefined()
    const cells = proposalCells(p as NonNullable<typeof p>, { personId: 'ana-id', owner: false })
    expect(cells[0]).toBe('Stretch every afternoon')
    expect(cells[2]).toBe('! proposed')
    expect(cells[3]).toBe(`expires ${shortClock((p as NonNullable<typeof p>).expiresAt)}`)
  })
})

describe('protocolRows', () => {
  test('pending proposals come first; confirmed and dismissed ones are left out', () => {
    const fake = createFakeProtocols({ owner: false })
    const [pending] = fake.proposals
    const rows = protocolRows({
      views: fake.views,
      proposals: [
        ...fake.proposals,
        { ...(pending as NonNullable<typeof pending>), id: 'old', status: 'dismissed' },
      ],
      runs: fake.runs,
      now: NOW,
      me: { personId: 'ana-id', owner: false },
      actions: { proposal: () => [], view: () => [] },
    })
    expect(rows.map((r) => r.id)).toEqual(['proposal:prop-1', 'p-call', 'p-water'])
  })
})

describe('protocolDetail', () => {
  test('the definition in short lines and the last runs, newest first', () => {
    const v = view({ builtIn: null })
    const detail = protocolDetail(
      v,
      [run({ startedAt: NOW - 2 * MS_HOUR }), run({ id: 'n', startedAt: NOW })],
      NOW,
    )
    expect(detail.title).toBe('Call Bo back')
    expect(detail.lines).toContain('steps      notify, wait, notify')
    expect(detail.lines.at(-2)).toBe(`  ${clock(NOW)}  done  step remind`)
    expect(detail.lines.at(-1)).toBe(`  ${clock(NOW - 2 * MS_HOUR)}  done  step remind`)
  })

  test('a protocol with no run says so', () => {
    expect(protocolDetail(view(), [], NOW).lines.at(-1)).toBe('  none yet')
  })
})

describe('the open question of a run', () => {
  const { views, runs } = (() => {
    const fake = createFakeProtocols({ waitingAsk: true })
    return { views: fake.views, runs: fake.runs }
  })()
  const askView = views.find((v) => v.id === 'p-ask') as ProtocolView
  const [waiting] = runs

  test('a run waiting on an ask step has its question and options', () => {
    expect(openAskOf(askView, waiting)).toEqual({
      runId: 'run-7',
      text: 'Water the plants today?',
      options: ['yes', 'later'],
    })
  })

  test('a run that does not wait, or waits on another step, has no question', () => {
    const done = runs.find((r) => r.id === 'run-1')
    expect(openAskOf(askView, done)).toBeUndefined()
    expect(openAskOf(askView, { ...(waiting as ProtocolRun), step: 'nope' })).toBeUndefined()
    expect(openAskOf(undefined, waiting)).toBeUndefined()
  })

  test('one asks line per waiting question', () => {
    expect(askLines(views, runs)).toEqual([
      'asks: Water the plants today?',
      'asks: Water the plants today?',
    ])
    expect(askLines(views, [])).toEqual([])
  })
})
