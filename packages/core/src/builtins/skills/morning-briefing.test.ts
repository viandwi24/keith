import { describe, expect, test } from 'bun:test'
import { loadSkillInstructions } from '@keith/sdk'
import { MORNING_BRIEFING_SKILL, morningBriefingSkill } from './morning-briefing.ts'

describe('morning_briefing', () => {
  test('name and description', () => {
    expect(MORNING_BRIEFING_SKILL).toBe('morning_briefing')
    expect(morningBriefingSkill.name).toBe('morning_briefing')
    expect(morningBriefingSkill.description).toContain(
      'Load at the start of a briefing or when someone asks what they missed.',
    )
  })

  test('the instructions load from the .md file, mention reminder.list and stay short', async () => {
    expect(typeof morningBriefingSkill.instructions).toBe('function')
    const text = await loadSkillInstructions(morningBriefingSkill)
    expect(text.trim().length).toBeGreaterThan(0)
    expect(text).toContain('reminder.list')
    expect(text.length).toBeLessThan(2000)
  })

  test('the instructions cover the briefing rules', async () => {
    const text = await loadSkillInstructions(morningBriefingSkill)
    for (const phrase of ['by name', 'relationship card', 'six sentences', 'Drop no item', 'no markdown']) {
      expect(text).toContain(phrase)
    }
  })
})
