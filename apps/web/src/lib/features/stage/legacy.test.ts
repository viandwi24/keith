import { expect, test } from 'bun:test'
import { isStagePath, LEGACY_SCREENS, legacyRedirect } from './legacy.ts'

test('the old screens are off during the redesign', () => {
  expect(LEGACY_SCREENS).toBe(false)
})

test('every app path but the stage goes to the stage', () => {
  expect(isStagePath('/app', '/app')).toBe(true)
  expect(isStagePath('/app', '/app/')).toBe(true)
  expect(legacyRedirect('/app', '/app/')).toBeUndefined()
  expect(legacyRedirect('/app', '/app/chat')).toBe('/app/')
  expect(legacyRedirect('/app', '/app/manage/people')).toBe('/app/')
})

test('with the old screens on, nothing is redirected', () => {
  expect(legacyRedirect('/app', '/app/chat', true)).toBeUndefined()
})
