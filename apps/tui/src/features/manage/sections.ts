import { SECTION_META, type SectionId } from '@keith/app-model/manage'
import { usePersonaSection } from '../persona/index.ts'
import { LogsPane } from './logs/index.ts'
import type { ManageSection, PaneSectionDef, SectionDef } from './manage-types.ts'
import { useNodesSection } from './nodes/use-nodes-section.ts'
import { useModelOf } from './use-section-model.ts'

/** The hook of a table section: most read their model from `@keith/app-model/manage`; two keep their own wiring. */
const USE: Partial<Record<SectionId, SectionDef['use']>> = {
  nodes: useNodesSection,
  persona: usePersonaSection,
}

/** Every table section in the order of the list; `visibleSections` keeps the ones a role may read. */
export const SECTIONS: readonly SectionDef[] = SECTION_META.filter((s) => s.id !== 'logs').map(
  (s) => ({ ...s, use: USE[s.id] ?? useModelOf(s.id) }),
)

/** The sections that draw their own pane (Logs: levels, a filter, a raw view); they are not row lists, so not in `SECTIONS`. */
const PANE_SECTIONS: readonly PaneSectionDef[] = SECTION_META.filter((s) => s.id === 'logs').map(
  (s) => ({ ...s, pane: LogsPane }),
)

/** Every section in the order of the list: a pane section sits before Privacy (budget, logs, privacy, audit). */
export const MANAGE_SECTIONS: readonly ManageSection[] = SECTION_META.flatMap(
  (s): ManageSection[] => {
    const found: ManageSection | undefined =
      SECTIONS.find((t) => t.id === s.id) ?? PANE_SECTIONS.find((p) => p.id === s.id)
    return found === undefined ? [] : [found]
  },
)
