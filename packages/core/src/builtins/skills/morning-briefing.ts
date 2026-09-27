// The core's default `morning_briefing` skill (phase 4). A plugin skill with the same name replaces
// it (docs/contracts/plugin-api.md#skills).
// Placeholder (P4-K1): the name and description are final; the instructions are a draft that task
// P4-D1 replaces with a `.md` file.

import { defineSkill, type Skill } from '@keith/sdk'

export const MORNING_BRIEFING_SKILL = 'morning_briefing'

export const morningBriefingSkill: Skill = defineSkill({
  name: MORNING_BRIEFING_SKILL,
  description:
    'How to brief a person on what they missed. Load at the start of a briefing or when someone asks what they missed.',
  instructions:
    'Greet the person by name, in the tone of their relationship card. Lead with what needs action ' +
    '(critical and high items, and reminders due today; use reminder.list if it is available), then ' +
    'finished work, then plugin items such as weather or news, then anything else. Keep it to about six ' +
    'sentences unless asked for more, and drop no item. When nothing is pending, give a short greeting ' +
    'and one useful line. When the reply is spoken, use no lists or markdown.',
})
