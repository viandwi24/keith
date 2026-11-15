// The routes of plugin views. A view id is `<plugin>.<view>`; the page route is `/apps/<plugin>/<view>` because the core reads a
// dot in the last path segment as a file name (a missing file is a 404, never the shell).

/** The path (under the app base) of a view id. */
export const viewRoute = (viewId: string): string => {
  const [plugin = '', view = ''] = viewId.split('.')
  return `/apps/${encodeURIComponent(plugin)}/${encodeURIComponent(view)}`
}

/** The view id of a path made by `viewRoute`, or `undefined` for any other path. */
export function viewIdOfRoute(path: string): string | undefined {
  const m = /^\/apps\/([a-z0-9_-]+)\/([a-z0-9_-]+)$/.exec(path)
  return m === null ? undefined : `${m[1]}.${m[2]}`
}
