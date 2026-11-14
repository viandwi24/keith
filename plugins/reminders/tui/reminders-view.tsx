import {
  KeyHints,
  ListRow,
  Notice,
  Txt,
  useEffect,
  useInput,
  useKeith,
  useRef,
  useState,
  useTerminal,
  windowOf,
} from '@keith/host/tui'
import type { ReminderOut } from '../store.ts'

type Mode = 'list' | 'confirm' | 'snooze'

/** `2026-11-09 14:03` in UTC: the same text for everyone. */
const stamp = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()
const problem = (error: unknown): string =>
  error instanceof Error && error.message !== '' ? error.message : 'something went wrong'

/** The snooze choices: key, minutes, words. A one-time reminder moves to that long from now (`reminders.update`). */
const SNOOZE = [
  { key: '1', minutes: 10, words: '10 minutes' },
  { key: '2', minutes: 60, words: '1 hour' },
  { key: '3', minutes: 1440, words: '1 day' },
] as const

const whenText = (r: ReminderOut): string =>
  r.when.kind === 'cron'
    ? `cron ${r.when.expr ?? ''}`
    : r.nextAt !== null
      ? stamp(r.nextAt)
      : r.when.at !== null
        ? stamp(r.when.at)
        : ''

const statusText = (r: ReminderOut): string =>
  r.status === 'active' ? 'active' : r.status === 'done' ? 'done' : (r.endedReason ?? 'ended')

/** Only a one-time reminder the viewer made for themselves can be moved: a cron one would turn into a one-shot, another person's is the owner's to change. */
const canSnooze = (r: ReminderOut): boolean =>
  r.status === 'active' && r.mine && r.forMe && r.when.kind === 'once'
const canCancel = (r: ReminderOut): boolean => r.status === 'active'

/**
 * The Reminders list (docs/specs/plugins/reminders.md): the reminders the viewer created or that are for them, `c` to cancel
 * (with a `y` to confirm), `z` to snooze a one-time reminder of their own, `e` to show the ended ones, `r` to refresh. Every
 * read and change is `reminders.list`, `reminders.cancel` or `reminders.update` as the viewer, so the guard, the ACL, the rate
 * limit and the audit apply; the view decides nothing about who may.
 */
export default function RemindersView() {
  const k = useKeith()
  const { cols, rows } = useTerminal()
  const [items, setItems] = useState<ReminderOut[]>([])
  const [load, setLoad] = useState<'loading' | 'ready' | string>('loading')
  const [ended, setEnded] = useState(false)
  const [cursor, setCursor] = useState(0)
  const [mode, setModeState] = useState<Mode>('list')
  const [said, setSaid] = useState<string | undefined>()
  const [reload, setReload] = useState(0)
  // keys can arrive faster than a render: the handler reads the ref, never a stale `mode`
  const modeRef = useRef<Mode>('list')
  const setMode = (next: Mode) => {
    modeRef.current = next
    setModeState(next)
  }

  useEffect(() => {
    void reload
    let live = true
    k.call<{ reminders: ReminderOut[] }>('reminders.list', { includeEnded: ended, limit: 50 })
      .then((r) => {
        if (!live) return
        setItems(r.reminders)
        setCursor((c) => Math.min(c, Math.max(0, r.reminders.length - 1)))
        setLoad('ready')
      })
      .catch((e: unknown) => live && setLoad(problem(e)))
    return () => {
      live = false
    }
  }, [k, ended, reload])

  // the owner cancelled a reminder between two other people (ADR-0027 §18): say so and reload the list
  useEffect(
    () =>
      k.events('reminders.cancelled_by_owner', () => {
        setSaid('The owner cancelled one of your reminders.')
        setReload((n) => n + 1)
      }),
    [k],
  )

  const current = items[cursor]
  const run = (p: Promise<unknown>, done: string) =>
    p
      .then(() => {
        setSaid(done)
        setReload((n) => n + 1)
      })
      .catch((e: unknown) => setSaid(problem(e)))

  useInput((input, key) => {
    const at = modeRef.current
    if (at === 'confirm') {
      setMode('list')
      if (input === 'y' && current !== undefined)
        void run(k.call('reminders.cancel', { id: current.id }), 'Cancelled.')
      else setSaid('Kept.')
      return
    }
    if (at === 'snooze') {
      setMode('list')
      const pick = SNOOZE.find((s) => s.key === input)
      if (pick !== undefined && current !== undefined)
        void run(
          k.call('reminders.update', { id: current.id, inMinutes: pick.minutes }),
          `Snoozed for ${pick.words}.`,
        )
      else setSaid('Not snoozed.')
      return
    }
    if (key.upArrow || input === 'k') return setCursor((c) => Math.max(0, c - 1))
    if (key.downArrow || input === 'j') return setCursor((c) => Math.min(items.length - 1, c + 1))
    if (input === 'r') return setReload((n) => n + 1)
    if (input === 'e') return setEnded((v) => !v)
    if (current === undefined) return
    if (input === 'c' && canCancel(current)) {
      setSaid(undefined)
      return setMode('confirm')
    }
    if (input === 'z' && canSnooze(current)) {
      setSaid(undefined)
      setMode('snooze')
    }
  })

  const width = Math.max(10, cols)
  const size = Math.max(1, rows - 6)
  const { start, end } = windowOf(cursor, items.length, size)
  const hints =
    mode === 'confirm'
      ? [
          { key: 'y', action: 'cancel it' },
          { key: 'any other', action: 'keep' },
        ]
      : mode === 'snooze'
        ? [
            ...SNOOZE.map((s) => ({ key: s.key, action: s.words })),
            { key: 'any other', action: 'no' },
          ]
        : [
            { key: '↑↓', action: 'move' },
            ...(current !== undefined && canCancel(current)
              ? [{ key: 'c', action: 'cancel' }]
              : []),
            ...(current !== undefined && canSnooze(current)
              ? [{ key: 'z', action: 'snooze' }]
              : []),
            { key: 'e', action: ended ? 'hide ended' : 'show ended' },
            { key: 'r', action: 'refresh' },
          ]
  return (
    <>
      <Txt bold>{`Reminders · ${items.length}${ended ? ' (with ended)' : ''}`}</Txt>
      <Txt> </Txt>
      {load === 'loading' ? (
        <Txt tone="muted">loading…</Txt>
      ) : load !== 'ready' ? (
        <Notice level="warning" rows={[load]} />
      ) : items.length === 0 ? (
        <Txt tone="muted">No reminders.</Txt>
      ) : (
        items.slice(start, end).map((r, i) => (
          <ListRow
            key={r.id}
            selected={start + i === cursor}
            width={width}
            columns={[
              { text: oneLine(r.text), flex: true },
              {
                text: r.forMe ? (r.mine ? 'you' : `from ${oneLine(r.by)}`) : `to ${oneLine(r.to)}`,
                width: 14,
              },
              { text: whenText(r), width: 20 },
              { text: statusText(r), width: 10, tone: r.status === 'active' ? 'text' : 'muted' },
            ]}
          />
        ))
      )}
      <Txt> </Txt>
      {mode === 'confirm' && current !== undefined ? (
        <Notice level="warning" rows={[`Cancel “${oneLine(current.text).slice(0, 40)}”?`]} />
      ) : mode === 'snooze' ? (
        <Notice level="info" rows={['Move it to how long from now?']} />
      ) : said !== undefined ? (
        <Notice level="info" rows={[said]} />
      ) : (
        <Txt> </Txt>
      )}
      <KeyHints width={width} hints={hints} />
    </>
  )
}
