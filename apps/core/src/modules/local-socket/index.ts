// Local socket: core's owner-only Unix socket (docs/specs/thalamus.md, core-cli.md).
export {
  CoreAlreadyRunning,
  type LocalListener,
  type LocalListenOptions,
  listenLocal,
  probeSocket,
} from './listen.ts'
export { SOCKET_PATH_FILE, SOCKET_PATH_LIMIT, socketPathFor } from './path.ts'
