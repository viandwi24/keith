// The TUI's Persona section hook (docs/specs/tui.md, "Persona"): the shared model (`personaSection`) read through `useLoad`, and read again
// when anyone changes the persona.
import { personaSection } from '@keith/app-model/manage'
import { watchPersona } from '@keith/client'
import { useEffect } from 'react'
import type { ManageEnv, SectionData } from '../manage/manage-types.ts'
import { useLoad } from '../manage/use-load.ts'
import { sectionEnvOf } from '../manage/use-section-model.ts'

/** Manage's "Persona" section: the current persona, its history with restore, the template picker and the field editor. */
export function usePersonaSection(env: ManageEnv): SectionData {
  const { client } = env
  const model = personaSection(sectionEnvOf(env))
  const loaded = useLoad(() => model.load())
  const { reload } = loaded
  // a change made by anyone (another owner session, or this one) reads the persona again
  useEffect(() => watchPersona({ feed: client.feed(), refetch: reload }), [client, reload])
  return { ...model.build(loaded.data), error: loaded.error, loading: loaded.loading, reload }
}
