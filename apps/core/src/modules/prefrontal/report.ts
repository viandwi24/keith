// Report mode for a worker's result (P33.4.4, docs/specs/prefrontal.md "Report mode"; ADR-0029 §5). The worker's report reaches the
// front agent as a wake turn: eharness's subagent plugin injects it as an `eh.event` named `subagent` (the text is built by eharness,
// `subagent/park-hook.ts`; Keith does not patch it, ADR-0011). This plugin reads that event in `step.prepare` and adds the report
// block to the step's reminder. A report over about 1,500 characters or 20 lines is saved as a document (the same function as
// `document_save`), and the reminder names the saved path. A short report is not saved.
import type { HarnessContext, HarnessPlugin } from 'eharness'
import { definePlugin } from 'eharness'
import { workspaceOf } from '../cortex/index.ts'
import { DocumentError, saveDocument } from './document-tool.ts'

export const REPORT_PLUGIN = 'keith-prefrontal-report'
/** The fixed report block of the reminder (ADR-0029 §5, `report` mode). */
export const REPORT_BLOCK =
  'Start with a conclusion of one to three sentences. Then offer the details.'
/** A report over this many characters, or over `REPORT_LONG_LINES` lines, is saved as a document. */
export const REPORT_LONG_CHARS = 1500
export const REPORT_LONG_LINES = 20
/** The head line eharness puts before a background worker's report ("Background subagent … finished."). */
const HEAD_LINE = /^(Background|Resumed) subagent /
/** The `eh.event` name eharness gives a background worker's report (`subagent/report.ts`). */
export const REPORT_EVENT = 'subagent'
/** The plugin state key of the last saved report: its hash and its path, so a later step saves nothing twice. */
export const REPORT_STATE = 'lastSaved'

export interface ReportDeps {
  /** The data folder of the core (the person's documents folder lives under it). */
  dataDir: string
  now?: () => Date
  /** Logs a long report that could not be saved: the reason only, never the content (FR3-05). */
  warn?: (message: string) => void
}

/** Whether a report is long enough to be saved as a document rather than spoken in full. */
export function isLongReport(text: string): boolean {
  return text.length > REPORT_LONG_CHARS || text.split('\n').length > REPORT_LONG_LINES
}

/** The text of a model message's content (a string, or the text parts of an array). */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      const p = part as { type?: unknown; text?: unknown }
      return p.type === 'text' && typeof p.text === 'string' ? p.text : ''
    })
    .join('')
}

/**
 * The report a turn answers: the body of the `subagent` event that is the step's last user message. A person's own message after
 * it (or no event at all) means this turn does not answer a report.
 */
export function reportOfMessages(
  messages: ReadonlyArray<{ role: string; content: unknown }>,
): string | undefined {
  const last = messages.findLast((m) => m.role === 'user')
  if (last === undefined) return undefined
  const text = textOfContent(last.content)
  const match = new RegExp(`<event name="${REPORT_EVENT}">([\\s\\S]*)</event>`).exec(text)
  const body = match?.[1]?.trim()
  return body === undefined || body === '' ? undefined : body
}

/** A short title of a report: its first line, without Markdown marks. */
export function reportTitleOf(body: string): string {
  // the first line that is not eharness's head of the report ("Background subagent … finished.")
  const lines = body.split('\n').filter((line) => line.trim() !== '')
  const first = lines.find((line) => !HEAD_LINE.test(line)) ?? lines[0] ?? ''
  const clean = first
    .replace(/[#*_`>[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return clean === '' ? 'Report' : `Report: ${clean}`
}

/** The reminder of a report step: the block, and the saved path when the report was saved. */
export function reportReminder(savedPath: string | undefined): string {
  if (savedPath === undefined) {
    return `${REPORT_BLOCK} The report is long: give the conclusion, then offer the details in one sentence.`
  }
  return `${REPORT_BLOCK} The full report is saved as ${savedPath} in the person's workspace. Do not paste it here: say so in one sentence and offer to send the file name.`
}

/** Why a save failed, as one word: the refusal of the document tool, or the system error code. Never the message or the content. */
function failureReason(error: unknown): string {
  if (error instanceof DocumentError) return error.reason
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'unknown'
}

/** The hash of a report text (the key of the saved copy). */
const keyOf = (body: string): string => Bun.hash(body).toString()

/**
 * Saves a long report once: the same report on a later step of the turn returns the path it was saved under. A report that cannot
 * be saved (no person, an unsafe folder) returns `undefined`, and the reminder then says only the block.
 */
function savedPathOf(ctx: HarnessContext, body: string, deps: ReportDeps): string | undefined {
  const key = keyOf(body)
  const last = ctx.state.get<{ key: string; path: string }>(REPORT_STATE)
  if (last?.key === key) return last.path
  const dir = workspaceOf(deps.dataDir, ctx)
  if (dir === undefined) return undefined
  try {
    const path = saveDocument(
      dir,
      { title: reportTitleOf(body), body },
      (deps.now ?? (() => new Date()))(),
    )
    ctx.state.set(REPORT_STATE, { key, path })
    return path
  } catch (error) {
    deps.warn?.(`prefrontal: could not save the report: ${failureReason(error)}`)
    return undefined
  }
}

/**
 * The `step.prepare` answer for one step: nothing when the step does not answer a report; otherwise the report block, with the
 * saved path of a long report. Never throws: a failed save only leaves the path out.
 */
export function reportStep(
  ctx: HarnessContext,
  messages: ReadonlyArray<{ role: string; content: unknown }>,
  deps: ReportDeps,
): { reminder: string } | undefined {
  const body = reportOfMessages(messages)
  if (body === undefined) return undefined
  if (!isLongReport(body)) return { reminder: REPORT_BLOCK }
  return { reminder: reportReminder(savedPathOf(ctx, body, deps)) }
}

/** Plugin of the report mode: added to the front agent only; it adds a reminder and never a tool. */
export function createReportPlugin(deps: ReportDeps): HarnessPlugin<typeof REPORT_PLUGIN> {
  return definePlugin({
    name: REPORT_PLUGIN,
    setup: () => ({
      hooks: {
        'step.prepare': (ctx, e) => {
          try {
            return reportStep(ctx, e.messages, deps)
          } catch {
            return undefined
          }
        },
      },
    }),
  })
}
