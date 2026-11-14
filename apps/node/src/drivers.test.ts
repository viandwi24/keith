import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareDrivers } from './drivers.ts'
import { type DriverEntry, driverFingerprint } from './platform/config.ts'
import { silentLogger } from './platform/logger.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'keith-node-drivers-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A driver folder with two capabilities; `offered` returns the ids given (undefined: no offered hook). */
async function writeGizmo(name: string, offered: string[] | undefined): Promise<DriverEntry> {
  const dir = join(root, name)
  await mkdir(join(dir, 'dist'), { recursive: true })
  await writeFile(
    join(dir, 'keith-driver.json'),
    JSON.stringify({
      manifestVersion: 1,
      name,
      version: '0.1.0',
      entry: 'dist/index.js',
      capabilities: [
        { id: `${name}.a`, schemaVersion: 1 },
        { id: `${name}.b`, schemaVersion: 1 },
      ],
      platforms: [process.platform],
      needs: [],
    }),
  )
  const all = `[{ id: '${name}.a', schemaVersion: 1 }, { id: '${name}.b', schemaVersion: 1 }]`
  const offeredLine =
    offered === undefined
      ? ''
      : `offered: () => [${offered.map((id) => `{ id: '${id}', schemaVersion: 1 }`).join(', ')}],`
  await writeFile(
    join(dir, 'dist', 'index.js'),
    `export default { name: '${name}', version: '0.1.0', capabilities: ${all}, ${offeredLine} invoke: () => ({ ok: true, output: null }) }\n`,
  )
  return { name, source: 'path', path: dir, sha256: await driverFingerprint(dir), options: {} }
}

const prepare = (entries: DriverEntry[]) =>
  prepareDrivers(entries, { workdir: join(root, 'work'), logger: silentLogger })

describe('prepareDrivers announces what a driver offers', () => {
  test('without an offered hook every capability of the driver is announced', async () => {
    const entry = await writeGizmo('gizmo', undefined)
    const { announced } = await prepare([entry])
    expect(announced[0]?.capabilities.map((c) => c.id)).toEqual(['gizmo.a', 'gizmo.b'])
  })

  test('a driver announces only the capabilities its offered hook returns', async () => {
    const entry = await writeGizmo('gizmo', ['gizmo.a'])
    const { announced, runnable, left } = await prepare([entry])
    expect(announced[0]?.capabilities.map((c) => c.id)).toEqual(['gizmo.a'])
    expect(runnable).toHaveLength(1)
    expect(left).toEqual([])
  })

  test('a driver that offers nothing is left out with its reason; the rest run', async () => {
    const none = await writeGizmo('nothing', [])
    const one = await writeGizmo('gizmo', ['gizmo.b'])
    const { announced, left } = await prepare([none, one])
    expect(announced.map((d) => d.name)).toEqual(['gizmo'])
    expect(left).toEqual([{ name: 'nothing', message: 'offers no capability with these options' }])
  })
})
