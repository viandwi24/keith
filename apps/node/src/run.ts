import { mkdir } from 'node:fs/promises'
import { type Clock, createConnection, type SocketFactory } from './connection.ts'
import { prepareDrivers } from './drivers.ts'
import { createExecutor } from './executor/index.ts'
import { buildManifest } from './manifest.ts'
import { type NodeConfig, saveConfig } from './platform/config.ts'
import type { Logger } from './platform/logger.ts'

export interface RunOptions {
  signal?: AbortSignal
  logger: Logger
  socketFactory?: SocketFactory
  clock?: Clock
  random?: () => number
  killGraceMs?: number
  /**
   * The config file. A token core rotates to is stored here; without it the node keeps its token
   * and never accepts a new one.
   */
  configPath?: string
}

/** `http(s)://host[/base]` to `ws(s)://host[/base]/nodes/ws`. */
export function wsUrl(core: string): string {
  const url = new URL(core)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/nodes/ws`
  return url.toString()
}

/**
 * Run the daemon until aborted (exit code 0), refused by core on welcome (exit code 1) or revoked
 * (exit code 3: a 4003 close, or a 401 at connect). A revoked node never retries.
 */
export async function runNode(config: NodeConfig, options: RunOptions): Promise<number> {
  const { logger, configPath } = options
  await mkdir(config.policy.workdir, { recursive: true })
  const prepared = await prepareDrivers(config.drivers, {
    workdir: config.policy.workdir,
    logger,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  let stored = config
  const persistToken = async (token: string): Promise<void> => {
    if (configPath === undefined) throw new Error('no config file to store the token in')
    const next = { ...stored, token }
    await saveConfig(configPath, next)
    stored = next
  }

  return new Promise<number>((resolve) => {
    const executor = createExecutor({
      policy: config.policy,
      drivers: prepared.runnable,
      unavailable: prepared.left,
      emit: (message) => {
        connection.send(message)
      },
      ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
    })

    const connection = createConnection({
      url: wsUrl(config.core),
      token: config.token,
      manifest: buildManifest(config.name, config.policy, prepared.announced),
      logger,
      ...(options.socketFactory ? { socketFactory: options.socketFactory } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.random ? { random: options.random } : {}),
      ...(configPath === undefined ? {} : { persistToken }),
      onState: (state) => logger.info(`state: ${state}`),
      onInvoke: (message) => {
        const epoch = connection.epoch
        logger.info(`invoke ${message.capability} (${message.callId})`)
        void executor.invoke(message).then((result) => {
          // A result for a call from an older socket has nobody waiting for it.
          if (connection.epoch === epoch) connection.send(result)
        })
      },
      onCancel: (message) => executor.cancel(message.callId),
      onDrop: () => executor.killAll(),
      onRefused: (reason) => {
        logger.error(`core refused this node: ${reason}`)
        resolve(1)
      },
      onRevoked: (reason) => {
        logger.error(
          `this node was revoked (${reason}): it stops; pair it again with keith-node join`,
        )
        resolve(3)
      },
    })

    const stop = (): void => {
      connection.stop()
      resolve(0)
    }
    if (options.signal?.aborted) return stop()
    options.signal?.addEventListener('abort', stop, { once: true })
    connection.start()
  })
}
