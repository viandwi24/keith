import { nodesSection } from '@keith/app-model/manage'
import type { ManageEnv, SectionData } from '../manage-types.ts'
import { sectionEnvOf } from '../use-section-model.ts'

/** Nodes: the app's live registry (the model builds the rows from it), with pair and revoke for a `nodes.manage` holder. */
export function useNodesSection(env: ManageEnv): SectionData {
  const body = nodesSection(sectionEnvOf(env)).build(undefined)
  return { ...body, error: env.nodes.error, loading: false, reload: env.nodes.reload }
}
