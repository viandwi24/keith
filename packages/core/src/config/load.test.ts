import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isKeithError, KeithError } from '@keith/sdk'
import { keithPaths, loadConfig, parseConfig } from './load.ts'
import { defaultPersona } from './persona.ts'

function caught(fn: () => unknown): KeithError {
  try {
    fn()
  } catch (error) {
    if (error instanceof KeithError) return error
    throw error
  }
  throw new Error('expected a throw')
}

describe('parseConfig', () => {
  test('an empty table gives every default', () => {
    const c = parseConfig({}, { env: {} })
    expect(c.server).toEqual({ host: '127.0.0.1', port: 4824 })
    expect(c.mind.turn).toEqual({ maxSteps: 8, stallMs: 120_000 })
    expect(c.mind.task).toEqual({ maxSteps: 20, maxPerPerson: 3, timeoutMs: 1_800_000 })
    expect(c.mind.commitment.ttlMs).toBe(604_800_000)
    expect(c.mind.arrival).toEqual({
      awayAfterMinutes: 240,
      briefing: 'on-greeting',
      holdMs: 120_000,
      graceMs: 1_500,
    })
    expect(c.mind.context.recentMessages).toBe(40)
    expect(c.mind.name).toBe('Keith')
    expect(c.mind.timezone.length).toBeGreaterThan(0)
    expect(c.memory.coreMaxChars).toBe(1_500)
    expect(c.scheduler).toEqual({ foreground: 4, delivery: 2, background: 2, tickMs: 30_000 })
    expect(c.models.foreground).toBe('deepseek:deepseek-flash')
    expect(c.auth.tokenTtlDays).toBe(30)
    expect(c.plugins).toEqual({ enabled: [], required: [], stopTimeoutMs: 5_000, sections: {} })
    expect(c.services).toEqual({})
  })

  test('unknown key is an error naming the key', () => {
    const e = caught(() => parseConfig({ mind: { turn: { maxStep: 3 } } }, { env: {} }))
    expect(e.code).toBe('CONFIG_INVALID')
    expect(e.message).toContain('mind.turn.maxStep')
    const top = caught(() => parseConfig({ sever: {} }, { env: {} }))
    expect(top.message).toContain('sever')
  })

  test('unknown scalar key in [plugins] is an error; tables are plugin sections', () => {
    const e = caught(() => parseConfig({ plugins: { enable: ['x'] } }, { env: {} }))
    expect(e.message).toContain('plugins.enable')
    const c = parseConfig(
      { plugins: { enabled: ['@keith/x'], '@keith/x': { units: 'metric' } } },
      { env: {} },
    )
    expect(c.plugins.sections).toEqual({ '@keith/x': { units: 'metric' } })
  })

  test('invalid values are errors naming the key', () => {
    expect(caught(() => parseConfig({ server: { port: 'x' } }, { env: {} })).message).toContain('server.port')
    expect(caught(() => parseConfig({ models: { foreground: 'nocolon' } }, { env: {} })).message).toContain(
      'models.foreground',
    )
    expect(caught(() => parseConfig({ mind: { timezone: 'Mars/Base' } }, { env: {} })).message).toContain(
      'mind.timezone',
    )
  })

  test('env: values resolve from the environment, at any depth', () => {
    const c = parseConfig(
      { mind: { name: 'env:NAME' }, plugins: { '@keith/p': { apiKey: 'env:API_KEY', list: ['env:NAME'] } } },
      { env: { NAME: 'Jarvis', API_KEY: 'sk' } },
    )
    expect(c.mind.name).toBe('Jarvis')
    expect(c.plugins.sections['@keith/p']).toEqual({ apiKey: 'sk', list: ['Jarvis'] })
  })

  test('a missing env: variable is an error naming the key and the variable', () => {
    const e = caught(() =>
      parseConfig(
        { plugins: { '@keith/provider-deepseek': { apiKey: 'env:DEEPSEEK_API_KEY' } } },
        { env: {} },
      ),
    )
    expect(e.code).toBe('CONFIG_INVALID')
    expect(e.message).toContain('DEEPSEEK_API_KEY')
    expect(e.message).toContain('plugins."@keith/provider-deepseek".apiKey')
  })

  test('overrides apply in precedence order: file < KEITH__ env < flags', () => {
    const file = { server: { host: '0.0.0.0', port: 1000 }, mind: { turn: { maxSteps: 2 } } }
    const env = {
      KEITH__SERVER__PORT: '2000',
      KEITH__MIND__TURN__MAXSTEPS: '12',
      KEITH__SERVER__HOST: '10.0.0.1',
    }
    expect(parseConfig(file, { env: {} }).server.port).toBe(1000)
    const withEnv = parseConfig(file, { env })
    expect(withEnv.server).toEqual({ host: '10.0.0.1', port: 2000 })
    expect(withEnv.mind.turn.maxSteps).toBe(12)
    const withFlags = parseConfig(file, { env, flags: { port: 3000 } })
    expect(withFlags.server).toEqual({ host: '10.0.0.1', port: 3000 })
    expect(parseConfig(file, { env, flags: { host: 'h' } }).server.host).toBe('h')
  })

  test('KEITH__ values are JSON when possible, otherwise strings', () => {
    const c = parseConfig(
      {},
      {
        env: {
          KEITH__PLUGINS__ENABLED: '["@keith/a","@keith/b"]',
          KEITH__MIND__NAME: 'Friday',
          KEITH__MIND__ARRIVAL__AWAYAFTERMINUTES: '0.5',
        },
      },
    )
    expect(c.plugins.enabled).toEqual(['@keith/a', '@keith/b'])
    expect(c.mind.name).toBe('Friday')
    expect(c.mind.arrival.awayAfterMinutes).toBe(0.5)
  })

  test('KEITH__ overrides that match no key, a plugin section or services are errors', () => {
    for (const name of [
      'KEITH__SERVER__PROT',
      'KEITH__PLUGINS__SECTIONS__X',
      'KEITH__SERVICES__WEATHER',
      'KEITH__SERVER',
    ]) {
      const e = caught(() => parseConfig({}, { env: { [name]: '1' } }))
      expect(e.code).toBe('CONFIG_INVALID')
      expect(e.message).toContain(name)
    }
  })
})

describe('loadConfig', () => {
  let home = ''
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'keith-config-'))
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  test('reads config.toml from KEITH_HOME', async () => {
    await writeFile(
      join(home, 'config.toml'),
      `[server]\nport = 5000\n\n[models]\nforeground = "openrouter:vendor/model:free"\n\n[plugins]\nenabled = ["@keith/provider-openrouter"]\n\n[plugins."@keith/provider-openrouter"]\napiKey = "env:OR_KEY"\n\n[services]\nweather = "@keith/tool-weather"\n`,
    )
    const c = await loadConfig({ home, env: { OR_KEY: 'k' } })
    expect(c.server.port).toBe(5000)
    expect(c.models.foreground).toBe('openrouter:vendor/model:free')
    expect(c.plugins.sections['@keith/provider-openrouter']).toEqual({ apiKey: 'k' })
    expect(c.services).toEqual({ weather: '@keith/tool-weather' })
  })

  test('a missing file or bad TOML is CONFIG_INVALID', async () => {
    const missing = await loadConfig({ home, env: {} }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(isKeithError(missing, 'CONFIG_INVALID')).toBe(true)
    await writeFile(join(home, 'config.toml'), '[server\nport = ')
    const bad = await loadConfig({ home, env: {} }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(isKeithError(bad, 'CONFIG_INVALID')).toBe(true)
  })

  test('keithPaths lays out KEITH_HOME', () => {
    const p = keithPaths('/k')
    expect(p).toEqual({
      home: '/k',
      configFile: '/k/config.toml',
      personaFile: '/k/persona.md',
      dbFile: '/k/keith.db',
      filesDir: '/k/files',
      pluginsDir: '/k/plugins',
      logsDir: '/k/logs',
    })
  })

  test('defaultPersona fills in the name', () => {
    const text = defaultPersona('Jarvis')
    expect(text).toContain('You are Jarvis')
    expect(text).not.toContain('{name}')
  })
})
