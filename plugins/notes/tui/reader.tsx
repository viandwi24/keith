import {
  KeyHints,
  Notice,
  Txt,
  useEffect,
  useInput,
  useKeith,
  useMemo,
  useState,
  wrapRows,
} from '@keith/host/tui'
import { oneLine, problem, stamp } from './format.ts'

interface NoteOut {
  id: string
  title: string
  by: string
  mine: boolean
  updatedAt: number
  createdAt: number
  body: string
  canEdit: boolean
}

export interface ReaderProps {
  id: string
  width: number
  height: number
  onBack(): void
  onShare(id: string): void
}

/** Rows around the text: the title, the meta line, a blank row, a blank row, the hints. */
const CHROME = 5

/** One note, read through `notes.get` as the viewer. A note the viewer may not read is "not found", the same as a missing one. */
export function Reader({ id, width, height, onBack, onShare }: ReaderProps) {
  const k = useKeith()
  const [note, setNote] = useState<NoteOut | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [top, setTop] = useState(0)
  useEffect(() => {
    let live = true
    k.call<NoteOut>('notes.get', { id })
      .then((n) => live && setNote(n))
      .catch((e: unknown) => live && setError(problem(e)))
    return () => {
      live = false
    }
  }, [k, id])

  const rows = useMemo(
    () => (note?.body ?? '').split('\n').flatMap((line) => wrapRows(line, Math.max(1, width - 1))),
    [note, width],
  )
  const size = Math.max(1, height - CHROME)
  const max = Math.max(0, rows.length - size)
  useInput((input, key) => {
    if (key.leftArrow || key.backspace || input === 'b') return onBack()
    if (key.upArrow || input === 'k') return setTop((t) => Math.max(0, t - 1))
    if (key.downArrow || input === 'j') return setTop((t) => Math.min(max, t + 1))
    if (key.pageUp) return setTop((t) => Math.max(0, t - size))
    if (key.pageDown || input === ' ') return setTop((t) => Math.min(max, t + size))
    if (input === 's' && note?.mine === true) onShare(id)
  })
  const from = Math.min(top, max)
  return (
    <>
      {error !== undefined ? (
        <Notice level="warning" rows={[error]} />
      ) : note === undefined ? (
        <Txt tone="muted">loading…</Txt>
      ) : (
        <>
          <Txt bold wrap="truncate-end">
            {oneLine(note.title)}
          </Txt>
          <Txt tone="muted" wrap="truncate-end">
            {`${note.mine ? 'you' : oneLine(note.by)} · ${stamp(note.updatedAt)} · ${note.mine ? 'yours' : note.canEdit ? 'you can edit' : 'read only'}`}
          </Txt>
          <Txt> </Txt>
          {rows.slice(from, from + size).map((row, i) => (
            <Txt key={from + i} wrap="truncate-end">
              {row === '' ? ' ' : row}
            </Txt>
          ))}
        </>
      )}
      <Txt> </Txt>
      <KeyHints
        width={width}
        hints={[
          { key: '↑↓', action: 'scroll' },
          { key: 'b', action: 'back' },
          ...(note?.mine === true ? [{ key: 's', action: 'share' }] : []),
        ]}
      />
    </>
  )
}
