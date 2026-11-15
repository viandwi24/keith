import { describe, expect, test } from 'bun:test'
import {
  BOTTOM_SLACK,
  isAtBottom,
  onNewContent,
  scrollTopAfterPrepend,
  shouldLoadOlder,
  TOP_LOAD_AT,
} from './scroll.ts'

const box = (scrollTop: number) => ({ scrollTop, clientHeight: 500, scrollHeight: 2000 })

describe('scroll rules', () => {
  test('at the bottom within the slack', () => {
    expect(isAtBottom(box(1500))).toBe(true)
    expect(isAtBottom(box(1500 - BOTTOM_SLACK))).toBe(true)
    expect(isAtBottom(box(1500 - BOTTOM_SLACK - 1))).toBe(false)
    expect(isAtBottom({ scrollTop: 0, clientHeight: 500, scrollHeight: 400 })).toBe(true)
  })

  test('new content follows only from the bottom or after a send', () => {
    expect(onNewContent({ wasAtBottom: true, justSent: false })).toBe('follow')
    expect(onNewContent({ wasAtBottom: false, justSent: true })).toBe('follow')
    expect(onNewContent({ wasAtBottom: false, justSent: false })).toBe('offer-jump')
  })

  test('older messages load near the top, once, and only when there are some', () => {
    const state = { hasOlder: true, loadingOlder: false, loaded: true }
    expect(shouldLoadOlder(box(TOP_LOAD_AT), state)).toBe(true)
    expect(shouldLoadOlder(box(TOP_LOAD_AT + 1), state)).toBe(false)
    expect(shouldLoadOlder(box(0), { ...state, loadingOlder: true })).toBe(false)
    expect(shouldLoadOlder(box(0), { ...state, hasOlder: false })).toBe(false)
    expect(shouldLoadOlder(box(0), { ...state, loaded: false })).toBe(false)
  })

  test('prepending keeps the view on the same message', () => {
    expect(scrollTopAfterPrepend(box(100), 2600)).toBe(700)
  })
})
