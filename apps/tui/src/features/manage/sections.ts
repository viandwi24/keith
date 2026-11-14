import { usePersonaSection } from '../persona/index.ts'
import { useAccess } from './access/index.ts'
import { useAudit, useMyAudit } from './audit/index.ts'
import { useBudgetSection } from './budget/index.ts'
import { useDevices } from './devices/index.ts'
import { useGroups } from './groups/index.ts'
import { LogsPane } from './logs/index.ts'
import type { ManageSection, PaneSectionDef, SectionDef } from './manage-types.ts'
import { useNodesSection } from './nodes/index.ts'
import { useOverview } from './overview/index.ts'
import { usePeople } from './people/index.ts'
import { usePlugins } from './plugins/index.ts'
import { useProtocols } from './protocols/index.ts'
import { useProviders } from './providers/index.ts'
import { useReviews } from './reviews/index.ts'
import { useSuccession } from './succession/index.ts'

/** Every section in the order of the list; `visibleSections` keeps the ones a role may read. */
export const SECTIONS: readonly SectionDef[] = [
  { id: 'overview', title: 'Overview', read: ['authenticated'], use: useOverview },
  { id: 'people', title: 'People', read: ['people.manage'], use: usePeople },
  { id: 'groups', title: 'Groups', read: ['groups.manage'], use: useGroups },
  { id: 'plugins', title: 'Plugins', read: ['plugins.manage'], use: usePlugins },
  { id: 'reviews', title: 'Reviews', read: ['reviews.decide'], use: useReviews },
  { id: 'protocols', title: 'Protocols', read: ['chat'], use: useProtocols },
  {
    id: 'devices',
    title: 'Devices & tokens',
    read: ['devices.manage', 'tokens.manage'],
    use: useDevices,
  },
  { id: 'nodes', title: 'Nodes', read: ['nodes.read'], use: useNodesSection },
  { id: 'providers', title: 'Providers & models', read: ['settings.read'], use: useProviders },
  { id: 'persona', title: 'Persona', read: ['settings.manage'], use: usePersonaSection },
  { id: 'access', title: 'Access', read: ['settings.manage'], use: useAccess },
  {
    id: 'succession',
    title: 'Succession',
    read: ['succession.manage'],
    use: useSuccession,
  },
  { id: 'budget', title: 'Budget', read: ['budget.read'], use: useBudgetSection },
  { id: 'privacy', title: 'Privacy', read: ['audit.mine'], use: useMyAudit },
  { id: 'audit', title: 'Audit', read: ['audit.read'], use: useAudit },
]

/** The sections that draw their own pane (Logs: levels, a filter, a raw view); they are not row lists, so not in `SECTIONS`. */
const PANE_SECTIONS: readonly PaneSectionDef[] = [
  { id: 'logs', title: 'Logs', read: ['logs.mine'], pane: LogsPane },
]

/** Every section in the order of the list: a pane section sits before Privacy (budget, logs, privacy, audit). */
export const MANAGE_SECTIONS: readonly ManageSection[] = SECTIONS.flatMap((s) =>
  s.id === 'privacy' ? [...PANE_SECTIONS, s] : [s],
)
