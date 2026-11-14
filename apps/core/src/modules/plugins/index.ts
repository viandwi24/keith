// Plugins in core: the adapter to eharness, the loader and the people directory of the guard
// (docs/specs/plugins.md, ADR-0016).

export { createAccessPort, createPluginAclAudit } from './access-port.ts'
export { compilePlugin, DANGEROUS_REASON, sessionFactsOf } from './adapter.ts'
export {
  createPluginAdmin,
  type PluginAdmin,
  type PluginAdminDeps,
  PluginAdminError,
  pluginEnabledKey,
} from './admin.ts'
export { BUILTIN_PLUGINS } from './builtin.ts'
export { createPeopleDirectory, type PeopleDirectoryOptions } from './directory.ts'
export { createPluginFeed, EVERYONE } from './feed.ts'
export {
  createPluginHost,
  type PluginHost,
  type PluginHostDeps,
  type PluginState,
  type PluginStatus,
} from './host.ts'
export {
  createPluginRoutes,
  PLUGIN_BODY_MAX_BYTES,
  type PluginRequestContext,
  type PluginRoutes,
} from './http.ts'
export { pluginProcedures, reviewProcedures } from './procedures.ts'
export {
  createReviewService,
  DEFAULT_REVIEW_EXPIRY_DAYS,
  DEFAULT_REVIEW_MAX_PENDING,
  REVIEW_EXPIRY_KEY,
  REVIEW_MAX_PENDING_KEY,
  type ReviewCaller,
  ReviewError,
  type ReviewService,
} from './reviews.ts'
export {
  createScheduleService,
  nextCron,
  pluginScope,
  type ScheduleService,
  type ScheduleServiceOptions,
} from './schedule.ts'
export { createViewAudit, type ViewAudit, type ViewAuditEvent } from './view-audit.ts'
export {
  chunkFrame,
  createViewGateway,
  VIEW_MESSAGE_MAX_BYTES,
  type ViewGateway,
  type ViewGatewayOptions,
  type ViewSocketData,
} from './view-socket.ts'
export { createWake, type WakeOptions } from './wake.ts'
