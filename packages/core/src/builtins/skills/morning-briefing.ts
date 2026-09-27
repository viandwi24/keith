// The core's default `morning_briefing` skill (phase 4). A plugin skill with the same name replaces
// it (docs/contracts/plugin-api.md#skills). The instructions live in `morning-briefing.md` and go
// into the context whole when the model calls `skill.load`, so keep them short.

import { defineSkill, type Skill } from '@keith/sdk'

export const MORNING_BRIEFING_SKILL = 'morning_briefing'

/** The instructions file, next to this module. */
export const MORNING_BRIEFING_INSTRUCTIONS_URL = new URL('./morning-briefing.md', import.meta.url)

export const morningBriefingSkill: Skill = defineSkill({
  name: MORNING_BRIEFING_SKILL,
  description:
    'How to brief a person on what they missed. Load at the start of a briefing or when someone asks what they missed.',
  instructions: () => Bun.file(MORNING_BRIEFING_INSTRUCTIONS_URL).text(),
})
