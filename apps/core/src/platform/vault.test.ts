import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVault, generateSecretKey } from './vault.ts'

const dir = mkdtempSync(join(tmpdir(), 'keith-vault-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('createVault', () => {
  test('seals with the configured key', async () => {
    const { vault, devKey } = createVault(generateSecretKey(), dir)
    expect(devKey).toBe(false)
    const blob = await vault.seal('sk-secret', 'ctx')
    expect(blob).not.toContain('sk-secret')
    expect(await vault.open(blob, 'ctx')).toBe('sk-secret')
  })

  test('creates one dev key file (0600) and reuses it', async () => {
    const first = createVault(undefined, dir)
    expect(first.devKey).toBe(true)
    expect(statSync(join(dir, 'secret.key')).mode & 0o777).toBe(0o600)
    const blob = await first.vault.seal('x', 'ctx')
    expect(await createVault(undefined, dir).vault.open(blob, 'ctx')).toBe('x')
  })

  test('rejects a key of the wrong size', () => {
    expect(() => createVault('c2hvcnQ=', dir)).toThrow('32 bytes')
  })
})
