// Naming rules of plugins and operations (docs/specs/plugins.md, "Names").

/** A plugin id: kebab-case, 2 to 24 characters, starts with a letter. */
export const PLUGIN_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
export const PLUGIN_ID_MAX = 24
/** An operation name: snake_case words, at most 32 characters. */
export const OPERATION_NAME = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/
export const OPERATION_NAME_MAX = 32
/** A service id (`provides` and `requires`): `<plugin>.<name>` or a bare dotted lowercase name. */
export const SERVICE_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/
/** A capability id declared by a plugin: `<plugin-id>.<name>`. */
export const CAPABILITY_ID = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9_-]*$/
/** A version: `major.minor.patch`. */
export const VERSION = /^\d{1,4}\.\d{1,5}\.\d{1,6}$/

/**
 * Ids no plugin may take: eharness reserves `eh` and `app`; `acl` would make every tool of the plugin an
 * ACL-changing tool (`aclGuard` matches the `acl_` prefix); the rest are names of core tools and modules.
 */
export const RESERVED_PLUGIN_IDS: ReadonlySet<string> = new Set([
  'eh',
  'app',
  'acl',
  'agent',
  'keith',
  'plugins',
  'plugin',
  'nodes',
  'motor',
  'shell',
  'memory',
  'tasks',
  'task',
  'tool',
  'auth',
  'people',
  'reviews',
  'review',
])

/** The tool name the model sees: `<plugin>_<operation>` (at most 24 + 1 + 32 characters). */
export const toolNameOf = (pluginId: string, operation: string): string =>
  `${pluginId}_${operation}`

/** The path of an operation over HTTP, relative to the server root. */
export const routeOf = (pluginId: string, operation: string): string =>
  `/plugins/${pluginId}/${operation}`

/** The name of the eharness plugin the adapter compiles to. */
export const harnessNameOf = (pluginId: string): string => `k-${pluginId}`
