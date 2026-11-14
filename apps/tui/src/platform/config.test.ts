import { expect, test } from 'bun:test'
import { loadConfig } from './config.ts'

test('KEITH_CLIENT_CONFIG sets the client config path, absent means the default', () => {
  expect(loadConfig({ KEITH_CLIENT_CONFIG: '/tmp/x/client.json' }).clientConfigPath).toBe(
    '/tmp/x/client.json',
  )
  expect(loadConfig({}).clientConfigPath).toBeUndefined()
  expect(() => loadConfig({ KEITH_CLIENT_CONFIG: '' })).toThrow()
})

test('KEITH_HOME moves the login to <home>/client.json; KEITH_CLIENT_CONFIG wins', () => {
  expect(loadConfig({ KEITH_HOME: '/tmp/kh' }).clientConfigPath).toBe('/tmp/kh/client.json')
  expect(loadConfig({ KEITH_HOME: '' }).clientConfigPath).toBeUndefined()
  expect(
    loadConfig({ KEITH_HOME: '/tmp/kh', KEITH_CLIENT_CONFIG: '/tmp/x.json' }).clientConfigPath,
  ).toBe('/tmp/x.json')
})

test('the data dir: KEITH_DATA_DIR, else <KEITH_HOME>/data, else <repo>/data', () => {
  expect(loadConfig({ KEITH_DATA_DIR: '/tmp/d', KEITH_HOME: '/tmp/kh' }).dataDir).toBe('/tmp/d')
  expect(loadConfig({ KEITH_HOME: '/tmp/kh' }).dataDir).toBe('/tmp/kh/data')
  expect(loadConfig({ KEITH_HOME: '', KEITH_DATA_DIR: '' }).dataDir).toMatch(/\/data$/)
  expect(loadConfig({}).dataDir).toBe(loadConfig({ KEITH_HOME: '' }).dataDir)
})

test('the theme: KEITH_THEME wins, auto reads COLORFGBG (7 and 15 are light), missing is dark', () => {
  expect(loadConfig({}).theme).toBe('dark')
  expect(loadConfig({ COLORFGBG: '15;0' }).theme).toBe('dark')
  expect(loadConfig({ COLORFGBG: '0;15' }).theme).toBe('light')
  expect(loadConfig({ COLORFGBG: '0;default;7' }).theme).toBe('light')
  expect(loadConfig({ COLORFGBG: '0;8' }).theme).toBe('dark')
  expect(loadConfig({ KEITH_THEME: 'auto', COLORFGBG: '0;15' }).theme).toBe('light')
  expect(loadConfig({ KEITH_THEME: 'dark', COLORFGBG: '0;15' }).theme).toBe('dark')
  expect(loadConfig({ KEITH_THEME: 'light' }).theme).toBe('light')
  expect(loadConfig({ KEITH_THEME: 'purple', COLORFGBG: '0;15' }).theme).toBe('light')
})

test('the colour depth: NO_COLOR (non-empty) beats COLORTERM, then TERM, else 16', () => {
  expect(loadConfig({ NO_COLOR: '1', COLORTERM: 'truecolor' }).depth).toBe('none')
  expect(loadConfig({ NO_COLOR: '', COLORTERM: 'truecolor' }).depth).toBe('truecolor')
  expect(loadConfig({ COLORTERM: '24bit' }).depth).toBe('truecolor')
  expect(loadConfig({ TERM: 'xterm-256color' }).depth).toBe('256')
  expect(loadConfig({ TERM: 'xterm' }).depth).toBe('16')
  expect(loadConfig({}).depth).toBe('16')
})

test('KEITH_CELL_ASPECT: a number from 0.25 to 0.8, anything else is unset', () => {
  expect(loadConfig({}).cellAspect).toBeUndefined()
  expect(loadConfig({ KEITH_CELL_ASPECT: '0.42' }).cellAspect).toBe(0.42)
  expect(loadConfig({ KEITH_CELL_ASPECT: '0.1' }).cellAspect).toBeUndefined()
  expect(loadConfig({ KEITH_CELL_ASPECT: 'wide' }).cellAspect).toBeUndefined()
  expect(loadConfig({ KEITH_CELL_ASPECT: '' }).cellAspect).toBeUndefined()
})

test('motion: the intro is on, the idle hide is 60 s, reduced motion is off; the env changes each', () => {
  expect(loadConfig({}).motion).toEqual({
    intro: true,
    idleHideSeconds: 60,
    reduced: false,
    orbStatic: false,
  })
  expect(loadConfig({ KEITH_INTRO: 'off' }).motion.intro).toBe(false)
  expect(loadConfig({ KEITH_INTRO: '1' }).motion.intro).toBe(true)
  expect(loadConfig({ KEITH_IDLE_HIDE_SECONDS: '0' }).motion.idleHideSeconds).toBe(0)
  expect(loadConfig({ KEITH_IDLE_HIDE_SECONDS: '15' }).motion.idleHideSeconds).toBe(15)
  expect(loadConfig({ KEITH_IDLE_HIDE_SECONDS: '-3' }).motion.idleHideSeconds).toBe(60)
  expect(loadConfig({ KEITH_IDLE_HIDE_SECONDS: 'soon' }).motion.idleHideSeconds).toBe(60)
  expect(loadConfig({ KEITH_REDUCED_MOTION: '1' }).motion.reduced).toBe(true)
  expect(loadConfig({ KEITH_REDUCED_MOTION: '0' }).motion.reduced).toBe(false)
  expect(loadConfig({ KEITH_DISABLE_ORB: '1' }).motion.orbStatic).toBe(true)
  expect(loadConfig({ KEITH_DISABLE_ORB: 'off' }).motion.orbStatic).toBe(false)
})
