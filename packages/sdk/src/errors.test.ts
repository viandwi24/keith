import { describe, expect, test } from 'bun:test'
import { isKeithError, KEITH_ERROR_CODES, KeithError } from './errors.ts'
import { isProviderError, PROVIDER_ERROR_CODES, ProviderError } from './providers/types.ts'

describe('KeithError', () => {
  test('carries code, message, cause and details', () => {
    const cause = new Error('disk')
    const error = new KeithError('STORAGE_CORRUPT', 'bad row in tasks', {
      cause,
      details: { table: 'tasks' },
    })
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('KeithError')
    expect(error.code).toBe('STORAGE_CORRUPT')
    expect(error.message).toBe('bad row in tasks')
    expect(error.cause).toBe(cause)
    expect(error.details).toEqual({ table: 'tasks' })
  })

  test('isKeithError checks type and optionally code', () => {
    const error = new KeithError('SERVICE_MISSING', 'x')
    expect(isKeithError(error)).toBe(true)
    expect(isKeithError(error, 'SERVICE_MISSING')).toBe(true)
    expect(isKeithError(error, 'SERVICE_CONFLICT')).toBe(false)
    expect(isKeithError(new Error('x'))).toBe(false)
  })

  test('the code list matches plugin-api.md#errors', async () => {
    const doc = await Bun.file(new URL('../../../docs/contracts/plugin-api.md', import.meta.url)).text()
    const section = (doc.split('## Errors')[1] ?? '').split('\n## ')[0] ?? ''
    const tableRows = section
      .split('\n')
      .filter((l) => l.startsWith('| '))
      .join('\n')
    const documented = [...tableRows.matchAll(/`([A-Z_]+)`/g)].map((m) => m[1])
    expect([...documented].sort()).toEqual([...KEITH_ERROR_CODES].sort())
  })
})

describe('ProviderError', () => {
  test.each([
    ['rate_limited', true],
    ['unavailable', true],
    ['timeout', true],
    ['auth', false],
    ['bad_request', false],
    ['aborted', false],
    ['unknown', false],
  ] as const)('%s is retryable by default: %p', (code, retryable) => {
    expect(new ProviderError(code).retryable).toBe(retryable)
  })

  test('the adapter can override retryable and record the status', () => {
    const error = new ProviderError('unknown', 'weird 520', { retryable: true, status: 520 })
    expect(error.retryable).toBe(true)
    expect(error.status).toBe(520)
    expect(error.message).toBe('weird 520')
  })

  test('isProviderError', () => {
    expect(isProviderError(new ProviderError('aborted'), 'aborted')).toBe(true)
    expect(isProviderError(new ProviderError('auth'), 'aborted')).toBe(false)
    expect(isProviderError(new Error('aborted'))).toBe(false)
  })

  test('the code list matches providers.md', async () => {
    const doc = await Bun.file(new URL('../../../docs/contracts/providers.md', import.meta.url)).text()
    const line = doc.split('\n').find((l) => l.includes('Errors are thrown as `ProviderError`')) ?? ''
    const documented = [...line.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
    expect([...documented].sort()).toEqual([...PROVIDER_ERROR_CODES].sort())
  })
})
