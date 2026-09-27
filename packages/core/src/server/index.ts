// server/: HTTP + WS server, auth, node handshake, attachments and presence (task P1-C1).
// Bootstrap constructs the attachment registry and presence first (step 4), then the server
// (step 9), and calls `listen()` last (step 12).

export {
  type AttachmentRegistryDeps,
  createAttachmentRegistry,
  type FrameOutlet,
  type ServerAttachmentRegistry,
} from './attachments.ts'
export { type ConnectionTiming, DEFAULT_TIMING } from './connection.ts'
export { createPresence, type PresenceDeps, type ServerPresence } from './presence.ts'
export { type CoreServerDeps, createCoreServer } from './server.ts'
