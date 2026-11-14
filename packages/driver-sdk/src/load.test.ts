import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DriverLoadError, loadDriver, readDriverManifest } from './load.ts'

const fixture = (name: string) => resolve(import.meta.dir, 'testing/fixtures', name)

async function loadError(dir: string, platform?: string): Promise<DriverLoadError> {
  try {
    await loadDriver(dir, platform === undefined ? {} : { platform })
  } catch (error) {
    if (error instanceof DriverLoadError) return error
    throw error
  }
  throw new Error(`expected ${dir} to be refused`)
}

describe('loadDriver', () => {
  test('loads a good fixture driver and returns its manifest and entry', async () => {
    const loaded = await loadDriver(fixture('good'), { platform: 'darwin' })
    expect(loaded.manifest.name).toBe('fixture')
    expect(loaded.entry).toBe(resolve(fixture('good'), 'index.ts'))
    const result = await loaded.driver.invoke(
      { callId: 'c1', capability: 'fixture.ping', schemaVersion: 1, input: 'hi', timeoutMs: 1000 },
      undefined as never,
    )
    expect(result).toEqual({ ok: true, output: { pong: 'hi' } })
  })

  test('refuses a folder without a manifest', async () => {
    expect((await loadError(fixture('missing-folder'))).code).toBe('manifest-missing')
  })

  test('refuses a manifest that is not JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'driver-sdk-'))
    await writeFile(join(dir, 'keith-driver.json'), '{ "manifestVersion": 1,')
    expect((await loadError(dir)).code).toBe('manifest-invalid')
  })

  test('refuses a bad manifest: a capability of another driver', async () => {
    const error = await loadError(fixture('bad-manifest'), 'darwin')
    expect(error.code).toBe('manifest-invalid')
    expect(error.message).toContain('must start with the driver name fixture')
  })

  test('refuses a platform the manifest does not list', async () => {
    const error = await loadError(fixture('good'), 'win32')
    expect(error.code).toBe('platform-unsupported')
    expect(error.message).toContain('not on win32')
  })

  test('refuses a missing entry', async () => {
    expect((await loadError(fixture('missing-entry'), 'darwin')).code).toBe('entry-missing')
  })

  test('refuses an entry that throws when imported', async () => {
    expect((await loadError(fixture('throws'), 'darwin')).code).toBe('entry-invalid')
  })

  test('refuses an entry whose driver does not match the manifest', async () => {
    expect((await loadError(fixture('wrong-capabilities'), 'darwin')).code).toBe('entry-mismatch')
  })
})

describe('readDriverManifest', () => {
  test('checks the manifest, platform and entry file, and never imports the entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'driver-sdk-read-'))
    const marker = join(dir, 'marker')
    await writeFile(
      join(dir, 'keith-driver.json'),
      JSON.stringify({
        manifestVersion: 1,
        name: 'fixture',
        version: '0.1.0',
        entry: 'index.ts',
        capabilities: [{ id: 'fixture.ping', schemaVersion: 1 }],
        platforms: ['darwin'],
      }),
    )
    await writeFile(
      join(dir, 'index.ts'),
      `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'ran')\nexport default {}\n`,
    )
    const read = await readDriverManifest(dir, { platform: 'darwin' })
    expect(read.manifest.name).toBe('fixture')
    expect(read.entry).toBe(resolve(dir, 'index.ts'))
    expect(await Bun.file(marker).exists()).toBe(false)
  })

  test('refuses a missing entry or an unsupported platform, like loadDriver', async () => {
    const missing = await readDriverManifest(fixture('missing-entry'), {
      platform: 'darwin',
    }).catch((error) => error)
    expect(missing).toBeInstanceOf(DriverLoadError)
    expect((missing as DriverLoadError).code).toBe('entry-missing')
    const platform = await readDriverManifest(fixture('good'), { platform: 'win32' }).catch(
      (error) => error,
    )
    expect((platform as DriverLoadError).code).toBe('platform-unsupported')
  })
})
