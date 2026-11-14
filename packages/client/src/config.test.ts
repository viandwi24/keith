import { afterAll, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRemembered, readClientConfig, writeClientConfig, writeFileAtomic } from './config.ts'
import { clientStatePath, fileClientIdStore, fileIdentifierMemory } from './identifier-memory.ts'

const dir = mkdtempSync(join(tmpdir(), 'keith-client-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('the client config round-trips and is private to the user', () => {
  const path = join(dir, 'nested', 'client.json')
  expect(readClientConfig(path)).toBeUndefined()
  writeClientConfig({ core: 'http://localhost:7420', token: 'keith_x' }, path)
  expect(readClientConfig(path)).toEqual({ core: 'http://localhost:7420', token: 'keith_x' })
  expect(statSync(path).mode & 0o777).toBe(0o600)
})

test('the remember marker survives a round trip and a file without it is not remembered', () => {
  const path = join(dir, 'marked', 'client.json')
  writeClientConfig({ core: 'http://localhost:7420', token: 'keith_x', remember: true }, path)
  const kept = readClientConfig(path)
  expect(kept).toEqual({ core: 'http://localhost:7420', token: 'keith_x', remember: true })
  expect(kept !== undefined && isRemembered(kept)).toBe(true)
  writeClientConfig({ core: 'http://localhost:7420', token: 'keith_x' }, path)
  const plain = readClientConfig(path)
  expect(plain !== undefined && isRemembered(plain)).toBe(false)
})

test('a write returns the entry it replaces; a first write and a damaged file replace nothing', () => {
  const path = join(dir, 'replaced', 'client.json')
  expect(writeClientConfig({ core: 'http://a:1', token: 'keith_one' }, path)).toBeUndefined()
  expect(writeClientConfig({ core: 'http://b:2', token: 'keith_two' }, path)).toEqual({
    core: 'http://a:1',
    token: 'keith_one',
  })
  expect(readClientConfig(path)).toEqual({ core: 'http://b:2', token: 'keith_two' })
  writeFileSync(path, '{"core":')
  expect(writeClientConfig({ core: 'http://c:3', token: 'keith_three' }, path)).toBeUndefined()
  expect(readClientConfig(path)).toEqual({ core: 'http://c:3', token: 'keith_three' })
})

test('a write leaves no temp file beside the config and keeps it at mode 0600', () => {
  const path = join(dir, 'atomic', 'client.json')
  writeClientConfig({ core: 'http://a:1', token: 'keith_one' }, path)
  writeClientConfig({ core: 'http://a:1', token: 'keith_two' }, path)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(readdirSync(join(dir, 'atomic'))).toEqual(['client.json'])
})

test('a failed write keeps the file it could not replace and leaves no temp file', () => {
  const folder = join(dir, 'blocked')
  mkdirSync(folder, { recursive: true })
  const path = join(folder, 'client.json')
  writeClientConfig({ core: 'http://a:1', token: 'keith_one' }, path)
  // a directory cannot be renamed over a file: the rename fails after the temp file was written
  mkdirSync(join(folder, 'client.json.dir'))
  expect(() => writeFileAtomic(join(folder, 'client.json.dir'), 'x')).toThrow()
  expect(readClientConfig(path)).toEqual({ core: 'http://a:1', token: 'keith_one' })
  expect(readdirSync(folder).some((name) => name.endsWith('.tmp'))).toBe(false)
})

test('the client id is kept in client-state.json beside the identifiers', () => {
  const path = join(dir, 'state', 'client.json')
  const id = fileClientIdStore(path)
  const identifiers = fileIdentifierMemory(path)
  identifiers.write('http://localhost:7420', 'ana')
  id.write('0190a6a0-0000-4000-8000-000000000001')
  expect(fileClientIdStore(path).read()).toBe('0190a6a0-0000-4000-8000-000000000001')
  expect(identifiers.read('http://localhost:7420')).toBe('ana')
  expect(JSON.parse(readFileSync(clientStatePath(path), 'utf8'))).toEqual({
    identifiers: { 'http://localhost:7420': 'ana' },
    clientId: '0190a6a0-0000-4000-8000-000000000001',
  })
})
