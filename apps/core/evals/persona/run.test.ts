/**
 * The `persona` eval offline (`--scripted`, docs/specs/evals.md, ADR-0029 §8): an assistant that keeps the rules passes (exit 0),
 * one that breaks them fails (exit 1) with each broken rule named, the scorer catches each rule on its own, and the real mode
 * refuses to run without a key.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../src/platform/config.ts'
import {
  escapedJson,
  MEMORY_NOTE,
  PERSONA_CASES,
  type PersonaCase,
  RULE_STYLE,
  SHORT_CAP,
  SPEECH_CAP,
  scoreTurn,
  styleNeverInPrompt,
  type TurnObservation,
} from './cases.ts'
import { main } from './cli.ts'
import { LONG_TEXT } from './scripts.ts'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const newDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function capture() {
  const lines: string[] = []
  const errors: string[] = []
  return {
    lines,
    errors,
    out: (line: string) => void lines.push(line),
    err: (line: string) => void errors.push(line),
  }
}

const reportFile = (dir: string): string => {
  const file = readdirSync(dir).find((n) => n.startsWith('persona-') && n.endsWith('.json'))
  if (file === undefined) throw new Error('no persona report')
  return join(dir, file)
}

interface ReportCase {
  id: string
  answer: string
  checks: { name: string; ok: boolean }[]
}

const caseOf = (id: string): PersonaCase => {
  const item = PERSONA_CASES.find((c) => c.id === id)
  if (item === undefined) throw new Error(`no case ${id}`)
  return item
}

const BLOCK = escapedJson('Tone: calm.\nHumour: none.')

/** An observation that keeps every rule for a plain turn (the current block in the call, no list, no phrase). */
const clean = (over: Partial<TurnObservation> = {}): TurnObservation => ({
  answer: 'Doing well, thanks.',
  prompts: [`call with ${BLOCK}`],
  block: BLOCK,
  ...over,
})

const failedNames = (results: { name: string; ok: boolean }[]): string[] =>
  results.filter((r) => !r.ok).map((r) => r.name)

describe('eval:persona --scripted', () => {
  test('an assistant that keeps the rules passes: exit 0, every check ok, a 0600 report', async () => {
    const out = newDir('keith-persona-out-')
    const io = capture()
    const code = await main(['--scripted', '--out', out], io)
    expect(code).toBe(0)
    expect(io.lines.at(-1)).toContain('PASS: 0 failed checks over 6 of 6 cases')
    expect(io.errors).toEqual([])
    const report = JSON.parse(readFileSync(reportFile(out), 'utf8')) as Record<string, unknown>
    expect(report).toMatchObject({ mode: 'scripted', ok: true, failedChecks: 0, complete: true })
    const cases = report.cases as ReportCase[]
    expect(cases.map((c) => c.id)).toEqual(PERSONA_CASES.map((c) => c.id))
    for (const c of cases) expect(failedNames(c.checks)).toEqual([])
    expect(statSync(reportFile(out)).mode & 0o777).toBe(0o600)
  }, 60_000)

  test('an assistant that breaks the rules fails: exit 1, each broken rule is named with its case', async () => {
    const out = newDir('keith-persona-leak-')
    const io = capture()
    const code = await main(['--scripted', '--script', 'leaky', '--out', out], io)
    expect(code).toBe(1)
    expect(io.lines.at(-1)).toContain('FAIL: 4 failed checks over 6 of 6 cases')
    const named = io.errors.join('\n')
    expect(named).toContain('one-sentence: noBulletList FAILED')
    expect(named).toContain('memory-voice: noForbiddenPhrase FAILED')
    expect(named).toContain('brevity-short: briefnessHonoured FAILED')
    expect(named).toContain('speech: speechCap FAILED')
    // the template switch and the refused style are the server's and the prompt's: the leaky script does not change them
    expect(named).not.toContain('template-switch')
    expect(named).not.toContain('rule-style')
    const report = JSON.parse(readFileSync(reportFile(out), 'utf8')) as Record<string, unknown>
    expect(report).toMatchObject({ ok: false, failedChecks: 4 })
  }, 60_000)

  test('an unknown script is a usage error (exit 2) and nothing runs', async () => {
    const io = capture()
    expect(await main(['--scripted', '--script', 'nope'], io)).toBe(2)
    expect(io.errors[0]).toContain('--script must be one of')
  })

  test('the real mode needs OPENROUTER_API_KEY and --model: exit 2 without them', async () => {
    const io = capture()
    const dir = newDir('keith-persona-nokey-')
    const code = await main(['--out', dir], {
      ...io,
      loadConfig: () => loadConfig({ KEITH_DATA_DIR: dir, KEITH_BUILD_SHA: 'test' }),
    })
    expect(code).toBe(2)
    expect(io.errors[0]).toContain('OPENROUTER_API_KEY')
    expect(existsSync(join(dir, 'evals'))).toBe(false)
  })
})

describe('the persona scorer', () => {
  test('a one-sentence answer with a bullet list fails noBulletList; a plain one passes', () => {
    const item = caseOf('one-sentence')
    expect(
      failedNames(scoreTurn(item, clean({ answer: 'I can help.\n\n- Plans\n- Notes' }))),
    ).toEqual(['noBulletList'])
    expect(failedNames(scoreTurn(item, clean()))).toEqual([])
  })

  test('the two forbidden phrases, in any case, fail noForbiddenPhrase', () => {
    const item = caseOf('memory-voice')
    expect(
      failedNames(scoreTurn(item, clean({ answer: 'According to my notes, you like tea.' }))),
    ).toEqual(['noForbiddenPhrase'])
    expect(failedNames(scoreTurn(item, clean({ answer: 'As an AI assistant I cannot.' })))).toEqual(
      ['noForbiddenPhrase'],
    )
  })

  test('the persona block must be in every call and the stale block in none', () => {
    const item = caseOf('template-switch')
    expect(failedNames(scoreTurn(item, clean({ prompts: [] })))).toEqual(['personaFollowsTemplate'])
    expect(failedNames(scoreTurn(item, clean({ prompts: ['no block here'] })))).toEqual([
      'personaFollowsTemplate',
    ])
    const stale = escapedJson('Tone: warm.')
    expect(
      failedNames(
        scoreTurn(item, clean({ prompts: [`${BLOCK} and ${stale}`], staleBlock: stale })),
      ),
    ).toEqual(['personaFollowsTemplate'])
  })

  test('brevity short: the answer is capped and the reminder must hold the setting, the rule and the note', () => {
    const item = caseOf('brevity-short')
    const reminder = [
      `${BLOCK} Brevity: short. Explicit settings above win over anything you remember. ${escapedJson(MEMORY_NOTE)}`,
    ]
    expect(failedNames(scoreTurn(item, clean({ answer: 'Short.', prompts: reminder })))).toEqual([])
    expect(
      failedNames(scoreTurn(item, clean({ answer: 'x'.repeat(SHORT_CAP + 1), prompts: reminder }))),
    ).toEqual(['briefnessHonoured'])
    // no setting in the reminder: the memory note alone does not satisfy the check
    expect(
      failedNames(
        scoreTurn(
          item,
          clean({ answer: 'Short.', prompts: [`${BLOCK} ${escapedJson(MEMORY_NOTE)}`] }),
        ),
      ),
    ).toEqual(['briefnessHonoured'])
  })

  test('a spoken answer is capped and carries no markup; the speech block must be in the reminder', () => {
    const item = caseOf('speech')
    const speech = [
      `${BLOCK} Imagine this is read aloud over the phone. Use full natural sentences`,
    ]
    expect(
      failedNames(scoreTurn(item, clean({ answer: 'Check your passport.', prompts: speech }))),
    ).toEqual([])
    expect(LONG_TEXT.length).toBeGreaterThan(SPEECH_CAP)
    expect(failedNames(scoreTurn(item, clean({ answer: LONG_TEXT, prompts: speech })))).toEqual([
      'speechCap',
    ])
    expect(
      failedNames(scoreTurn(item, clean({ answer: 'Use **bold** here.', prompts: speech }))),
    ).toEqual(['speechCap'])
    expect(
      failedNames(scoreTurn(item, clean({ answer: 'Check the bag.', prompts: [BLOCK] }))),
    ).toEqual(['speechCap'])
  })

  test('the refused style is VALIDATION:not-a-style-value and the address stays unset', () => {
    const item = caseOf('rule-style')
    const refused = {
      refusal: { code: 'VALIDATION', reason: 'not-a-style-value' },
      styleAddress: null,
    }
    expect(failedNames(scoreTurn(item, clean(refused)))).toEqual([])
    expect(failedNames(scoreTurn(item, clean({ styleAddress: null })))).toEqual(['styleRefused'])
    expect(
      failedNames(
        scoreTurn(
          item,
          clean({ refusal: { code: 'VALIDATION', reason: 'line-too-long' }, styleAddress: null }),
        ),
      ),
    ).toEqual(['styleRefused'])
    expect(
      failedNames(scoreTurn(item, clean({ refusal: refused.refusal, styleAddress: RULE_STYLE }))),
    ).toEqual(['styleRefused'])
  })

  test('the refused style value reaches no model call of the run', () => {
    expect(styleNeverInPrompt(['a call with Tone: calm.'])).toMatchObject({ ok: true })
    expect(styleNeverInPrompt([`a call that says "${RULE_STYLE}"`])).toMatchObject({
      name: 'styleNeverInPrompt',
      ok: false,
    })
  })
})
