import { describe, expect, test } from 'bun:test'
import { type CapabilityCall, defineDriver, driverProblems } from './define.ts'

const invoke = (_call: CapabilityCall) => ({ ok: true as const, output: null })

describe('defineDriver', () => {
  test('returns the definition it is given', () => {
    const driver = defineDriver({
      name: 'desktop',
      version: '0.1.0',
      capabilities: [{ id: 'desktop.info', schemaVersion: 1 }],
      invoke,
    })
    expect(driver.name).toBe('desktop')
    const call = {
      callId: '1',
      capability: 'desktop.info',
      schemaVersion: 1,
      input: {},
      timeoutMs: 1000,
    }
    expect(driver.invoke(call)).toEqual({ ok: true, output: null })
  })

  test('throws on a capability that does not start with the driver name', () => {
    expect(() =>
      defineDriver({
        name: 'desktop',
        version: '0.1.0',
        capabilities: [{ id: 'shell.exec', schemaVersion: 1 }],
        invoke,
      }),
    ).toThrow('does not start with the driver name')
  })

  test('throws on a bad name, version or missing invoke', () => {
    const problems = driverProblems({
      name: 'Desktop',
      version: 'one',
      capabilities: [{ id: 'desktop.info', schemaVersion: 1 }],
    })
    expect(problems.some((p) => p.startsWith('invalid driver name'))).toBe(true)
    expect(problems.some((p) => p.startsWith('invalid driver version'))).toBe(true)
    expect(problems).toContain('invoke must be a function')
    expect(driverProblems(undefined)).toHaveLength(1)
  })

  test('offered must be a function when it is given', () => {
    expect(
      driverProblems({
        name: 'desktop',
        version: '0.1.0',
        capabilities: [{ id: 'desktop.info', schemaVersion: 1 }],
        offered: 'all',
        invoke,
      }),
    ).toEqual(['offered must be a function'])
  })
})
