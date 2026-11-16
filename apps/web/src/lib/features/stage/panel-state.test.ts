import { expect, test } from 'bun:test'
import { panelKey, readPanelExpanded, writePanelExpanded } from './panel-state.ts'

const memory = () => {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  }
}

test('a panel starts collapsed and remembers being expanded', () => {
  const s = memory()
  expect(readPanelExpanded('brain', s)).toBe(false)
  writePanelExpanded('brain', true, s)
  expect(s.map.get(panelKey('brain'))).toBe('on')
  expect(readPanelExpanded('brain', s)).toBe(true)
  writePanelExpanded('brain', false, s)
  expect(s.map.size).toBe(0)
})

test('no storage, or storage that throws, means collapsed and no error', () => {
  expect(readPanelExpanded('brain', undefined)).toBe(false)
  const broken = {
    getItem: () => {
      throw new Error('denied')
    },
    setItem: () => {
      throw new Error('denied')
    },
    removeItem: () => {
      throw new Error('denied')
    },
  }
  expect(readPanelExpanded('brain', broken)).toBe(false)
  expect(() => writePanelExpanded('brain', true, broken)).not.toThrow()
})
