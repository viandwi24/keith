import { capsOf, SECTION_META, type SectionMeta, visibleSections } from '@keith/app-model/manage'
import type { Whoami } from '@keith/contracts'

/** The Manage sections this person may open, in the list's order: the same capabilities the TUI checks (the server checks again). */
export const sectionsFor = (me: Pick<Whoami, 'capabilities'> | undefined): SectionMeta[] =>
  me === undefined ? [] : visibleSections(SECTION_META, capsOf(me))

export const sectionOf = (id: string): SectionMeta | undefined =>
  SECTION_META.find((s) => s.id === id)

/** Whether this person's capabilities show a section (a hidden one says so instead of loading). */
export const canOpen = (me: Pick<Whoami, 'capabilities'> | undefined, id: string): boolean =>
  sectionsFor(me).some((s) => s.id === id)

/** The path of a section under the app base (`/app/manage/people`). */
export const sectionHref = (base: string, id: string): string => `${base}/manage/${id}`

/** One line of a section's info rows (`mode      local`) as a label and a value; a line without a label column is all value. */
export function splitFact(line: string): { label: string; value: string } {
  const m = /^(\S+(?: \S+)*?) {2,}(.*)$/.exec(line)
  return m === null ? { label: '', value: line } : { label: m[1] ?? '', value: m[2] ?? '' }
}
