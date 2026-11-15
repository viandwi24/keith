// Onboarding of a person with no stored style (docs/specs/prefrontal.md "Onboarding"; ADR-0034 §4). A short block of the turn
// reminder, for that person only, while `person_style` has no row for them. `style_set` stores a row and ends it; "skip" is
// `style_set` with no field, which stores the defaults. The block is in the volatile reminder, never in the system prompt.
import type { PeopleService } from '../people/index.ts'
import { createOwnerCheck } from './service.ts'
import type { PersonStyleService } from './style.ts'

const PERSON_BLOCK =
  'Onboarding: you do not know yet how this person wants to be spoken to. Early in this conversation, in your own words and in one short message, ask: how to address them, which language to reply in, and how long answers should be (short, normal or full). Then save the answers with style_set. If they say skip, call style_set with no fields, which stores the defaults. Once saved, never ask again unless they ask.'

const OWNER_EXTRA =
  ' Also ask the owner which persona to use: butler, friend or professional (or describe their own); set it with persona_template or persona_edit, which wait for their approval.'

/** The onboarding block for a person: undefined once they have a style row (or when they cannot be read). */
export type OnboardingOf = (personId: string) => Promise<string | undefined>

export interface OnboardingDeps {
  styles: Pick<PersonStyleService, 'has'>
  people: Pick<PeopleService, 'get'>
}

export function createOnboarding(deps: OnboardingDeps): OnboardingOf {
  const owner = createOwnerCheck(deps.people)
  return async (personId) => {
    if (deps.styles.has({ by: personId, via: 'local', elevated: false })) return undefined
    return (await owner.isOwner(personId)) ? `${PERSON_BLOCK}${OWNER_EXTRA}` : PERSON_BLOCK
  }
}
