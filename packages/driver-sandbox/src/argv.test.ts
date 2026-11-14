import { describe, expect, test } from 'bun:test'
import { containerName, killArgv, runArgv } from './argv.ts'

describe('containerName', () => {
  test('is keith-sbx- plus the call id, with unsafe characters replaced and a 64-character cap', () => {
    expect(containerName('abc-123_x.y')).toBe('keith-sbx-abc-123_x.y')
    expect(containerName('a b/c')).toBe('keith-sbx-a-b-c')
    expect(containerName('x'.repeat(200)).length).toBe('keith-sbx-'.length + 64)
  })
})

describe('runArgv and killArgv', () => {
  const base = {
    runtime: 'podman' as const,
    name: 'keith-sbx-1',
    image: 'alpine:3.20',
    language: 'sh' as const,
    code: 'echo hi',
    network: false,
    stdin: false,
  }

  test('a run without network has no network except none, and no -i without stdin', () => {
    const argv = runArgv(base)
    expect(argv[0]).toBe('podman')
    expect(argv).toContain('--network')
    expect(argv).not.toContain('-i')
    expect(argv.slice(-5)).toEqual(['--entrypoint', 'sh', 'alpine:3.20', '-c', 'echo hi'])
  })

  test('network and stdin change only their own flags', () => {
    const argv = runArgv({ ...base, network: true, stdin: true })
    expect(argv).not.toContain('--network')
    expect(argv).toContain('-i')
  })

  test('kill names the container through the runtime', () => {
    expect(killArgv('docker', 'keith-sbx-1')).toEqual(['docker', 'kill', 'keith-sbx-1'])
  })
})
