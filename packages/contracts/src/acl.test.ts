import { describe, expect, test } from 'bun:test'
import {
  ACL_AUDIT_KINDS,
  AclAuditDetailSchemas,
  Bits,
  EntrySchema,
  formatMode,
  formatSubject,
  GroupSchema,
  GUEST_CEILING,
  makeMode,
  modeBits,
  parseMode,
  parseSubject,
  ResourceSchema,
  SubjectSchema,
  VALID_BITS,
} from './index.ts'

describe('mode', () => {
  test('octal, symbolic and classes agree', () => {
    expect(makeMode(6, 4, 0)).toBe(0o640)
    expect(modeBits(0o640, 'owner')).toBe(6)
    expect(modeBits(0o640, 'team')).toBe(4)
    expect(modeBits(0o640, 'other')).toBe(0)
    expect(formatMode(0o640)).toBe('rw-r-----')
    expect(formatMode(0o755)).toBe('rwxr-xr-x')
    for (let mode = 0; mode <= 0o777; mode++) {
      expect(parseMode(formatMode(mode))).toBe(mode)
      expect(parseMode(mode.toString(8).padStart(3, '0'))).toBe(mode)
    }
  })

  test('parseMode refuses anything else', () => {
    for (const bad of ['', '8', '0888', '64', '06400', 'rwxrwxrw', 'rw-r---', 'RW-R-----', '-1']) {
      expect(parseMode(bad)).toBeUndefined()
    }
  })

  test('bits are r=4 w=2 x=1', () => {
    expect(Bits.R | Bits.W | Bits.X).toBe(Bits.ALL)
    expect(Bits.RW).toBe(6)
    expect(Bits.RX).toBe(5)
  })
})

describe('subjects and entries', () => {
  test('parse and format round-trip', () => {
    for (const s of ['user:duta', 'group:friends', '@users', '@public']) {
      const parsed = parseSubject(s)
      expect(parsed).toBeDefined()
      if (parsed !== undefined) expect(formatSubject(parsed)).toBe(s)
    }
  })

  test('a malformed subject is refused', () => {
    for (const bad of [
      '',
      'user:',
      'user:a b',
      'group:',
      '@everyone',
      'users',
      'user:a/b',
      '@users ',
    ]) {
      expect(SubjectSchema.safeParse(bad).success).toBe(false)
    }
  })

  test('an entry needs a subject, bits 0..7 and an effect', () => {
    expect(EntrySchema.safeParse({ subject: 'user:a', bits: 4, effect: 'allow' }).success).toBe(
      true,
    )
    expect(EntrySchema.safeParse({ subject: 'user:a', bits: 8, effect: 'allow' }).success).toBe(
      false,
    )
    expect(EntrySchema.safeParse({ subject: 'user:a', bits: 4, effect: 'maybe' }).success).toBe(
      false,
    )
  })
})

describe('resource and group', () => {
  const base = {
    kind: 'note',
    id: 'n1',
    ownerId: 'duta',
    groupId: null,
    mode: 0o600,
    entries: [],
    createdAt: 1,
    updatedAt: 1,
  }

  test('a resource parses and rejects a bad kind, mode or too many entries', () => {
    expect(ResourceSchema.safeParse(base).success).toBe(true)
    expect(ResourceSchema.safeParse({ ...base, kind: 'Note' }).success).toBe(false)
    expect(ResourceSchema.safeParse({ ...base, mode: 0o1000 }).success).toBe(false)
    const many = Array.from({ length: 65 }, (_, i) => ({
      subject: `user:u${i}`,
      bits: 4,
      effect: 'allow',
    }))
    expect(ResourceSchema.safeParse({ ...base, entries: many }).success).toBe(false)
  })

  test('a group name follows the username shape', () => {
    const g = { id: 'g1', name: 'friends', createdBy: 'owner', createdAt: 1 }
    expect(GroupSchema.safeParse(g).success).toBe(true)
    expect(GroupSchema.safeParse({ ...g, name: 'Friends' }).success).toBe(false)
  })
})

describe('class tables', () => {
  test('a guest never holds write, and the ceiling is inside the valid bits', () => {
    for (const cls of Object.keys(VALID_BITS) as (keyof typeof VALID_BITS)[]) {
      expect(GUEST_CEILING[cls] & Bits.W).toBe(0)
      expect(GUEST_CEILING[cls] & ~VALID_BITS[cls]).toBe(0)
    }
  })

  test('audit kinds are unique and namespaced', () => {
    expect(new Set(ACL_AUDIT_KINDS).size).toBe(ACL_AUDIT_KINDS.length)
    expect(ACL_AUDIT_KINDS.every((k) => k.startsWith('acl.'))).toBe(true)
  })
})

describe('audit detail', () => {
  test('every audit kind has a detail schema, and a schema keeps only its own fields', () => {
    for (const kind of ACL_AUDIT_KINDS) expect(AclAuditDetailSchemas[kind]).toBeDefined()
    const parsed = AclAuditDetailSchemas['acl.remove'].parse({
      kind: 'note',
      id: 'n1',
      title: 'diary',
    })
    expect(parsed).toEqual({ kind: 'note', id: 'n1' })
  })

  test('owner-access lists at most 20 ids', () => {
    const ids = Array.from({ length: 21 }, (_, i) => `n${i}`)
    const base = { kind: 'note', owner: 'duta', bits: 4 }
    expect(
      AclAuditDetailSchemas['acl.owner-access'].safeParse({ ...base, ids, count: 21 }).success,
    ).toBe(false)
    expect(
      AclAuditDetailSchemas['acl.owner-access'].safeParse({
        ...base,
        ids: ids.slice(0, 20),
        count: 21,
      }).success,
    ).toBe(true)
  })
})
