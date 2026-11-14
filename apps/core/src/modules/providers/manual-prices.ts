// Manual model prices (ADR-0027 §23): the owner's price per model, kept in the settings repo and laid
// over the catalog, so eharness sees an ordinary `ModelInfo.pricing` and the budget counts the spend.
import type { ModelPrice } from '@keith/contracts'
import type { SettingsRepo } from '@keith/db'
import type { LanguageModel } from 'ai'
import type { ModelInfo } from 'eharness'

/** The settings key: a JSON map of model ref to its two prices. */
export const PRICES_KEY = 'models.prices'

type StoredPrice = Omit<ModelPrice, 'ref'>

export interface ManualPrices {
  list(): ModelPrice[]
  get(ref: string): ModelPrice | undefined
  set(price: ModelPrice): void
  /** False when there was no manual price for the ref. */
  clear(ref: string): boolean
}

export function manualPricesOf(settings: SettingsRepo): ManualPrices {
  const read = (): Record<string, StoredPrice> => {
    const value = settings.get<Record<string, StoredPrice>>(PRICES_KEY)
    return value !== null && typeof value === 'object' ? value : {}
  }
  return {
    list: () =>
      Object.entries(read())
        .map(([ref, p]) => ({ ref, ...p }))
        .sort((a, b) => a.ref.localeCompare(b.ref)),
    get(ref) {
      const p = read()[ref]
      return p === undefined ? undefined : { ref, ...p }
    },
    set({ ref, inputPerMTokUsd, outputPerMTokUsd }) {
      settings.set(PRICES_KEY, { ...read(), [ref]: { inputPerMTokUsd, outputPerMTokUsd } })
    },
    clear(ref) {
      const all = read()
      if (!(ref in all)) return false
      const { [ref]: _removed, ...rest } = all
      settings.set(PRICES_KEY, rest)
      return true
    },
  }
}

/** The catalog function of eharness: a model object to its info (undefined when unknown). */
export type CatalogFn = (model: LanguageModel) => ModelInfo | undefined

/**
 * The catalog with the manual prices laid over it. `refOf` names the connection-and-model ref of a
 * model object the service resolved; an unknown object keeps the catalog's answer.
 */
export function withManualPrices(
  base: CatalogFn,
  prices: ManualPrices,
  refOf: (model: LanguageModel) => string | undefined,
): CatalogFn {
  return (model) => {
    const ref = refOf(model)
    const manual = ref === undefined ? undefined : prices.get(ref)
    if (manual === undefined) return base(model)
    return {
      ...base(model),
      pricing: { input: manual.inputPerMTokUsd, output: manual.outputPerMTokUsd },
    }
  }
}
