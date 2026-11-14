/** `report.md` and `result.json` of an eval run. Secrets are redacted before anything is written. */
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { redactString } from '../../src/platform/logger.ts'
import type { NewsRun } from '../../src/testing/news-session.ts'
import { allOk, type NewsCheckName, type TranscriptEvent, transcriptOf } from './checks.ts'

export interface RunRecord {
  run: number
  ok: boolean
  prompt: string
  checks: Record<NewsCheckName, { ok: boolean; failures: string[] }>
  costUsd: number
  ackMs: number
  totalMs: number
  timedOut: boolean
  aborted: string | undefined
  taskStatus: string | undefined
  transcript: TranscriptEvent[]
}

export interface EvalResult {
  mode: 'real' | 'scripted'
  startedAt: string
  ok: boolean
  totalCostUsd: number
  maxUsd: number
  runs: RunRecord[]
}

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*[=:]\s*\S+/g,
]

/** Report folders kept: the newest ones by name (the name holds the start time); older ones are removed. */
export const REPORTS_KEPT = 20
const REPORT_FOLDER = /^news-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/

/**
 * Hide env-like secrets, the exact values the caller knows about, and the credential shapes of the logger
 * (`redactString`: `keith_` tokens, JWTs, Bearer values, provider keys).
 */
export function redact(text: string, secrets: Array<string | undefined> = []): string {
  let out = text
  for (const secret of secrets) {
    if (secret !== undefined && secret.length >= 6) out = out.split(secret).join('[redacted]')
  }
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]')
  return redactString(out)
}

export function recordOf(run: NewsRun, index: number): RunRecord {
  return {
    run: index,
    ok: allOk(run.checks) && !run.timedOut && run.aborted === undefined,
    prompt: run.prompt,
    checks: run.checks,
    costUsd: run.costUsd,
    ackMs: run.ackMs,
    totalMs: run.totalMs,
    timedOut: run.timedOut,
    aborted: run.aborted,
    taskStatus: run.tasks.at(-1)?.status,
    transcript: transcriptOf(run.messages),
  }
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`

export function renderReport(result: EvalResult): string {
  const lines = [
    '# Eval "show me the news"',
    '',
    `- mode: ${result.mode}`,
    `- started: ${result.startedAt}`,
    `- result: ${result.ok ? 'PASS' : 'FAIL'}`,
    `- cost: ${result.totalCostUsd.toFixed(4)} USD (limit ${result.maxUsd} USD)`,
    '',
  ]
  for (const r of result.runs) {
    lines.push(`## Run ${r.run}: ${r.ok ? 'PASS' : 'FAIL'}`, '')
    lines.push(`Prompt: ${r.prompt}`, '')
    lines.push(
      `Cost ${r.costUsd.toFixed(4)} USD, first reply ${seconds(r.ackMs)}, total ${seconds(r.totalMs)}, task ${r.taskStatus ?? 'none'}`,
    )
    if (r.timedOut) lines.push('', 'TIMED OUT waiting for the proactive answer.')
    if (r.aborted !== undefined) lines.push('', `ABORTED: ${r.aborted} limit exceeded.`)
    lines.push('', '| Check | Result | Failures |', '| --- | --- | --- |')
    for (const [name, c] of Object.entries(r.checks)) {
      lines.push(`| ${name} | ${c.ok ? 'pass' : 'FAIL'} | ${c.failures.join('; ') || '-'} |`)
    }
    lines.push('', '### Transcript', '')
    for (const e of r.transcript) {
      if (e.kind === 'agent-call') lines.push(`- [tool agent: ${e.subagentType}]`)
      else if (e.kind === 'report')
        lines.push(`- [worker report, ${e.status ?? 'inline'}] ${e.text}`)
      else lines.push(`- ${e.kind === 'owner' ? 'owner' : 'keith'}: ${e.text}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Remove the report folders of `parent` beyond the newest `keep`. Only folders named like a run's report
 * (`news-<start time>`) are considered; anything else in `parent` is never touched. Returns the removed paths.
 */
export function pruneReportFolders(parent: string, keep: number = REPORTS_KEPT): string[] {
  let names: string[]
  try {
    names = readdirSync(parent)
  } catch {
    return []
  }
  const folders = names
    .filter((name) => REPORT_FOLDER.test(name) && statSync(join(parent, name)).isDirectory())
    .sort()
  const old = folders.slice(0, Math.max(0, folders.length - keep)).map((name) => join(parent, name))
  for (const path of old) rmSync(path, { recursive: true, force: true })
  return old
}

/**
 * Write `report.md` and `result.json` into `dir` (created 0700), redacted, both 0600; then keep the newest
 * `REPORTS_KEPT` report folders next to it. Returns the two paths.
 */
export function writeReport(
  dir: string,
  result: EvalResult,
  secrets: Array<string | undefined> = [],
): { report: string; json: string } {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const report = join(dir, 'report.md')
  const json = join(dir, 'result.json')
  writeOwnerOnly(report, redact(renderReport(result), secrets))
  writeOwnerOnly(json, redact(JSON.stringify(result, null, 2), secrets))
  pruneReportFolders(dirname(dir))
  return { report, json }
}

function writeOwnerOnly(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 })
  chmodSync(path, 0o600)
}
