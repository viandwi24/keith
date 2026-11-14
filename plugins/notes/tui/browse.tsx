import {
  clip,
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
  windowOf,
} from '@keith/host/tui'
import type { NoteSummary } from '../store.ts'
import { oneLine, problem, stamp } from './format.ts'

type Item = NoteSummary & { excerpt?: string }
type ListOut = { notes: NoteSummary[]; total: number; hasMore: boolean }
type SearchOut = { results: Array<NoteSummary & { excerpt: string }> }
type Load = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string }

export interface BrowseProps {
  /** The browser has the keys (the reader and the share panel are not on top). */
  active: boolean
  width: number
  /** Rows the browser may use. */
  height: number
  onRead(note: { id: string; mine: boolean }): void
  onShare(id: string): void
}

/** Rows around the list: title, search, a blank row above and below the list, the hints. */
const CHROME = 5

/**
 * The notes the viewer may read, newest first, or the hits of a search. Everything comes through `notes.list` and
 * `notes.search` as the viewer: the guard and the ACL decide what is here, the view only draws it. `/` focuses the search
 * box, `enter` runs it (an empty box is the list again), `down` goes back to the list.
 */
export function Browse({ active, width, height, onRead, onShare }: BrowseProps) {
  const k = useKeith()
  const [items, setItems] = useState<Item[]>([])
  const [total, setTotal] = useState(0)
  const [more, setMore] = useState(false)
  const [applied, setApplied] = useState('')
  const [draft, setDraft] = useState('')
  const [focus, setFocusState] = useState<'list' | 'input'>('list')
  // keys can arrive faster than a render (a paste, fast typing): the handler reads the ref, never a stale `focus`
  const focusRef = useRef(focus)
  const setFocus = (next: 'list' | 'input') => {
    focusRef.current = next
    setFocusState(next)
  }
  const [cursor, setCursor] = useState(0)
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [reload, setReload] = useState(0)

  useEffect(() => {
    void reload
    let live = true
    setLoad({ kind: 'loading' })
    const run =
      applied === ''
        ? k.call<ListOut>('notes.list', { limit: 50 }).then((r) => ({
            items: r.notes as Item[],
            total: r.total,
            more: r.hasMore,
          }))
        : k.call<SearchOut>('notes.search', { query: applied, limit: 25 }).then((r) => ({
            items: r.results as Item[],
            total: r.results.length,
            more: false,
          }))
    run
      .then((r) => {
        if (!live) return
        setItems(r.items)
        setTotal(r.total)
        setMore(r.more)
        setCursor(0)
        setLoad({ kind: 'ready' })
      })
      .catch((error: unknown) => live && setLoad({ kind: 'error', message: problem(error) }))
    return () => {
      live = false
    }
  }, [k, applied, reload])

  const loadMore = () => {
    k.call<ListOut>('notes.list', { limit: 50, offset: items.length })
      .then((r) => {
        setItems((old) => [...old, ...(r.notes as Item[])])
        setTotal(r.total)
        setMore(r.hasMore)
      })
      .catch((error: unknown) => setLoad({ kind: 'error', message: problem(error) }))
  }

  const current = items[cursor]
  useInput(
    (input, key) => {
      if (focusRef.current === 'input') {
        if (key.downArrow) setFocus('list')
        return
      }
      if (key.upArrow || input === 'k') return setCursor((c) => Math.max(0, c - 1))
      if (key.downArrow || input === 'j') {
        if (cursor >= items.length - 1 && more && applied === '') loadMore()
        return setCursor((c) => Math.min(items.length - 1, c + 1))
      }
      if (input === '/') return setFocus('input')
      if (input === 'r') return setReload((n) => n + 1)
      if (current === undefined) return
      if (key.return || key.rightArrow) return onRead({ id: current.id, mine: current.mine })
      if (input === 's' && current.mine) onShare(current.id)
    },
    { isActive: active },
  )

  const listRows = Math.max(1, height - CHROME)
  const { start, end } = windowOf(cursor, items.length, listRows)
  const titleWidth = Math.max(12, Math.min(32, Math.floor(width / 3)))
  const heading =
    applied === ''
      ? `Notes · ${total}${more ? '+' : ''}`
      : `Search “${clip(applied, 30)}” · ${items.length} found`
  return (
    <>
      <Txt bold>{heading}</Txt>
      <TextInput
        focus={active && focus === 'input'}
        value={draft}
        width={Math.max(10, width - 2)}
        maxRows={1}
        placeholder="/ to search"
        onChange={setDraft}
        onSubmit={(text) => {
          setApplied(text.trim())
          setFocus('list')
        }}
      />
      <Txt> </Txt>
      {load.kind === 'error' ? (
        <Notice level="warning" rows={[load.message]} />
      ) : load.kind === 'loading' ? (
        <Txt tone="muted">loading…</Txt>
      ) : items.length === 0 ? (
        <Txt tone="muted">{applied === '' ? 'No notes yet.' : 'Nothing found.'}</Txt>
      ) : (
        items
          .slice(start, end)
          .map((item, i) => (
            <ListRow
              key={item.id}
              selected={start + i === cursor && focus === 'list'}
              width={width}
              columns={[
                { text: oneLine(item.title), width: titleWidth },
                item.excerpt === undefined
                  ? { text: item.mine ? 'you' : oneLine(item.by), width: 12 }
                  : { text: oneLine(item.excerpt), flex: true },
                ...(item.excerpt === undefined ? [{ text: stamp(item.updatedAt), width: 16 }] : []),
              ]}
            />
          ))
      )}
      <Txt> </Txt>
      <KeyHints
        width={width}
        hints={
          focus === 'input'
            ? [
                { key: 'enter', action: 'search' },
                { key: '↓', action: 'list' },
              ]
            : [
                { key: '↑↓', action: 'move' },
                { key: 'enter', action: 'read' },
                { key: '/', action: 'search' },
                ...(current?.mine === true ? [{ key: 's', action: 'share' }] : []),
                { key: 'r', action: 'refresh' },
              ]
        }
      />
    </>
  )
}
