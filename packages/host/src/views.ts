// `@keith/host/views`: the core's side of plugin terminal views (docs/specs/plugin-views.md). Plugins never import it:
// they import `@keith/host/tui`.

export {
  createViewAccess,
  type ViewAccess,
  type ViewEntry,
  viewEntries,
} from './tui/view-access.ts'
export {
  createViewHost,
  type OpenViewRequest,
  type OpenViewResult,
  type ViewHandle,
  type ViewHost,
  type ViewHostDeps,
  type ViewHostLimits,
  type ViewListeners,
} from './tui/view-host.tsx'
export {
  createViewKeith,
  type ViewEventsOptions,
  type ViewEventsPort,
  type Viewer,
} from './tui/view-keith.ts'
