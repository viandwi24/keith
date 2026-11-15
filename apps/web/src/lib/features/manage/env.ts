import { capsOf, type SectionEnv } from '@keith/app-model/manage'
import { getClient, session } from '../session/index.ts'

/** What a section model reads: the page's client, who is signed in and what their role grants. */
export function sectionEnv(extra: Partial<SectionEnv> = {}): SectionEnv {
  const me = session.me
  if (me === undefined) throw new Error('not signed in')
  return { client: getClient(), me, caps: capsOf(me), ...extra }
}
