import {
  type SectionBody,
  type SectionEnv,
  type SectionModel,
  sectionModel,
} from '@keith/app-model/manage'
import { Loader } from './loader.svelte.ts'

const EMPTY: SectionBody = { lines: [], rows: [], actions: [] }

/**
 * One table section: the shared model (`@keith/app-model/manage`) read through the client, its body built from what was read.
 * `reload` reads again (after an action, or by hand); a failed read keeps the last good rows and says why.
 */
export class SectionStore {
  readonly model: SectionModel<unknown> | undefined
  private readonly loader = new Loader<unknown>()
  private loaded = $state(false)
  body = $derived.by<SectionBody>(() => {
    if (this.model === undefined) return EMPTY
    return this.model.build(this.loaded ? this.loader.data : undefined)
  })
  error = $derived(this.loader.error)
  loading = $derived(this.loader.loading)

  constructor(id: string, env: SectionEnv) {
    this.model = sectionModel(id, env)
  }

  async reload(): Promise<void> {
    const model = this.model
    if (model === undefined) return
    await this.loader.run(() => model.load())
    if (this.loader.error === undefined) this.loaded = true
  }
}
