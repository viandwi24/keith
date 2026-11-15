// Providers: the model provider registry, connections and model per role (docs/specs/providers.md).

export {
  createModelToolsPlugin,
  MODEL_ROLE_SET_TOOL,
  MODEL_ROLES_GET_TOOL,
  MODEL_TOOLS_PLUGIN,
  type ModelToolsDeps,
  modelToolsOf,
} from './model-tools.ts'
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
