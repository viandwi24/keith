import {
  createViewHost,
  createViewKeith,
  type ViewHost,
  type ViewHostLimits,
} from '@keith/host/views'
import type { Server, WebSocketHandler } from 'bun'
import type { ActivityStore } from 'eharness/activity'
import type { Audit } from './modules/audit/index.ts'
import type { LocalAccess, PrincipalResolver, Via } from './modules/auth/index.ts'
import type { NodeSocketData } from './modules/nodes/index.ts'
import {
  createViewAudit,
  createViewGateway,
  type PluginHost,
  type ViewGateway,
  type ViewSocketData,
} from './modules/plugins/index.ts'
import type { Logger } from './platform/logger.ts'
import { createViewEvents } from './view-events.ts'

/** What Bun keeps per socket: a node connection or a plugin view. */
export type SocketData = NodeSocketData | ViewSocketData

/** Test only: shorter limits so a test need not wait ten minutes for an idle teardown. */
export interface ViewLimitsForTests {
  limits?: Partial<ViewHostLimits>
  opensPerWindow?: { max: number; windowMs: number }
  auditMax?: number
}

/** The URL of the view socket (docs/specs/plugin-views.md). */
export const VIEW_SOCKET_PATH = '/plugins/views/ws'

/**
 * Plugin terminal views over WebSocket: the view host over the plugin host's guard, and the gateway that
 * authenticates an upgrade with the same bearer resolution as HTTP. Only a person's credential reaches it: a guest has
 * no credential on this listener, and `ViewAccess` refuses a guest actor anyway.
 */
export function createViews(options: {
  host: PluginHost
  /** Resolves a bearer; with `local` it also answers the socket's implicit owner (the same resolver as HTTP). */
  principals: PrincipalResolver
  /** The local socket's lock and trust: a locked socket gets no view, and a view key is the owner's activity. */
  local?: Pick<LocalAccess, 'mode' | 'activity'>
  /** The audit log: `plugin.view.open` and `plugin.view.close` rows (rate limited per person). */
  audit?: Audit
  tuning?: ViewLimitsForTests
  /** The activity log: `useKeith().events` reads the plugin records of it (view-events.ts). */
  activity?: ActivityStore
  logger: Logger
  /** The Host and Origin origin of requests; only the URL of a re-check request is built from it. */
  origin?: string
}): { gateway: ViewGateway; views: ViewHost } {
  const { host, logger } = options
  const events =
    options.activity === undefined
      ? undefined
      : createViewEvents({
          store: options.activity,
          warn: (message) => logger.warn(message),
        })
  const views = createViewHost({
    access: host.views,
    keith: viewKeith(
      createViewKeith({
        guard: host.guard,
        plugins: () => host.loaded(),
        ...(events === undefined ? {} : { events }),
      }),
    ),
    log: { warn: (message) => logger.warn(`views: ${message}`) },
    ...(options.tuning?.limits === undefined ? {} : { limits: options.tuning.limits }),
  })
  const viewAudit =
    options.audit === undefined
      ? undefined
      : createViewAudit({
          record: (event) => options.audit?.record(event),
          ...(options.tuning?.auditMax === undefined ? {} : { max: options.tuning.auditMax }),
        })
  const gateway = createViewGateway({
    views,
    ...(viewAudit === undefined ? {} : { audit: viewAudit }),
    ...(options.tuning?.opensPerWindow === undefined
      ? {}
      : { opensPerWindow: options.tuning.opensPerWindow }),
    access: host.views,
    warn: (message) => logger.warn(message),
    async authenticate(request, ip, via: Via) {
      const local = via === 'local' ? options.local : undefined
      // a locked socket serves nothing (423); the app's middleware says so for HTTP, the route for the upgrade
      if (via === 'local' && local?.mode() === 'locked') return undefined
      const principal = await options.principals.resolve(request, via, ip)
      if (principal === undefined) return undefined
      const authorization = request.headers.get('authorization')
      return {
        principalId: principal.personId,
        method: principal.credential?.methods?.[0] ?? null,
        // a fresh Request each time: the resolver caches per Request object, and this must read the database now.
        // The socket's implicit owner has no header: it stays allowed until the socket locks or its trust is `none`.
        stillAllowed: async () => {
          if (via === 'local' && local?.mode() === 'locked') return false
          const headers = authorization === null ? {} : { authorization }
          return (
            (await options.principals.resolve(new Request(request.url, { headers }), via, ip)) !==
            undefined
          )
        },
        ...(local === undefined ? {} : { activity: () => local.activity() }),
      }
    },
  })
  return { gateway, views }
}

/**
 * A view listens to its own plugin only: `events('other.x')` from `notes.list` is a no-op (the plugin id is the part before
 * the first dot of the view id). Each subscription ends with the view: the view's abort signal removes it, so a view
 * that closes with a listener still on keeps nothing behind (the poller stops with the last listener).
 */
export function viewKeith(
  make: ReturnType<typeof createViewKeith>,
): ReturnType<typeof createViewKeith> {
  return (viewer, viewId, signal) => {
    const keith = make(viewer, viewId, signal)
    const own = viewId.slice(0, viewId.indexOf('.'))
    return {
      ...keith,
      events(target, handler, options) {
        const dot = target.indexOf('.')
        if (dot < 1 || target.slice(0, dot) !== own) return () => {}
        const off = keith.events(target, handler, options)
        const stop = (): void => {
          signal.removeEventListener('abort', stop)
          off()
        }
        if (signal.aborted) stop()
        else signal.addEventListener('abort', stop)
        return () => {
          signal.removeEventListener('abort', stop)
          off()
        }
      },
    }
  }
}

/**
 * The one `websocket` object of `Bun.serve`: it hands every event to the handler that owns the socket, keyed by
 * `ws.data.kind` (`view`, else the node gateway). Neither handler knows about the other.
 */
export function dispatchSockets(
  nodes: WebSocketHandler<NodeSocketData>,
  views: WebSocketHandler<ViewSocketData>,
): WebSocketHandler<SocketData> {
  const pick = (ws: { data: SocketData }) =>
    (ws.data.kind === 'view' ? views : nodes) as WebSocketHandler<SocketData>
  return {
    // the larger limit of the two; the view gateway checks its own (64 KiB) per message
    maxPayloadLength: nodes.maxPayloadLength ?? 4 * 1024 * 1024,
    open: (ws) => pick(ws).open?.(ws),
    message: (ws, message) => pick(ws).message?.(ws, message),
    close: (ws, code, reason) => pick(ws).close?.(ws, code, reason),
    drain: (ws) => pick(ws).drain?.(ws),
  }
}

export type SocketServer = Server<SocketData>
