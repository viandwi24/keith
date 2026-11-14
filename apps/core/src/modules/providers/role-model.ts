import type { ModelRole } from '@keith/contracts'
import type { LanguageModel } from 'ai'
import { definePlugin, type HarnessPlugin } from 'eharness'
import { routerSessionOptions } from './router-session.ts'
import type { ProviderService } from './service.ts'
import { type ThinkingCall, thinkingFor, withThinking } from './thinking.ts'
import { unconfiguredModel } from './unconfigured-model.ts'

/**
 * The model picked for `role` right now. Without a pick (or when resolving fails) it is
 * `unconfiguredModel`, which fails with a readable message instead of throwing here. A `call` names a call kind that may run
 * without DeepSeek thinking (`NO_THINKING_CALLS`, thinking.ts); other calls keep the provider default.
 */
export async function resolveRoleModel(
  role: ModelRole,
  providers: ProviderService,
  call?: ThinkingCall,
): Promise<LanguageModel> {
  const model = await providers.resolveRole(role).catch(() => unconfiguredModel(role))
  return withThinking(model, thinkingFor(call))
}

/**
 * Plugin: the agent's model is the one picked for `role`, read on every turn, so a new pick or
 * connection applies at the next turn without rebuilding the agent (ADR-0007). Without a pick the
 * turn runs on `unconfiguredModel`, which fails with a readable message (a hook that throws is
 * skipped by eharness, so the hook never throws). `call` is the call kind (thinking.ts). Each step on OpenRouter carries the
 * session's router id (router-session.ts), so the prompt cache stays on one upstream provider.
 */
export function roleModel(
  role: ModelRole,
  providers: ProviderService,
  call?: ThinkingCall,
): HarnessPlugin<'role-model'> {
  return definePlugin({
    name: 'role-model',
    setup: () => ({
      hooks: {
        'turn.prepare': async () => ({ model: await resolveRoleModel(role, providers, call) }),
        'step.prepare': (ctx, event) => {
          const providerOptions = routerSessionOptions(ctx.session.id, event.model)
          return providerOptions === undefined ? undefined : { providerOptions }
        },
      },
    }),
  })
}
