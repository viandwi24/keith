import { describe, expect, test } from 'bun:test'
import { DriverManifestSchema } from './manifest.ts'

const base = {
  manifestVersion: 1,
  name: 'desktop',
  version: '0.1.0',
  entry: 'dist/index.js',
  capabilities: [{ id: 'desktop.info', schemaVersion: 1 }],
  platforms: ['darwin'],
}

describe('DriverManifestSchema', () => {
  test('accepts a manifest and defaults needs to an empty list', () => {
    const parsed = DriverManifestSchema.parse(base)
    expect(parsed.needs).toEqual([])
    expect(parsed.capabilities).toEqual([{ id: 'desktop.info', schemaVersion: 1 }])
  })

  test('rejects a missing name, an unknown manifest version and an unknown key', () => {
    const { name: _name, ...noName } = base
    expect(DriverManifestSchema.safeParse(noName).success).toBe(false)
    expect(DriverManifestSchema.safeParse({ ...base, manifestVersion: 2 }).success).toBe(false)
    expect(DriverManifestSchema.safeParse({ ...base, extra: true }).success).toBe(false)
  })

  test('rejects a capability whose driver is not the manifest name', () => {
    const result = DriverManifestSchema.safeParse({
      ...base,
      capabilities: [{ id: 'shell.exec', schemaVersion: 1 }],
    })
    expect(result.success).toBe(false)
  })

  test('rejects a malformed capability id, a duplicate and an empty capability list', () => {
    const bad = (capabilities: unknown[]) =>
      DriverManifestSchema.safeParse({ ...base, capabilities }).success
    expect(bad([{ id: 'desktop', schemaVersion: 1 }])).toBe(false)
    expect(
      bad([
        { id: 'desktop.info', schemaVersion: 1 },
        { id: 'desktop.info', schemaVersion: 1 },
      ]),
    ).toBe(false)
    expect(bad([])).toBe(false)
  })

  test('rejects an entry outside the driver folder', () => {
    expect(DriverManifestSchema.safeParse({ ...base, entry: '../evil.js' }).success).toBe(false)
    expect(DriverManifestSchema.safeParse({ ...base, entry: '/abs/index.js' }).success).toBe(false)
    expect(DriverManifestSchema.safeParse({ ...base, entry: 'dist/../x.js' }).success).toBe(false)
  })

  test('rejects an unknown platform and an empty platform list', () => {
    expect(DriverManifestSchema.safeParse({ ...base, platforms: ['plan9'] }).success).toBe(false)
    expect(DriverManifestSchema.safeParse({ ...base, platforms: [] }).success).toBe(false)
  })
})
