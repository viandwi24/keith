import { describe, expect, test } from 'bun:test'
import { AUDIT_SUBJECT_FIELDS } from './audit.ts'

describe('audit subject fields of the shared rooms', () => {
  test('the owner read of a room and the owner end name the initiator and every active member', () => {
    // `members` holds person ids (never text): the reader matches one id inside the array
    expect(AUDIT_SUBJECT_FIELDS['room.read']).toEqual(['owner', 'members'])
    expect(AUDIT_SUBJECT_FIELDS['room.owner-end']).toEqual(['subject', 'members'])
  })
})
