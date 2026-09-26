# Plugin API v1

Exported from `@keith/sdk`. The model behind it is in [architecture/plugin-system.md](../architecture/plugin-system.md).

## `definePlugin`

```ts
import { definePlugin } from '@keith/sdk'
import { z } from 'zod'

export default definePlugin({
  id: '@keith/tool-weather',          // = npm package name
  namespace: 'weather',               // scopes tools, events, routes, ws frames (see plugin-system.md#namespace)
  version: '0.1.0',
  kind: 'tool',                       // 'infra' | 'provider' | 'tool' | 'client-app'
  config: z.object({ apiKey: z.string(), units: z.enum(['metric', 'imperial']).default('metric') }),
  needs: [],                          // service names that must exist at start
  setup(ctx) { /* register only */ },
  async start(ctx) { /* may use services */ },
  async stop(ctx) { /* cleanup */ },
})
```

`definePlugin` is an identity function that gives type inference: `ctx.config` is typed from `config`.

## `PluginContext`

```ts
interface PluginContext<TConfig> {
  plugin: { id: string; namespace: string; version: string; kind: PluginKind }
  config: TConfig
  log: Logger                                  // structured; child logger tagged with plugin id
  events: EventBus
  services: ServiceRegistry
  tools: ToolRegistry                          // kind: tool
  skills: SkillRegistry                        // kind: tool
  agents: AgentRegistry                        // kind: tool
  providers: ProviderRegistries                // kind: provider
  http: HttpRegistry                           // kind: infra, client-app
  ws: WsRegistry                               // kind: infra, client-app
  deliveries: DeliverySink                     // kind: tool, client-app
  data: PluginDataStore                        // every kind (services and events too)
  paths: { data: string }                      // ~/.keith/plugins/<id>/
  clock: Clock                                 // injectable for tests
}

interface Logger { debug(msg: string, f?: object): void; info(…): void; warn(…): void; error(…): void; child(f: object): Logger }
interface Clock  { now(): number }
```

Using a registry your kind may not use throws `KeithError('PLUGIN_KIND_VIOLATION')`.

## Services

```ts
interface ServiceMap {}                        // extended by declaration merging

interface ServiceRegistry {
  provide<K extends keyof ServiceMap>(name: K, impl: ServiceMap[K]): void   // setup only
  get<K extends keyof ServiceMap>(name: K): ServiceMap[K]                   // start or later; throws SERVICE_MISSING
  find<K extends keyof ServiceMap>(name: K): ServiceMap[K] | undefined
}
```

Providing a name twice throws `SERVICE_CONFLICT`, unless config picks a winner: `[services] weather = "@keith/tool-weather"`.

## Events

```ts
interface EventBus {
  on<N extends keyof EventMap>(name: N, handler: (e: { name: N; at: number; data: EventMap[N] }) => void | Promise<void>): Unsubscribe
  emit<N extends keyof EventMap>(name: N, data: EventMap[N]): void     // own namespace only (every kind may emit)
  define(name: string, schema: ZodType): void                           // setup only
}
interface EventMap extends CoreEventMap {}      // plugins extend by declaration merging
```

## Tools

```ts
import { defineTool } from '@keith/sdk'

export const currentWeather = defineTool({
  name: 'weather.current',                    // <namespace>.<verb_or_noun>, unique
  description: 'Current weather for a city. Use when the person asks about weather now.',
  input: z.object({ city: z.string() }),
  minTier: 'member',                          // 'owner' | 'member' | 'guest'
  requires: [],                               // node capabilities, e.g. ['fs@1'] (phase 7)
  timeoutMs: 20_000,
  async run(input, t): Promise<ToolResult> {
    const w = await fetchWeather(input.city, t.signal)
    return { content: `${w.tempC}°C, ${w.summary}`, ui: { type: 'card', id: 'w1', title: input.city, body: `${w.tempC}°C` } }
  },
  async onAction(action, t) { /* optional: handle ui.action from this tool's blocks */ },
})

interface ToolRunContext {
  person: PersonDto                            // the person the call acts for (or the addressed person in a group)
  participants: PersonDto[]                    // everyone the context was built for; minTier is checked against the lowest tier here
  threadId: string | null                      // null inside tasks with no thread
  taskId: string | null
  signal: AbortSignal
  log: Logger
  services: Pick<ServiceRegistry, 'get' | 'find'>
}

interface ToolResult {
  content: string                              // what the model sees; keep it short and factual
  ui?: UiBlock                                 // what humans see (validated; see ui-blocks.md)
  fallbackText?: string                        // text for nodes that can't render `ui`; derived from the block if absent
  error?: boolean                              // true = content describes a failure
}

interface ToolRegistry { register(tool: Tool): void }   // the core also has a privileged registerBuiltin() for reserved namespaces
```

Tool names must match `/^[a-z][a-z0-9]*(_[a-z0-9]+)*(\.[a-z][a-z0-9]*(_[a-z0-9]+)*)+$/` (lowercase, dot-separated segments, single underscores only) and start with the plugin's `namespace` followed by a dot. Reserved namespaces (see [plugin-system.md](../architecture/plugin-system.md#namespace)) are for built-ins only. Some providers disallow `.` in function names, so adapters map names reversibly (e.g. `.` ↔ `__`).

## Skills

```ts
import { defineSkill } from '@keith/sdk'
export const morningBrief = defineSkill({
  name: 'morning_briefing',
  description: 'How to give a concise morning briefing on arrival.',
  instructions: () => Bun.file(new URL('./morning.md', import.meta.url)).text(),
})
interface SkillRegistry { register(skill: Skill): void }
```

Only `name` + `description` go into every context (the skills index). The model loads `instructions` with `skill.load`.

## Agents

```ts
import { defineAgent } from '@keith/sdk'
export const researcher = defineAgent({
  id: 'researcher',
  description: 'Researches a topic using web tools and returns a sourced summary.',
  system: 'You are Keith working in the background as a researcher…',
  tools: ['web.search', 'web.fetch', 'memory.recall'],   // tool names; missing tools are skipped with a warning
  modelRole: 'background',
})
interface AgentRegistry { register(agent: Agent): void }
```

The built-in agent `general` always exists: every non-reserved registry tool the Person may use, plus `memory.recall`, `memory.remember` and `skill.load`, on the background role.

## Providers

```ts
interface ProviderRegistries {
  llm: { register(p: LlmProvider): void }
  stt: { register(p: SttProvider): void }      // phase 3
  tts: { register(p: TtsProvider): void }      // phase 3
  vad: { register(p: VadProvider): void }      // phase 3
}
```

Interfaces: [providers.md](providers.md).

## HTTP and WS (infra, client-app)

```ts
interface HttpRegistry {
  route(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, handler: HttpHandler, opts?: { auth?: 'none' | 'bearer' }): void
  static(mountPath: string, dir: string, opts?: { spaFallback?: string }): void
}
type HttpHandler = (req: Request, c: { person: PersonDto | null; params: Record<string, string> }) => Response | Promise<Response>

interface WsRegistry {
  // extra frame types, which must start with '<namespace>.', e.g. 'telegram.linked'
  handle(type: string, schema: ZodType, handler: (data: unknown, c: { nodeId: string; person: PersonDto | null }) => void | Promise<void>): void
}
```

- Plugin routes are mounted under `/p/<namespace>/…`, except `static` with `mountPath: '/'`, which only `client-app` plugins may use. Only one plugin may own `/`.
- `/v1/*` is reserved for the core.
- A client app's browser side must use the **public** `/v1` protocol for everything the TUI can also do (I-8). Plugin routes are for things only that client app needs (e.g. serving assets, OAuth callbacks).

## Deliveries

```ts
interface DeliverySink {
  enqueue(d: { personId: string; text: string; urgency?: 'low' | 'normal' | 'high' | 'critical'; ui?: UiBlock; threadId?: string }): Promise<{ deliveryId: string }>
}
```

Goes to the Person's `main` thread unless `threadId` is given. The source is recorded as the plugin id.

## Plugin data

```ts
interface PluginDataStore {
  get<T = unknown>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>     // JSON-serializable
  delete(key: string): Promise<void>
  list(prefix?: string): Promise<string[]>
}
```

## Errors

Throw `new KeithError(code, message, { cause })`. The central code list lives in `@keith/sdk` (`errors.ts`). New codes are added there (an additive contract change).

| Group | Codes |
|---|---|
| Plugin host | `PLUGIN_KIND_VIOLATION`, `PLUGIN_NAMESPACE_INVALID`, `SERVICE_MISSING`, `SERVICE_CONFLICT`, `CONFIG_INVALID`, `TOOL_NAME_INVALID`, `TOOL_NAME_TAKEN`, `ROUTE_CONFLICT` |
| Tools | `TOOL_INPUT_INVALID`, `TOOL_TIMEOUT`, `TIER_INSUFFICIENT`, `TASK_LIMIT_REACHED` |
| Core | `STORAGE_CORRUPT`, `NOT_FOUND`, `UNAUTHORIZED`, `FORBIDDEN`, `PROVIDER_ERROR`, `INTERNAL` |
