import { accessSection } from './access-section.ts'
import { auditSection } from './audit-section.ts'
import { budgetSection } from './budget-section.ts'
import { devicesSection } from './devices-section.ts'
import { groupsSection } from './groups-section.ts'
import { nodesSection } from './nodes-section.ts'
import { overviewSection } from './overview-section.ts'
import { peopleSection } from './people-section.ts'
import { personaSection } from './persona-section.ts'
import { pluginsSection } from './plugins-section.ts'
import { privacySection } from './privacy-section.ts'
import { protocolsSection } from './protocols-section.ts'
import { providersSection } from './providers-section.ts'
import { reviewsSection } from './reviews-section.ts'
import { successionSection } from './succession-section.ts'
import type { SectionEnv, SectionId, SectionModel, SectionRead } from './types.ts'

/** One Manage section as the list names it: its id, title and the capabilities that show it. */
export interface SectionMeta {
  id: SectionId
  title: string
  /** The section shows when the person has any of these (`authenticated`: always). */
  read: SectionRead
}

/** Every section in the order of the list (Logs is a pane in both clients, so it has no model). `visibleSections` keeps the ones a role may read. */
export const SECTION_META: readonly SectionMeta[] = [
  { id: 'overview', title: 'Overview', read: ['authenticated'] },
  { id: 'people', title: 'People', read: ['people.manage'] },
  { id: 'groups', title: 'Groups', read: ['groups.manage'] },
  { id: 'plugins', title: 'Plugins', read: ['plugins.manage'] },
  { id: 'reviews', title: 'Reviews', read: ['reviews.decide'] },
  { id: 'protocols', title: 'Protocols', read: ['chat'] },
  { id: 'devices', title: 'Devices & tokens', read: ['devices.manage', 'tokens.manage'] },
  { id: 'nodes', title: 'Nodes', read: ['nodes.read'] },
  { id: 'providers', title: 'Providers & models', read: ['settings.read'] },
  { id: 'persona', title: 'Persona', read: ['settings.manage'] },
  { id: 'access', title: 'Access', read: ['settings.manage'] },
  { id: 'succession', title: 'Succession', read: ['succession.manage'] },
  { id: 'budget', title: 'Budget', read: ['budget.read'] },
  { id: 'logs', title: 'Logs', read: ['logs.mine'] },
  { id: 'privacy', title: 'Privacy', read: ['audit.mine'] },
  { id: 'audit', title: 'Audit', read: ['audit.read'] },
]

type ModelOf = (env: SectionEnv) => SectionModel<never> | SectionModel<unknown>

const MODELS: Partial<Record<SectionId, ModelOf>> = {
  overview: overviewSection,
  people: peopleSection,
  groups: groupsSection,
  plugins: pluginsSection,
  reviews: reviewsSection,
  protocols: protocolsSection,
  devices: devicesSection,
  nodes: nodesSection,
  providers: providersSection,
  persona: personaSection,
  access: accessSection,
  succession: successionSection,
  budget: budgetSection,
  privacy: privacySection,
  audit: auditSection,
}

/** The table-section ids (every section but Logs). */
export const isTableSection = (id: string): id is SectionId =>
  Object.hasOwn(MODELS, id) && MODELS[id as SectionId] !== undefined

/** The model of a table section (read, then build); `undefined` for Logs or an unknown id. */
export function sectionModel(id: string, env: SectionEnv): SectionModel<unknown> | undefined {
  if (!isTableSection(id)) return undefined
  return MODELS[id]?.(env) as SectionModel<unknown> | undefined
}
