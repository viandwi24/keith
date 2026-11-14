// A driver folder for tests. Its entry imports nothing (a temp folder has no node_modules), so it is plain data.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface FakeDriverOptions {
  /** `start` throws, so the driver must be left out of the announcement. */
  throwAtStart?: boolean
}

/** Writes `keith-driver.json` and `dist/index.js` for a driver named `name` on this platform. */
export async function writeFakeDriver(
  dir: string,
  name: string,
  options: FakeDriverOptions = {},
): Promise<void> {
  await mkdir(join(dir, 'dist'), { recursive: true })
  await writeFile(
    join(dir, 'keith-driver.json'),
    JSON.stringify({
      manifestVersion: 1,
      name,
      version: '0.1.0',
      entry: 'dist/index.js',
      capabilities: [{ id: `${name}.ping`, schemaVersion: 1 }],
      platforms: [process.platform],
      needs: [],
    }),
  )
  const start = options.throwAtStart ? "start() { throw new Error('boom') }," : ''
  await writeFile(
    join(dir, 'dist', 'index.js'),
    `export default {\n  name: '${name}',\n  version: '0.1.0',\n  capabilities: [{ id: '${name}.ping', schemaVersion: 1 }],\n  ${start}\n  invoke: () => ({ ok: true, output: 'pong' }),\n}\n`,
  )
}
