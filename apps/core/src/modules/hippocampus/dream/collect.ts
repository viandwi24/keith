// The collector of a dreaming run (docs/specs/dreaming.md "Collect", ADR-0031 §3). It reads one person's front conversations
// (every generation, P34) after the cursor and returns the texts the judge may see. Every gate is structural: the session id
// (`:agent:` worker sessions are never read), the message metadata (`eharness.kind` messages are excluded), the turn shape
// (an assistant text counts only from a turn that has a user message and no tool part) and the part type (plain text only).
// The collector stores nothing: the caller moves the cursor when the run has done its work.
import type { DreamCursor, Sqlite } from '@keith/db'
import { type FrontGenerationOf, frontSessionId } from '../../../platform/sessions.ts'
import { looksLikeSecret } from '../secret-guard.ts'
import { type JudgeCandidate, judgeLine } from './prompt.ts'
import type { DreamCandidate } from './types.ts'

/** The most candidates one run collects. The newest are kept; the judge's plan has the same bound (DREAM_CANDIDATES_MAX). */
export const COLLECT_CAP = 200

/**
 * The judge's input budget in RENDERED characters: the size of each kept candidate's line in the judge's user message (its id, day,
 * source id, the JSON-escaped text and the wrapper text, `judgeLine` in prompt.ts), summed. About 10 000 characters is about 4 000
 * tokens of candidates at the ratio measured in the audit (about 0.4 tokens per character, docs/research/inference-cost-audit.md
 * section 4.5). The newest candidates that fit are kept; the older ones are dropped (`dropped.cap`) and their cursor moves on, as
 * for `COLLECT_CAP`. One run must fit the cap of `dreaming.maxUsdPerRun` with a normal model (docs/specs/dreaming.md, "Budget").
 */
export const JUDGE_INPUT_CHARS = 10_000
/** The most characters of one candidate the judge sees; a longer text is cut here (its source message id is unchanged). */
export const CANDIDATE_TEXT_CHARS = 2_000
/** The id the budget measures with: the widest id a run can give (`c<COLLECT_CAP>`), so the measured line is never shorter than the sent one. */
const WIDEST_ID = `c${COLLECT_CAP}`

export interface CollectInput {
  personId: string
  /** The person's front generations (`FrontGenerations.current`): every generation from 0 to the current one is read. */
  generations: FrontGenerationOf
  /** The last collected message id per session. A session without an entry is read from its first message. */
  cursor: DreamCursor
}

export interface CollectResult {
  candidates: DreamCandidate[]
  /** Texts that were read but not handed to the judge: `secret` (the secret gate), `cap` (older than the newest kept). */
  dropped: { secret: number; cap: number }
  /**
   * The cursor the caller stores when the run is done: each session read moves to its last message read (excluded and dropped
   * messages included, so they are not read again). Not stored here.
   */
  nextCursor: DreamCursor
}

interface StoredRow {
  session_id: string
  id: string
  role: string
  parts: string
  metadata: string | null
  created_at: number
}

interface Meta {
  kind: boolean
  turnId: string | undefined
  augmented: number
}

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** A turn id goes into a LIKE pattern: only the characters eharness writes (UUIDv7 and the like) are accepted. */
const SAFE_TURN_ID = /^[A-Za-z0-9_-]{1,80}$/

function metaOf(raw: string | null): Meta {
  const empty: Meta = { kind: false, turnId: undefined, augmented: 0 }
  if (raw === null) return empty
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...empty, kind: true } // unreadable metadata: not a message the collector can vouch for
  }
  const eh = isRecord(parsed) && isRecord(parsed.eharness) ? parsed.eharness : undefined
  if (eh === undefined) return empty
  return {
    kind: eh.kind !== undefined,
    turnId: typeof eh.turnId === 'string' ? eh.turnId : undefined,
    augmented: typeof eh.augmented === 'number' && eh.augmented > 0 ? eh.augmented : 0,
  }
}

/** The parts of a stored message, or null when the stored JSON is not an array of objects. */
function partsOf(raw: string): Json[] | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || !parsed.every(isRecord)) return null
    return parsed
  } catch {
    return null
  }
}

/** A tool part of the AI SDK UI shape: `tool-<name>` or `dynamic-tool`. Unreadable parts count as tool parts (conservative). */
const isToolPart = (part: Json): boolean =>
  typeof part.type === 'string' && (part.type === 'dynamic-tool' || part.type.startsWith('tool-'))

interface TurnFacts {
  /** A non-kind user message belongs to the turn. */
  userMessage: boolean
  /** One of the turn's messages has a tool part (or is unreadable). */
  toolPart: boolean
}

/**
 * The facts of the turn an assistant message belongs to, read from every stored message of that turn (not only the ones after
 * the cursor, so a turn that straddles a cursor is judged whole).
 */
function turnFacts(sqlite: Sqlite, sessionId: string, turnId: string): TurnFacts {
  const rows = sqlite
    .query('SELECT role, parts, metadata FROM eh_messages WHERE session_id = ? AND metadata LIKE ?')
    .all(sessionId, `%"turnId":"${turnId}"%`) as Pick<StoredRow, 'role' | 'parts' | 'metadata'>[]
  const facts: TurnFacts = { userMessage: false, toolPart: false }
  for (const row of rows) {
    if (metaOf(row.metadata).kind) continue
    if (row.role === 'user') facts.userMessage = true
    const parts = partsOf(row.parts)
    if (parts === null || parts.some(isToolPart)) facts.toolPart = true
  }
  return facts
}

/** The text parts of a message the person wrote or the model said: no tool, reasoning, file or data part. */
function textOf(row: StoredRow, augmented: number): string | undefined {
  const parts = partsOf(row.parts)
  if (parts === null) return undefined
  let texts = parts.filter((p) => p.type === 'text' && typeof p.text === 'string')
  // Text parts the front agent appended to the user's message (input.submit context) are not the person's words.
  if (row.role === 'user' && augmented > 0)
    texts = texts.slice(0, Math.max(0, texts.length - augmented))
  const text = texts.map((p) => p.text as string).join('\n')
  return text.trim() === '' ? undefined : text
}

/** The day of a message (`YYYY-MM-DD`) in the core host's zone (docs/specs/dreaming.md, Rule 10). */
export function dayOf(epochMs: number): string {
  const d = new Date(epochMs)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

interface Found {
  text: string
  role: 'user' | 'assistant'
  sessionId: string
  messageId: string
  createdAt: number
  day: string
}

/** The front sessions of a person: `front:<id>` and `front:<id>:g<n>` for every generation so far. Never a worker session. */
function sessionsOf(input: CollectInput): string[] {
  const current = input.generations.current(input.personId)
  const ids: string[] = []
  for (let generation = 0; generation <= current; generation++)
    ids.push(frontSessionId(input.personId, generation))
  return ids
}

/** The fields of a found text the judge sees, under the given id. */
const judgeView = (f: Found, id: string): JudgeCandidate => ({
  id,
  text: f.text,
  day: f.day,
  messageId: f.messageId,
})

/** Reads the candidates of one person since the cursor. Pure reads: nothing is stored, the cursor is only returned. */
export function collectCandidates(sqlite: Sqlite, input: CollectInput): CollectResult {
  const dropped = { secret: 0, cap: 0 }
  const nextCursor: DreamCursor = { ...input.cursor }
  const found: Found[] = []

  for (const sessionId of sessionsOf(input)) {
    const rows = sqlite
      .query(
        'SELECT session_id, id, role, parts, metadata, created_at FROM eh_messages WHERE session_id = ? AND id > ? ORDER BY id',
      )
      .all(sessionId, input.cursor[sessionId] ?? '') as StoredRow[]
    if (rows.length === 0) continue
    nextCursor[sessionId] = (rows[rows.length - 1] as StoredRow).id

    const turns = new Map<string, TurnFacts>()
    for (const row of rows) {
      const meta = metaOf(row.metadata)
      if (meta.kind) continue
      if (row.role !== 'user' && row.role !== 'assistant') continue

      if (row.role === 'assistant') {
        // A wake turn or a worker-report reply has no user message of its own; a tool turn is not the person's conversation.
        if (meta.turnId === undefined || !SAFE_TURN_ID.test(meta.turnId)) continue
        let facts = turns.get(meta.turnId)
        if (facts === undefined) {
          facts = turnFacts(sqlite, sessionId, meta.turnId)
          turns.set(meta.turnId, facts)
        }
        if (!facts.userMessage || facts.toolPart) continue
      }

      const text = textOf(row, meta.augmented)
      if (text === undefined) continue
      if (looksLikeSecret(text)) {
        dropped.secret++
        continue
      }
      found.push({
        text,
        role: row.role,
        sessionId,
        messageId: row.id,
        createdAt: row.created_at,
        day: dayOf(row.created_at),
      })
    }
  }

  found.sort(
    (a, b) =>
      a.createdAt - b.createdAt ||
      (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0) ||
      (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0),
  )
  const overflow = Math.max(0, found.length - COLLECT_CAP)
  // the newest candidates whose rendered lines fit the judge's budget (each text cut at CANDIDATE_TEXT_CHARS)
  const kept: Found[] = []
  let chars = 0
  for (let i = found.length - 1; i >= overflow; i--) {
    const f = found[i] as Found
    const cut = { ...f, text: f.text.slice(0, CANDIDATE_TEXT_CHARS) }
    const size = judgeLine(judgeView(cut, WIDEST_ID)).length
    if (chars + size > JUDGE_INPUT_CHARS) break
    chars += size
    kept.unshift(cut)
  }
  dropped.cap = found.length - kept.length

  return {
    candidates: kept.map((f, index) => ({
      id: `c${index + 1}`,
      text: f.text,
      role: f.role,
      sessionId: f.sessionId,
      messageId: f.messageId,
      day: f.day,
    })),
    dropped,
    nextCursor,
  }
}
