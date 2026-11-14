import {
  KeyHints,
  ListRow,
  Notice,
  TextInput,
  Txt,
  useEffect,
  useInput,
  useKeith,
  useRef,
  useState,
} from '@keith/host/tui'
import { oneLine, problem } from './format.ts'

interface SharesOut {
  mode: string
  entries: Array<{ who: string; access: 'read' | 'edit'; effect: 'allow' | 'deny' }>
}

export interface SharePanelProps {
  id: string
  width: number
  height: number
  onBack(): void
}

/**
 * Who a note of the viewer's own is shared with: `notes.shares`, `notes.share` and `notes.unshare` as the viewer. Only the
 * owner may look. Widening to everyone (`@users`, `@public`) needs a confirmation a view cannot give (a view never steps
 * up), so the core refuses it and the panel says so: that step is `keith-core acl` or the chat's confirmation.
 */
export function SharePanel({ id, width, height, onBack }: SharePanelProps) {
  const k = useKeith()
  const [shares, setShares] = useState<SharesOut | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [said, setSaid] = useState<string | undefined>()
  const [cursor, setCursor] = useState(0)
  const [adding, setAddingState] = useState(false)
  // keys can arrive faster than a render (a paste, fast typing): the handler reads the ref, never a stale `adding`
  const addingRef = useRef(false)
  const setAdding = (next: boolean) => {
    addingRef.current = next
    setAddingState(next)
  }
  const [draft, setDraft] = useState('')

  useEffect(() => {
    let live = true
    k.call<SharesOut>('notes.shares', { id })
      .then((s) => live && setShares(s))
      .catch((e: unknown) => live && setError(problem(e)))
    return () => {
      live = false
    }
  }, [k, id])

  const act = (run: Promise<SharesOut>, done: string) =>
    run
      .then((s) => {
        setShares(s)
        setCursor((c) => Math.min(c, Math.max(0, s.entries.length - 1)))
        setSaid(done)
      })
      .catch((e: unknown) => setSaid(problem(e)))

  const entry = shares?.entries[cursor]
  useInput(
    (input, key) => {
      if (addingRef.current) return
      if (key.leftArrow || key.backspace || input === 'b') return onBack()
      if (key.upArrow || input === 'k') return setCursor((c) => Math.max(0, c - 1))
      if (key.downArrow || input === 'j')
        return setCursor((c) => Math.min((shares?.entries.length ?? 1) - 1, c + 1))
      if (input === 'a' && shares !== undefined) {
        setSaid(undefined)
        return setAdding(true)
      }
      if ((input === 'x' || key.delete) && entry !== undefined)
        void act(
          k.call<SharesOut>('notes.unshare', {
            id,
            target: entry.who,
            deny: entry.effect === 'deny',
          }),
          `Stopped sharing with ${entry.who}.`,
        )
    },
    { isActive: true },
  )

  const submit = (text: string) => {
    const words = oneLine(text).split(' ')
    const access = words.at(-1) === 'edit' && words.length > 1 ? 'edit' : 'read'
    const target = (access === 'edit' ? words.slice(0, -1) : words).join(' ')
    setAdding(false)
    setDraft('')
    if (target === '') return
    void act(
      k.call<SharesOut>('notes.share', { id, target, access }),
      `Shared with ${target} (${access}).`,
    )
  }
  const size = Math.max(1, height - 7)
  return (
    <>
      <Txt bold>Sharing</Txt>
      {error !== undefined ? (
        <Notice level="warning" rows={[error]} />
      ) : shares === undefined ? (
        <Txt tone="muted">loading…</Txt>
      ) : (
        <>
          <Txt tone="muted">{`mode ${shares.mode}`}</Txt>
          <Txt> </Txt>
          {shares.entries.length === 0 ? (
            <Txt tone="muted">Private: only you can read this note.</Txt>
          ) : (
            shares.entries.slice(0, size).map((e, i) => (
              <ListRow
                key={`${e.effect}:${e.who}`}
                selected={i === cursor && !adding}
                width={width}
                columns={[
                  { text: e.who, flex: true },
                  { text: e.effect === 'deny' ? 'denied' : e.access, width: 8 },
                ]}
              />
            ))
          )}
        </>
      )}
      <Txt> </Txt>
      {adding ? (
        <TextInput
          value={draft}
          width={Math.max(10, width - 2)}
          maxRows={1}
          placeholder="user:<name> or group:<name>, then enter (add ‘edit’ to let them edit)"
          onChange={setDraft}
          onSubmit={submit}
        />
      ) : said !== undefined ? (
        <Notice level="info" rows={[said]} />
      ) : (
        <Txt> </Txt>
      )}
      <KeyHints
        width={width}
        hints={
          adding
            ? [{ key: 'enter', action: 'share' }]
            : [
                { key: 'a', action: 'add person or group' },
                ...(entry === undefined ? [] : [{ key: 'x', action: 'stop sharing' }]),
                { key: 'b', action: 'back' },
              ]
        }
      />
    </>
  )
}
