import { describe, expect, test } from 'bun:test'
import { hrefOf, isActive, itemOf, MORE, NAV, TABS } from './nav.ts'

const item = (id: string) => {
  const found = itemOf(id)
  if (found === undefined) throw new Error(id)
  return found
}

describe('nav model', () => {
  test('lists the destinations in order', () => {
    expect(NAV.map((i) => i.id)).toEqual([
      'home',
      'chat',
      'tasks',
      'rooms',
      'inbox',
      'nodes',
      'budget',
      'presence',
      'brain',
      'me',
      'apps',
      'help',
      'manage',
    ])
  })
  test('the phone tab bar is Home, Chat, Inbox, More', () => {
    expect(TABS.map((i) => i.label)).toEqual(['Home', 'Chat', 'Inbox', 'More'])
    expect(TABS.at(-1)).toBe(MORE)
  })
  test('hrefs sit under the base', () => {
    expect(hrefOf('/app', item('home'))).toBe('/app/')
    expect(hrefOf('/app', item('tasks'))).toBe('/app/tasks')
  })
  test('Home matches only itself; others match their subtree', () => {
    expect(isActive('/app', '/app/', item('home'))).toBe(true)
    expect(isActive('/app', '/app/chat', item('home'))).toBe(false)
    expect(isActive('/app', '/app/chat/abc', item('chat'))).toBe(true)
    expect(isActive('/app', '/app/chatter', item('chat'))).toBe(false)
  })
  test('unknown sections have no item', () => {
    expect(itemOf('nope')).toBeUndefined()
  })
})
