import { describe, expect, test } from 'bun:test'
import type { HarnessLogger } from 'eharness'
import { createGuestLogger } from './guest-logger.ts'

const recorder = () => {
  const lines: { level: string; message: string; fields?: Record<string, unknown> }[] = []
  const put =
    (level: string) =>
    (message: string, fields?: Record<string, unknown>): void => {
      lines.push({ level, message, ...(fields === undefined ? {} : { fields }) })
    }
  const base = { debug: put('debug'), info: put('info'), warn: put('warn'), error: put('error') }
  return { lines, base: base as unknown as HarnessLogger }
}

const context = { guestSession: 'guest:01', ipHash: 'h-1' }

describe('createGuestLogger (REQ-187)', () => {
  test('writes only code, guestSession and ipHash; the text and other fields are dropped', () => {
    const { lines, base } = recorder()
    const log = createGuestLogger(base, context)
    log.error('provider failed for "my secret plan" at 10.0.0.9', {
      code: 'W_HOOK_FAILED',
      text: 'what the visitor typed',
      userAgent: 'Mozilla',
      ip: '10.0.0.9',
    })
    expect(lines).toEqual([
      {
        level: 'error',
        message: 'guest agent',
        fields: { code: 'W_HOOK_FAILED', guestSession: 'guest:01', ipHash: 'h-1' },
      },
    ])
  })

  test('a line without a recognisable code is GUEST_AGENT_EVENT; debug and info write nothing', () => {
    const { lines, base } = recorder()
    const log = createGuestLogger(base, context)
    log.info('chatty')
    log.debug('chattier')
    log.warn('something happened', { ip: '10.0.0.9' })
    expect(lines.map((l) => l.fields?.code)).toEqual(['GUEST_AGENT_EVENT'])
    expect(JSON.stringify(lines)).not.toContain('10.0.0.9')
  })
})
