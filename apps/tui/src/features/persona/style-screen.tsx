// The "Me" screen (docs/specs/tui.md, "Persona"): the person's own style (address, language, brevity, formality, gentle topics). It reads
// `persona.style.get` only and saves `persona.style.set` with the changed fields; it never shows or reads another person's style, and
// no step-up is asked (the style is the person's own, ADR-0029 §3). The form's state and checks are in style-state.ts.
import type { KeithClient } from '@keith/client'
import type {
  GentleTopic,
  PersonStyle,
  StyleBrevity,
  StyleFormality,
  StyleLanguage,
} from '@keith/contracts'
import { Txt, useFooter } from '@keith/ui'
import { Box } from 'ink'
import { useEffect, useState } from 'react'
import { useGuardedInput as useInput } from '../activity/index.ts'
import {
  BREVITY_CHOICES,
  checkAddress,
  FORMALITY_CHOICES,
  LANGUAGE_CHOICES,
  STYLE_FIELD_LABELS,
  type StyleDraft,
  styleDraftOf,
  stylePatchOf,
  TOPIC_CHOICES,
  toggleTopic,
} from './style-state.ts'

export interface StyleScreenProps {
  client: KeithClient
  /** Cells and rows of the screen body (the frame's own rows are not counted). */
  width: number
  /** On screen with the keys (the step-up prompt or another screen takes them otherwise). */
  active: boolean
  /** `esc`: back to where the screen was opened. */
  onClose(): void
  /** The Memory row (Me > Memory, features/memory): `enter` on it opens the screen. */
  onMemory?(): void
}

/** The focusable rows in order: address, the three choices, one row per gentle topic, then the Memory row. */
const ROWS = ['address', 'language', 'brevity', 'formality', ...TOPIC_CHOICES, 'memory'] as const
type Row = (typeof ROWS)[number]
const ADDRESS_INPUT_MAX = 40

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The next choice of an enum in `choices`, cycling in either direction. */
function cycle<T extends string>(choices: readonly T[], current: T, step: 1 | -1): T {
  const at = choices.indexOf(current)
  return choices[(at + step + choices.length) % choices.length] ?? current
}

/** A language choice as the form shows it: `auto` says what it does. */
const labelOf = (choice: StyleLanguage): string =>
  choice === 'auto' ? 'auto (follows the message)' : choice

/** The Me form. Up and down move between rows; ← → or space change a choice; space toggles a topic; typing edits the address. */
export function StyleScreen({ client, width, active, onClose, onMemory }: StyleScreenProps) {
  const [saved, setSaved] = useState<PersonStyle | undefined>()
  const [draft, setDraft] = useState<StyleDraft | undefined>()
  const [focus, setFocus] = useState(0)
  const [loadError, setLoadError] = useState<string | undefined>()
  const [note, setNote] = useState<{ level: 'info' | 'danger'; text: string } | undefined>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    client.persona.style.get().then(
      (style) => {
        if (!alive) return
        setSaved(style)
        setDraft(styleDraftOf(style))
      },
      (e: unknown) => alive && setLoadError(messageOf(e)),
    )
    return () => {
      alive = false
    }
  }, [client])

  useFooter([
    { key: '↑↓', action: 'field' },
    { key: '←→ / space', action: 'change' },
    { key: 'enter', action: 'save' },
    { key: 'esc', action: 'back' },
  ])

  const row: Row = ROWS[Math.min(focus, ROWS.length - 1)] ?? 'address'

  const save = (): void => {
    if (saved === undefined || draft === undefined || busy) return
    const { patch, problems } = stylePatchOf(saved, draft)
    const first = problems[0]
    if (first !== undefined) {
      setNote({ level: 'danger', text: `${STYLE_FIELD_LABELS[first.field]}: ${first.message}` })
      return
    }
    if (patch === undefined) {
      setNote({ level: 'info', text: 'Nothing to save.' })
      return
    }
    setBusy(true)
    client.persona.style.set({ patch }).then(
      (next) => {
        setBusy(false)
        setSaved(next)
        setDraft(styleDraftOf(next))
        setNote({ level: 'info', text: 'Saved.' })
      },
      (e: unknown) => {
        setBusy(false)
        setNote({ level: 'danger', text: messageOf(e) })
      },
    )
  }

  useInput(
    (input, key) => {
      if (key.escape) return onClose()
      if (draft === undefined || busy) return
      if (key.upArrow) return setFocus((f) => Math.max(0, f - 1))
      if (key.downArrow) return setFocus((f) => Math.min(ROWS.length - 1, f + 1))
      if (key.return) return row === 'memory' ? onMemory?.() : save()
      if (row === 'memory') return
      const change = (next: StyleDraft): void => {
        setDraft(next)
        setNote(undefined)
      }
      if (row === 'address') {
        if (key.backspace || key.delete)
          return change({ ...draft, address: draft.address.slice(0, -1) })
        if (input !== '' && !key.ctrl && !key.meta && !key.tab) {
          const typed = `${draft.address}${input}`.slice(0, ADDRESS_INPUT_MAX)
          change({ ...draft, address: typed })
        }
        return
      }
      if (row === 'language') {
        if (key.leftArrow || key.rightArrow || input === ' ')
          change({
            ...draft,
            language: cycle(LANGUAGE_CHOICES, draft.language, key.leftArrow ? -1 : 1),
          })
        return
      }
      if (row === 'brevity') {
        if (key.leftArrow || key.rightArrow || input === ' ')
          change({
            ...draft,
            brevity: cycle<StyleBrevity>(BREVITY_CHOICES, draft.brevity, key.leftArrow ? -1 : 1),
          })
        return
      }
      if (row === 'formality') {
        if (key.leftArrow || key.rightArrow || input === ' ')
          change({
            ...draft,
            formality: cycle<StyleFormality>(
              FORMALITY_CHOICES,
              draft.formality,
              key.leftArrow ? -1 : 1,
            ),
          })
        return
      }
      if (input === ' ') change(toggleTopic(draft, row as GentleTopic))
    },
    { isActive: active },
  )

  if (loadError !== undefined) return <Txt tone="danger">{loadError}</Txt>
  if (draft === undefined) return <Txt tone="muted">reading ...</Txt>

  const address = checkAddress(draft.address)
  const mark = (on: boolean): string => (on ? '[x]' : '[ ]')
  const cursor = (on: boolean): string => (on ? '›' : ' ')
  const choice = (id: Row, label: string, value: string) => (
    <Txt key={id} tone={focus === ROWS.indexOf(id) ? 'accent' : 'text'}>
      {`${cursor(focus === ROWS.indexOf(id))} ${label.padEnd(30)} ‹ ${value} ›`}
    </Txt>
  )

  return (
    <Box flexDirection="column" width={width}>
      <Txt tone="muted">Only your own style. It never changes what you may do.</Txt>
      <Box marginTop={1} flexDirection="column">
        <Txt tone={focus === 0 ? 'accent' : 'text'}>
          {`${cursor(focus === 0)} ${STYLE_FIELD_LABELS.address.padEnd(30)} ${draft.address === '' ? '(none: the profile name)' : draft.address}${focus === 0 ? '▏' : ''}`}
        </Txt>
        {!address.ok && draft.address !== '' && <Txt tone="danger">{`    ${address.message}`}</Txt>}
        {choice('language', STYLE_FIELD_LABELS.language, labelOf(draft.language))}
        {choice('brevity', STYLE_FIELD_LABELS.brevity, draft.brevity)}
        {choice('formality', STYLE_FIELD_LABELS.formality, draft.formality)}
        <Txt tone="muted">{`  ${STYLE_FIELD_LABELS.gentleTopics} (up to 5, treated gently)`}</Txt>
        {TOPIC_CHOICES.map((topic) => (
          <Txt key={topic} tone={focus === ROWS.indexOf(topic) ? 'accent' : 'text'}>
            {`${cursor(focus === ROWS.indexOf(topic))} ${mark(draft.gentleTopics.includes(topic))} ${topic}`}
          </Txt>
        ))}
      </Box>
      <Txt tone={focus === ROWS.indexOf('memory') ? 'accent' : 'text'}>
        {`${cursor(focus === ROWS.indexOf('memory'))} Memory: dreaming, the diary and a staged plan  ›  enter`}
      </Txt>
      {note !== undefined && (
        <Box marginTop={1}>
          <Txt tone={note.level === 'danger' ? 'danger' : 'muted'}>{note.text}</Txt>
        </Box>
      )}
      {busy && <Txt tone="muted">saving ...</Txt>}
    </Box>
  )
}
