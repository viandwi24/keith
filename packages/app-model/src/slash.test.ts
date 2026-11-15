import { expect, test } from 'bun:test'
import { completeCommand, matchCommands, SLASH_COMMANDS } from './slash.ts'

test('only a draft that starts with / offers commands, by prefix', () => {
  expect(matchCommands('hello')).toEqual([])
  expect(matchCommands('')).toEqual([])
  expect(matchCommands('/')).toEqual([...SLASH_COMMANDS])
  expect(matchCommands('/t')).toEqual(['/tasks'])
  expect(matchCommands('/BR')).toEqual(['/brain trace'])
  expect(matchCommands('/nope')).toEqual([])
  expect(matchCommands('/tasks\nmore')).toEqual([])
  expect(matchCommands('/n')).toEqual(['/new', '/nodes']) // /new is one of two: /ne is unique
  expect(matchCommands('/ne')).toEqual(['/new'])
  expect(matchCommands('/com')).toEqual(['/compact'])
  expect(matchCommands('/dr')).toEqual([
    '/dream',
    '/dream now',
    '/dream apply',
    '/dream undo',
    '/dream mode off',
    '/dream mode propose',
    '/dream mode auto',
  ])
})

test('tab completes only when exactly one command matches and it is not typed already', () => {
  expect(completeCommand('/ta')).toBe('/tasks')
  expect(completeCommand('/tasks')).toBeUndefined()
  expect(completeCommand('/')).toBeUndefined()
  expect(completeCommand('/b')).toBeUndefined() // /brain trace and /budget
  expect(completeCommand('/br')).toBe('/brain trace')
})
