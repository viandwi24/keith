import { expect, test } from 'bun:test'
import { currentGenerationOf } from './front-generation.ts'

test('the current generation is the last of chat.generations, 0 when there is none', () => {
  expect(currentGenerationOf([])).toBe(0)
  expect(currentGenerationOf([{ generation: 0 }])).toBe(0)
  expect(currentGenerationOf([{ generation: 0 }, { generation: 1 }, { generation: 2 }])).toBe(2)
})
