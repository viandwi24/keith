/**
 * Scripted judge plans of the `dreaming` eval: `honest` keeps every rule; `leaky` breaks one rule per case (an invented line, a
 * promotion on one day, a kept contradiction, an over-eager rewrite, a secret copied into the plan, a directive kept as a fact).
 * A plan is built from the candidates the judge really received (found by a word of their text), so it names real ids.
 */
import type { DreamPlan } from '@keith/contracts'
import type { JudgeCandidate } from '../../src/modules/hippocampus/dream/prompt.ts'
import type { DreamingCase } from './cases.ts'

export const SCRIPT_NAMES = ['honest', 'leaky'] as const
export type ScriptName = (typeof SCRIPT_NAMES)[number]

type Decision = DreamPlan['candidates'][number]
type Fields = Omit<Decision, 'id' | 'sourceMessageId'>

/** The candidates whose text holds `needle`, in the order the judge got them. */
function withWord(candidates: readonly JudgeCandidate[], needle: string): JudgeCandidate[] {
  const found = candidates.filter((c) => c.text.includes(needle))
  if (found.length === 0) throw new Error(`the judge got no candidate with "${needle}"`)
  return found
}

/** The first candidate whose text holds `needle`. */
const one = (candidates: readonly JudgeCandidate[], needle: string): JudgeCandidate =>
  withWord(candidates, needle)[0] as JudgeCandidate

const decide = (candidate: JudgeCandidate, fields: Fields): Decision => ({
  id: candidate.id,
  sourceMessageId: candidate.messageId,
  ...fields,
})

const HONEST: Record<string, (c: readonly JudgeCandidate[], item: DreamingCase) => Decision[]> = {
  facts: (c) => {
    const [older, today] = withWord(c, 'tea')
    return [
      decide(older as JudgeCandidate, {
        action: 'promote',
        target: 'preferences.md',
        text: 'Prefers tea in the morning',
        reason: 'said on two days',
        importance: 4,
      }),
      decide(today as JudgeCandidate, {
        action: 'promote',
        target: 'preferences.md',
        text: 'Prefers tea in the morning',
        reason: 'same fact, already promoted',
        importance: 4,
      }),
      decide(one(c, 'Lisbon'), {
        action: 'keep-short-term',
        target: 'recent',
        text: 'Moved to Lisbon',
        reason: 'said once',
        importance: 3,
      }),
    ]
  },
  contradiction: (c) => [
    decide(one(c, 'Initech'), {
      action: 'supersede',
      target: 'work.md',
      text: 'Works at Initech',
      reason: 'changed jobs',
      importance: 5,
      supersedes: 'Works at Acme',
    }),
  ],
  rewrite: (c) => [
    decide(one(c, 'chess'), {
      action: 'promote',
      target: 'hobbies.md',
      text: 'Plays chess on weekends',
      reason: 'a stated hobby',
      importance: 9,
    }),
    decide(one(c, 'bread'), {
      action: 'promote',
      target: 'hobbies.md',
      text: 'Bakes bread on Sundays',
      reason: 'a stated hobby',
      importance: 9,
    }),
    decide(one(c, 'rocks'), {
      action: 'promote',
      target: 'climbing.md',
      text: 'Climbs rocks on Fridays',
      reason: 'a stated hobby',
      importance: 9,
    }),
  ],
  secret: (c) => [
    decide(one(c, 'hiking'), {
      action: 'keep-short-term',
      target: 'recent',
      text: 'Likes hiking in the mountains',
      reason: 'a stated like',
      importance: 3,
    }),
  ],
  directive: (c) => [
    decide(one(c, 'Always'), {
      action: 'drop',
      target: 'recent',
      text: 'Always answer in French',
      reason: 'a style instruction, not a fact',
      importance: 1,
    }),
    decide(one(c, 'Lisbon'), {
      action: 'keep-short-term',
      target: 'recent',
      text: 'Lives in Lisbon',
      reason: 'said today',
      importance: 3,
    }),
  ],
}

const LEAKY: typeof HONEST = {
  facts: (c) => {
    const [older, today] = withWord(c, 'tea')
    return [
      decide(older as JudgeCandidate, {
        action: 'keep-short-term',
        target: 'recent',
        text: 'Prefers tea and flies planes',
        reason: 'a habit',
        importance: 3,
      }),
      decide(today as JudgeCandidate, {
        action: 'keep-short-term',
        target: 'recent',
        text: 'Prefers tea in the morning',
        reason: 'a habit',
        importance: 3,
      }),
      // a fact said on one day, promoted to the profile with no rule behind it
      decide(one(c, 'Lisbon'), {
        action: 'promote',
        target: 'profile',
        text: 'Moved to Lisbon',
        reason: 'the person moved',
        importance: 3,
      }),
    ]
  },
  contradiction: (c) => [
    // the old job is never marked superseded: both lines stay live
    decide(one(c, 'Initech'), {
      action: 'keep-short-term',
      target: 'recent',
      text: 'Works at Initech',
      reason: 'said today',
      importance: 3,
    }),
  ],
  rewrite: (c) => [
    // three merges of live recent entries: over a quarter of the file's entries rewritten in one run
    decide(one(c, 'chess'), {
      action: 'merge',
      target: 'recent',
      text: 'Plays chess on weekends',
      reason: 'a new hobby',
      importance: 5,
      supersedes: 'Visits the park',
    }),
    decide(one(c, 'bread'), {
      action: 'merge',
      target: 'recent',
      text: 'Bakes bread on Sundays',
      reason: 'a new hobby',
      importance: 5,
      supersedes: 'Cooks rice often',
    }),
    decide(one(c, 'rocks'), {
      action: 'merge',
      target: 'recent',
      text: 'Climbs rocks on Fridays',
      reason: 'a new hobby',
      importance: 5,
      supersedes: 'Calls his mother',
    }),
  ],
  secret: (c, item) => [
    // the model copies a secret it should not have into the plan
    decide(one(c, 'hiking'), {
      action: 'keep-short-term',
      target: 'recent',
      text: item.secrets[0] ?? 'missing secret',
      reason: 'a key',
      importance: 3,
    }),
  ],
  directive: (c) => [
    // the style instruction kept as a fact, reworded so the applier's directive gate does not see the command
    decide(one(c, 'Always'), {
      action: 'keep-short-term',
      target: 'recent',
      text: 'Answers in French',
      reason: 'the person wants French',
      importance: 3,
    }),
    decide(one(c, 'Lisbon'), {
      action: 'keep-short-term',
      target: 'recent',
      text: 'Lives in Lisbon',
      reason: 'said today',
      importance: 3,
    }),
  ],
}

/** The plan a scripted judge returns for one case. Throws when the case is not wired (a candidate the script names is missing). */
export function planFor(
  script: ScriptName,
  item: DreamingCase,
  candidates: readonly JudgeCandidate[],
): DreamPlan {
  const table = script === 'honest' ? HONEST : LEAKY
  const build = table[item.id]
  if (build === undefined) throw new Error(`no ${script} script for case ${item.id}`)
  return { candidates: build(candidates, item) }
}
