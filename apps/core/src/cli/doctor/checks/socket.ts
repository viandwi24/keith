import { probeSocket, socketPathFor } from '../../../modules/local-socket/index.ts'
import type { DoctorCheck } from '../types.ts'

/** Whether a core answers on the local socket. */
export const socketCheck: DoctorCheck = async ({ config }) => {
  const socketPath = socketPathFor(config.dataDir)
  return [
    (await probeSocket(socketPath))
      ? { level: 'ok', name: 'socket', hint: `core answers on ${socketPath}` }
      : { level: 'warn', name: 'socket', hint: 'core is not running: keith-core start' },
  ]
}
