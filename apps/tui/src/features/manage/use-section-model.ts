import {
  type SectionData,
  type SectionEnv,
  type SectionModel,
  sectionModel,
} from '@keith/app-model/manage'
import type { ManageEnv, SectionDef } from './manage-types.ts'
import { useLoad } from './use-load.ts'

/** What the shared section models read: the client, the person and the live node registry. */
export const sectionEnvOf = (env: ManageEnv): SectionEnv => ({
  client: env.client,
  me: env.me,
  caps: env.caps,
  nodes: env.nodes.nodes,
})

/** A table section as a hook: read what the model asks for (again on `reload`), build the rows from it. */
export function useSectionModel<D>(model: SectionModel<D>): SectionData {
  const loaded = useLoad(() => model.load())
  return {
    ...model.build(loaded.data),
    error: loaded.error,
    loading: loaded.loading,
    reload: loaded.reload,
  }
}

/** The `use` of a section whose model lives in `@keith/app-model/manage`. */
export const useModelOf =
  (id: SectionDef['id']): SectionDef['use'] =>
  (env) => {
    const model = sectionModel(id, sectionEnvOf(env))
    if (model === undefined) throw new Error(`section ${id} has no model`)
    return useSectionModel(model)
  }
