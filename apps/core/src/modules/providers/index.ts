// Providers: the model provider registry, connections and model per role (docs/specs/providers.md).
export { resolveRoleModel, roleModel } from './role-model.ts'
export { providerProcedures } from './router.ts'
export {
  createProviderService,
  OPENROUTER_DEFAULTS,
  PROVIDER_DEFAULTS,
  type ProviderService,
  type ProviderServiceOptions,
} from './service.ts'
export {
  INFERENCE_THINKING,
  NO_THINKING_CALLS,
  type ThinkingCall,
  thinkingFor,
  withThinking,
} from './thinking.ts'
export { noModelMessage, unconfiguredModel } from './unconfigured-model.ts'
export { createUnreadableKeys, type UnreadableKeys } from './unreadable.ts'
