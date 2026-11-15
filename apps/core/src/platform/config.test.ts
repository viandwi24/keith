import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { loadConfig } from './config.ts'

describe('loadConfig', () => {
  test('data dir precedence: KEITH_DATA_DIR, then KEITH_HOME/data, then the repo default', () => {
    expect(loadConfig({ KEITH_HOME: '/tmp/kh' }).dataDir).toBe('/tmp/kh/data')
    expect(loadConfig({ KEITH_HOME: '/tmp/kh', KEITH_DATA_DIR: '/var/k' }).dataDir).toBe('/var/k')
    expect(loadConfig({ KEITH_HOME: '/tmp/kh', KEITH_DATA_DIR: '' }).dataDir).toBe('/tmp/kh/data')
    expect(loadConfig({ KEITH_HOME: '' }).dataDir).toBe(
      resolve(import.meta.dir, '../../../../data'),
    )
    expect(loadConfig({ KEITH_HOME: 'rel' }).dataDir).toBe(resolve('rel', 'data'))
  })

  test('uses defaults when nothing is set', () => {
    const config = loadConfig({})
    expect(config.dataDir).toBe(resolve(import.meta.dir, '../../../../data'))
    expect(config.dbFile).toBe(resolve(config.dataDir, 'keith.db'))
    expect(config.port).toBe(7420)
    expect(config.host).toBe('127.0.0.1')
    expect(config.logLevel).toBe('info')
    expect(config.secretKey).toBeUndefined()
    expect(config.allowCoreShell).toBe(false)
    expect(config.publicUrl).toBeUndefined()
    expect(config.providerEnv).toEqual({
      OPENROUTER_API_KEY: undefined,
      OPENROUTER_BASE_URL: undefined,
    })
  })

  test('reads and coerces the environment; empty strings count as unset', () => {
    const config = loadConfig({
      KEITH_DATA_DIR: '/var/keith',
      KEITH_PORT: '8080',
      KEITH_HOST: '100.64.0.1',
      KEITH_LOG_LEVEL: 'debug',
      KEITH_SECRET_KEY: '',
      OPENROUTER_API_KEY: 'sk-test',
    })
    expect(config.dbFile).toBe('/var/keith/keith.db')
    expect(config.port).toBe(8080)
    expect(config.host).toBe('100.64.0.1')
    expect(config.logLevel).toBe('debug')
    expect(config.secretKey).toBeUndefined()
    expect(config.providerEnv.OPENROUTER_API_KEY).toBe('sk-test')
  })

  test('KEITH_MODELS_DEV_URL moves the catalog download', () => {
    expect(loadConfig({}).modelsDevUrl).toBeUndefined()
    expect(loadConfig({ KEITH_MODELS_DEV_URL: 'http://127.0.0.1:9/api.json' }).modelsDevUrl).toBe(
      'http://127.0.0.1:9/api.json',
    )
    expect(() => loadConfig({ KEITH_MODELS_DEV_URL: 'nope' })).toThrow(/KEITH_MODELS_DEV_URL/)
  })

  test('KEITH_NODE_ROTATE_MS: a positive whole number of milliseconds, unset keeps the default', () => {
    expect(loadConfig({}).nodeTokenRotateMs).toBeUndefined()
    expect(loadConfig({ KEITH_NODE_ROTATE_MS: '2000' }).nodeTokenRotateMs).toBe(2000)
    expect(() => loadConfig({ KEITH_NODE_ROTATE_MS: '0' })).toThrow(/KEITH_NODE_ROTATE_MS/)
    expect(() => loadConfig({ KEITH_NODE_ROTATE_MS: '1.5' })).toThrow(/KEITH_NODE_ROTATE_MS/)
  })

  test('names every invalid variable', () => {
    expect(() => loadConfig({ KEITH_PORT: 'abc', KEITH_LOG_LEVEL: 'loud' })).toThrow(
      /KEITH_PORT.*KEITH_LOG_LEVEL/,
    )
  })

  test('node settings: core shell flag, public url without a trailing slash, minimal shell env', () => {
    const config = loadConfig({
      KEITH_CORE_ALLOW_SHELL: 'true',
      KEITH_PUBLIC_URL: 'http://100.64.0.1:7420/',
      PATH: '/usr/bin',
      OPENROUTER_API_KEY: 'sk-test',
    })
    expect(config.allowCoreShell).toBe(true)
    expect(config.publicUrl).toBe('http://100.64.0.1:7420')
    expect(config.shellEnv).toEqual({ PATH: '/usr/bin' })
    const full = loadConfig({
      PATH: '/usr/bin',
      HOME: '/home/keith',
      LANG: 'C.UTF-8',
      USER: 'keith',
      TERM: 'xterm',
      TMPDIR: '/tmp',
      SHELL: '/bin/zsh',
      OPENROUTER_API_KEY: 'sk-test',
    })
    expect(full.shellEnv).toEqual({ PATH: '/usr/bin', HOME: '/home/keith', LANG: 'C.UTF-8' })
    expect(loadConfig({ KEITH_CORE_ALLOW_SHELL: '' }).allowCoreShell).toBe(false)
    expect(() => loadConfig({ KEITH_CORE_ALLOW_SHELL: 'yes' })).toThrow(/KEITH_CORE_ALLOW_SHELL/)
    expect(() => loadConfig({ KEITH_PUBLIC_URL: 'not a url' })).toThrow(/KEITH_PUBLIC_URL/)
  })

  test('KEITH_INSECURE_LOGIN is off unless set', () => {
    expect(loadConfig({}).insecureLogin).toBe(false)
    expect(loadConfig({ KEITH_INSECURE_LOGIN: 'true' }).insecureLogin).toBe(true)
    expect(() => loadConfig({ KEITH_INSECURE_LOGIN: 'yes' })).toThrow(/KEITH_INSECURE_LOGIN/)
  })

  test('the web client is on by default and served from apps/web/build', () => {
    const config = loadConfig({})
    expect(config.web).toBe(true)
    expect(config.webDir).toBe(resolve(import.meta.dir, '../../../web/build'))
    expect(loadConfig({ KEITH_WEB: 'off' }).web).toBe(false)
    expect(loadConfig({ KEITH_WEB: 'on', KEITH_WEB_DIR: '/srv/web' }).webDir).toBe('/srv/web')
    expect(loadConfig({ KEITH_WEB: '', KEITH_WEB_DIR: '' }).web).toBe(true)
  })

  test('KEITH_PUSH_SUBJECT: a mailto: or https URL, empty is unset, anything else is refused', () => {
    expect(loadConfig({}).pushSubject).toBeUndefined()
    expect(loadConfig({ KEITH_PUSH_SUBJECT: '' }).pushSubject).toBeUndefined()
    expect(loadConfig({ KEITH_PUSH_SUBJECT: 'mailto:me@example.com' }).pushSubject).toBe(
      'mailto:me@example.com',
    )
    expect(loadConfig({ KEITH_PUSH_SUBJECT: 'https://keith.example.com' }).pushSubject).toBe(
      'https://keith.example.com',
    )
    expect(() => loadConfig({ KEITH_PUSH_SUBJECT: 'http://keith.example.com' })).toThrow(
      'KEITH_PUSH_SUBJECT',
    )
  })
})
