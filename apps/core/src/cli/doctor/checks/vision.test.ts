import { expect, test } from 'bun:test'
import { visionLines } from './vision.ts'

const desktop = ['laptop-e']

test('a text-only cortex model with a desktop node is a warning that names the fix', () => {
  const [line] = visionLines({
    cortex: 'openrouter:text',
    inputModalities: ['text'],
    desktopNodes: desktop,
  })
  expect(line).toMatchObject({ level: 'warn', name: 'vision' })
  expect(line?.hint).toContain('keith-core model set cortex')
})

test('an image model with a desktop node is ok', () => {
  expect(
    visionLines({
      cortex: 'openrouter:vision',
      inputModalities: ['text', 'image'],
      desktopNodes: desktop,
    }),
  ).toEqual([
    {
      level: 'ok',
      name: 'vision',
      hint: 'cortex openrouter:vision reads images (desktop: laptop-e)',
    },
  ])
})

test('no desktop node, no cortex model, or an unknown modality says nothing', () => {
  expect(visionLines({ cortex: 'x:y', inputModalities: ['text'], desktopNodes: [] })).toEqual([])
  expect(visionLines({ cortex: null, inputModalities: ['text'], desktopNodes: desktop })).toEqual(
    [],
  )
  expect(visionLines({ cortex: 'x:y', inputModalities: undefined, desktopNodes: desktop })).toEqual(
    [],
  )
})
