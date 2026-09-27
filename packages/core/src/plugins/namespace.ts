import { KeithError, PLUGIN_NAMESPACE_PATTERN, RESERVED_NAMESPACES } from '@keith/sdk'

const RESERVED: ReadonlySet<string> = new Set(RESERVED_NAMESPACES)

export function isReservedNamespace(namespace: string): boolean {
  return RESERVED.has(namespace)
}

/** Throws `PLUGIN_NAMESPACE_INVALID` unless `namespace` is well-formed and not reserved. */
export function assertPluginNamespace(namespace: string, pluginId: string): void {
  if (!PLUGIN_NAMESPACE_PATTERN.test(namespace)) {
    throw new KeithError(
      'PLUGIN_NAMESPACE_INVALID',
      `plugin ${pluginId} has an invalid namespace '${namespace}': use lowercase letters, digits and single underscores`,
      { details: { pluginId, namespace } },
    )
  }
  if (isReservedNamespace(namespace)) {
    throw new KeithError(
      'PLUGIN_NAMESPACE_INVALID',
      `plugin ${pluginId} uses the reserved namespace '${namespace}'`,
      {
        details: { pluginId, namespace },
      },
    )
  }
}

/** Throws `PLUGIN_NAMESPACE_INVALID` unless `name` starts with `<namespace>.`. */
export function assertInNamespace(name: string, namespace: string, what: string, pluginId: string): void {
  if (!name.startsWith(`${namespace}.`) || name.length === namespace.length + 1) {
    throw new KeithError(
      'PLUGIN_NAMESPACE_INVALID',
      `${what} '${name}' of plugin ${pluginId} must start with '${namespace}.'`,
      { details: { pluginId, namespace, name } },
    )
  }
}

/** The first dot-separated segment of a name. */
export function namespaceOf(name: string): string {
  const dot = name.indexOf('.')
  return dot === -1 ? name : name.slice(0, dot)
}
