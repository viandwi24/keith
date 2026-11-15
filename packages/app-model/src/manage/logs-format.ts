import type {
  LlmBodyState,
  LlmCallRecord,
  LlmSessionRecord,
  LogsCallOutput,
  LogsRawOutput,
  LogsSessionOutput,
} from '@keith/contracts'
import type { Tone } from '../ui-types.ts'
import { cacheHitRatio, cacheTotals, LOW_CACHE_HIT, lowCacheIds, percentOf } from './cache-hit.ts'
import type { Row } from './types.ts'

// The text of the Logs views (activity-logs.md "TUI"): table rows, fact lines and the bodies of the generation and raw
// levels, as plain values. Pure: the views draw what these return, so a test reads the words without a terminal.

/** One line of a text body: a fact (`key  value`, the key drawn dim by `FactLine`) or a plain line in a tone. */
export interface LogLine {
  text: string
  tone?: Tone
  bold?: boolean
  fact?: boolean
}

/** A message longer than this is cut to its first lines and says how many were left out. */
const MESSAGE_LINES = 12

const iso = (ms: number): string => new Date(ms).toISOString()

/** A session or call id shortened in the middle, so both its start (the kind) and its end (the number) stay visible. */
export function shortId(id: string, max = 24): string {
  if (id.length <= max) return id
  const keep = max - 1
  const head = Math.ceil(keep * 0.6)
  return `${id.slice(0, head)}…${id.slice(-(keep - head))}`
}

/** `2026-11-11 14:02`, UTC. */
export const stampOf = (ms: number): string => iso(ms).slice(0, 16).replace('T', ' ')

/** `14:02:11`, UTC. */
export const clockOf = (ms: number): string => iso(ms).slice(11, 19)

/** A session's range: `11-11 14:02-14:20` on one day, `11-10 14:02-11-11 09:00` across days. */
export function rangeOf(first: number, last: number): string {
  const a = iso(first)
  const b = iso(last)
  const start = `${a.slice(5, 10)} ${a.slice(11, 16)}`
  if (a.slice(0, 10) === b.slice(0, 10)) return `${start}-${b.slice(11, 16)}`
  return `${start}-${b.slice(5, 10)} ${b.slice(11, 16)}`
}

/** Micro-dollars as dollars: `$0.0042`, and `$1.23` from one dollar. `—` when the provider has no price. */
export function microUsd(micro: number | null): string {
  if (micro === null) return '—'
  const dollars = micro / 1_000_000
  return `$${dollars.toFixed(dollars < 1 ? 4 : 2)}`
}

/** A token count: `840`, `1.2k`, `12k`, `1.3M`. */
export function count(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** A span of time: `42s`, `3m 05s`. */
export function spanOf(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

/** A latency: `842 ms`, `1.84 s`. */
export const latencyOf = (ms: number): string =>
  ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`

/** Output tokens per second over the whole call; null when there is nothing to divide. */
export function throughputOf(tokensOut: number, durationMs: number): string | null {
  if (tokensOut === 0 || durationMs <= 0) return null
  return `${Math.round(tokensOut / (durationMs / 1000))} tok/s`
}

const STATUS_CELL: Record<LlmCallRecord['status'], string> = {
  ok: '● ok',
  error: '✕ error',
  aborted: '○ aborted',
}

/** What a body that is not stored says, or null for a stored one. */
export function bodyNote(state: LlmBodyState): string | null {
  if (state === 'off') return 'bodies were off for this call: figures only'
  if (state === 'purged') return 'bodies were purged by retention: figures only'
  return null
}

const fact = (key: string, value: string): LogLine => ({ text: `${key}  ${value}`, fact: true })

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** The table columns of the sessions list (the last one takes the rest of the row). */
export const SESSION_HEADER = ['date (UTC)', 'app', 'session', 'model', 'provider', 'calls', 'cost']
export const SESSION_WIDTHS = [23, 8, 14, 20, 10, 5]

/** The table columns of a session's generations (the status takes the rest of the row). */
export const GENERATION_HEADER = ['time', 'model', 'in → out', 'cache hit', 'cost', 'status']
export const GENERATION_WIDTHS = [8, 22, 14, 14, 10]

/** The text of the `↓` legend: a session's first call is never marked, the others below the line are. */
export const LOW_CACHE_LEGEND = `↓ low cache hit: under ${Math.round(LOW_CACHE_HIT * 100)}% of the input cached, after the first call`

export function sessionRow(s: LlmSessionRecord): Row {
  return {
    id: s.id,
    cells: [
      rangeOf(s.firstAt, s.lastAt),
      s.app,
      shortId(s.id, 14),
      s.primaryModel ?? '—',
      s.primaryProvider ?? '—',
      String(s.calls),
      microUsd(s.costMicro),
    ],
    actions: [],
  }
}

/** The cache cell of a generation: its hit share and the cached tokens; `↓` first when the call is marked; `—` unreported. */
export function cacheCellOf(c: LlmCallRecord, marked: boolean): string {
  const ratio = cacheHitRatio(c)
  if (c.cacheRead === null) return '—'
  const cell = `${percentOf(ratio)} · ${count(c.cacheRead)}`
  return marked ? `↓ ${cell}` : cell
}

export function generationRow(c: LlmCallRecord, marked = false): Row {
  return {
    id: c.id,
    cells: [
      clockOf(c.startedAt),
      c.modelId,
      `${count(c.tokensIn)} → ${count(c.tokensOut)}`,
      cacheCellOf(c, marked),
      microUsd(c.costMicro),
      STATUS_CELL[c.status],
    ],
    actions: [],
  }
}

/** The fact lines above a session's generations: requests, cost, models, span, app and the start. */
export function sessionLines(d: LogsSessionOutput): LogLine[] {
  const s = d.session
  const listed = d.more ? ` · first ${d.generations.length} listed` : ''
  const models = [...new Set(d.generations.map((g) => g.modelId))]
  const totals = cacheTotals(d.generations)
  const lines = [
    fact('requests', `${s.calls}${listed}`),
    fact('cost', microUsd(s.costMicro)),
    fact('models', models.length === 0 ? '—' : models.join(', ')),
    fact('duration', spanOf(s.lastAt - s.firstAt)),
    fact('app', s.app),
    fact('started', `${stampOf(s.firstAt)} UTC`),
    fact('input', count(totals.tokensIn)),
    fact(
      'cache hit',
      totals.ratio === null
        ? '—'
        : `${percentOf(totals.ratio)} · ${count(totals.cacheRead)} cached`,
    ),
  ]
  if (lowCacheIds(d.generations).size > 0) lines.push({ text: LOW_CACHE_LEGEND, tone: 'warning' })
  return lines
}

/** Up to `MESSAGE_LINES` lines of a text, indented, then a count of the rest. */
function clipped(text: string, tone: Tone): LogLine[] {
  const lines = text.split('\n')
  const shown: LogLine[] = lines
    .slice(0, MESSAGE_LINES)
    .map((line) => ({ text: `  ${line.length === 0 ? ' ' : line}`, tone }))
  if (lines.length > MESSAGE_LINES)
    shown.push({ text: `  … +${lines.length - MESSAGE_LINES} more lines`, tone: 'muted' })
  return shown
}

/** The generation level: the figures, then the messages sent, the tool calls and the response. */
export function callLines(d: LogsCallOutput): LogLine[] {
  const c = d.call
  const throughput = throughputOf(c.tokensOut, c.durationMs)
  const tokens = [`in ${count(c.tokensIn)}`, `out ${count(c.tokensOut)}`]
  if (c.reasoning !== null) tokens.push(`reasoning ${count(c.reasoning)}`)
  if (c.cacheRead !== null)
    tokens.push(`cache read ${count(c.cacheRead)} (${percentOf(cacheHitRatio(c))})`)
  const note = bodyNote(c.bodyState)
  const out: LogLine[] = [
    fact(
      'status',
      `${STATUS_CELL[c.status]}${c.finishReason === null ? '' : ` · finish ${c.finishReason}`}`,
    ),
    fact('started', `${stampOf(c.startedAt)} UTC`),
    fact(
      'call',
      `${c.kind}${c.trigger === null ? '' : ` · trigger ${c.trigger}`}${c.stepIndex === null ? '' : ` · step ${c.stepIndex}`}`,
    ),
    fact('model', c.modelId),
    fact(
      'provider',
      `${c.provider}${c.upstreamProvider === null ? '' : ` via ${c.upstreamProvider}`}`,
    ),
    fact(
      'latency',
      `${latencyOf(c.durationMs)}${c.firstChunkMs === null ? '' : ` · first chunk ${latencyOf(c.firstChunkMs)}`}`,
    ),
    fact('streaming', c.firstChunkMs === null ? 'no' : 'yes'),
    fact('speed', throughput ?? '—'),
    fact('tokens', tokens.join(' · ')),
    fact(
      'cost',
      c.costMicro === null
        ? 'unknown'
        : `${microUsd(c.costMicro)}${c.costSource === null ? '' : ` (${c.costSource})`}`,
    ),
    fact('fallbacks', c.fallbackNote ?? 'none'),
  ]
  if (c.errorName !== null)
    out.push({ text: `error  ${c.errorName}: ${c.errorMessage ?? ''}`, tone: 'danger' })
  if (c.speakerId !== null) out.push(fact('speaker', c.speakerId))
  out.push(fact('bodies', note === null ? c.bodyState : `${c.bodyState} · ${note}`))

  out.push({ text: ' ' }, { text: 'messages sent', bold: true })
  if (d.messages.length === 0) out.push({ text: '  no messages stored', tone: 'muted' })
  for (const m of d.messages) {
    out.push({ text: m.role, tone: 'accent', bold: true }, ...clipped(m.text, 'text'))
  }
  if (d.toolCalls.length > 0) {
    out.push({ text: ' ' }, { text: 'tool calls', bold: true })
    for (const t of d.toolCalls)
      out.push({ text: `  ${t.toolName}  ${oneLine(t.input)}`, tone: 'tool' })
  }
  out.push({ text: ' ' }, { text: 'response', bold: true })
  if (d.outputText === '')
    out.push({ text: '  no text (the model only called tools)', tone: 'muted' })
  else out.push(...clipped(d.outputText, 'text'))
  if (d.reasoning !== '')
    out.push({ text: `  reasoning  ${count(d.reasoning.length)} characters`, tone: 'muted' })
  if (d.truncated) out.push({ text: '  the body was cut to its size cap', tone: 'warning' })
  return out
}

/** The JSON pretty-printed; a body the cap cut (not valid JSON any more) is shown as it is. */
function prettyJson(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    return body
  }
}

/** The raw level: the request, then the response; a missing body says so, a cut one is flagged at the top. */
export function rawLines(raw: LogsRawOutput): LogLine[] {
  const out: LogLine[] = []
  const note = bodyNote(raw.bodyState)
  if (note !== null) out.push({ text: note, tone: 'warning' })
  if (raw.truncated)
    out.push({ text: 'truncated: the body was cut to the size the wire carries', tone: 'warning' })
  if (note !== null || raw.truncated) out.push({ text: ' ' })
  const parts = [
    ['request', raw.request],
    ['response', raw.response],
  ] as const
  for (const [label, body] of parts) {
    out.push({ text: label, bold: true })
    if (body === null) out.push({ text: '  no stored body', tone: 'muted' })
    else
      for (const line of prettyJson(body).split('\n')) out.push({ text: line === '' ? ' ' : line })
    out.push({ text: ' ' })
  }
  return out
}
