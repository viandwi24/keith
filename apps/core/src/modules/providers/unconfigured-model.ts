import type { ModelRole } from '@keith/contracts'
import type { LanguageModel } from 'ai'
import { HarnessError } from 'eharness'

type ModelObject = Extract<LanguageModel, { specificationVersion: 'v4' }>

export const noModelMessage = (role: ModelRole): string =>
  `No model for the ${role} role yet. Run /connect to add a provider connection, then /model to pick a model.`

/**
 * A local model that fails every call with a readable message. It stands in while no model is
 * configured, so a turn never falls back to a network default (a model id string would go to the
 * AI Gateway).
 */
export function unconfiguredModel(role: ModelRole): ModelObject {
  const fail = () => Promise.reject(new HarnessError('EH_CONFIG_INVALID', noModelMessage(role)))
  return {
    specificationVersion: 'v4',
    provider: 'keith',
    modelId: `unconfigured-${role}`,
    supportedUrls: {},
    doGenerate: fail,
    doStream: fail,
  }
}
