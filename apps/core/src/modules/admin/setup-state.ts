import type { SettingsRepo, TokensRepo } from '@keith/db'
import { SETTING } from './network.ts'

/** Whether `keith-core setup` has completed on this data folder. */
export function isSetUp(settings: SettingsRepo): boolean {
  return settings.get<boolean>(SETTING.setupDone) === true
}

/** The owner's display name, or undefined before setup chose one. */
export function ownerName(tokens: TokensRepo, settings: SettingsRepo): string | undefined {
  return isSetUp(settings) ? tokens.owner()?.name : undefined
}
