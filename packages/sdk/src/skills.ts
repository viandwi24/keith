/** A named instruction bundle, loaded into context on demand with `skill.load`. */
export interface Skill {
  /** snake_case, unique. */
  name: string
  /** One line. Goes into every context (the skills index). */
  description: string
  /** The full instructions. Loaded only when the model calls `skill.load`. */
  instructions: string | (() => string | Promise<string>)
}

export interface SkillRegistry {
  register(skill: Skill): void
}

export function defineSkill(skill: Skill): Skill {
  return skill
}

/** Resolves a skill's instructions whether they are a string or a loader. */
export async function loadSkillInstructions(skill: Skill): Promise<string> {
  return typeof skill.instructions === 'string' ? skill.instructions : await skill.instructions()
}
