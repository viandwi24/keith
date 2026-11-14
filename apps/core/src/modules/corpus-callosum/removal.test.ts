import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AUDIT_SUBJECT_FIELDS } from '@keith/contracts'
import { mySummaryKinds } from '../audit/index.ts'
import { removedFolderOf } from '../people/index.ts'
import { as, roomWorld } from './fixtures.ts'
import { ROOMS_FILE, roomsOnIdentityChanged, roomsRemoval } from './removal.ts'

// The rooms' share of a removed person (ADR-0027 §26, P30.2.4): keep, export, purge through the removal registry, the
// suspension listener, and the audit registry of every `room.*` kind (`mine.test.ts` checks the whole registry).

let dataDir = ''
let w: ReturnType<typeof roomWorld>

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'keith-rooms-rm-'))
  w = roomWorld(dataDir)
})
afterAll(() => {
  if (dataDir !== '') rmSync(dataDir, { recursive: true, force: true })
})

/** Ana starts a room with Bob and Cy; Bob accepts; Cy is still invited. Returns the room id. */
async function sampleRoom(): Promise<string> {
  const started = await w.svc.start(as('ana'), { invite: ['bob', 'cy'] })
  w.svc.accept(as('bob'), started.room.id)
  w.rooms.appendEvent({
    roomId: started.room.id,
    at: w.now(),
    kind: 'say',
    speaker: 'bob',
    text: 'hi',
  })
  return started.room.id
}

const hooksOf = () => roomsRemoval({ service: w.svc, acl: w.roomAcl, sqlite: w.sqlite, dataDir })

describe('keep', () => {
  test('ends the active membership as removed, declines the invitation, and writes the dump into the kept folder', async () => {
    const roomId = await sampleRoom()
    const folder = join(dataDir, 'kept-bob')
    mkdirSync(folder, { recursive: true })
    await hooksOf().keep?.('bob', folder)
    expect(w.rooms.member(roomId, 'bob')?.status).toBe('removed')
    expect(w.rooms.member(roomId, 'bob')?.leaveReason).toBe('removed')
    expect(w.rooms.eventsForOwner(roomId, 0, 100).at(-1)).toMatchObject({
      kind: 'remove',
      speaker: 'bob',
    })
    const dump = JSON.parse(readFileSync(join(folder, ROOMS_FILE), 'utf8'))
    expect(dump.personId).toBe('bob')
    expect(dump.memberships.map((m: { room_id: string }) => m.room_id)).toEqual([roomId])
    expect(dump.lines.filter((l: { kind: string }) => l.kind === 'say')).toMatchObject([
      { text: 'hi', speaker: 'bob' },
    ])
  })

  test('an undo puts the membership, the room and the rows back and removes the rows keep wrote', async () => {
    const roomId = await sampleRoom()
    const before = w.rooms.eventsForOwner(roomId, 0, 100).length
    const folder = join(dataDir, 'kept-undo')
    mkdirSync(folder, { recursive: true })
    const undo = await hooksOf().keep?.('bob', folder)
    expect(w.rooms.member(roomId, 'bob')?.status).toBe('removed')
    await undo?.()
    expect(w.rooms.member(roomId, 'bob')).toMatchObject({ status: 'active', leftAt: null })
    expect(w.rooms.eventsForOwner(roomId, 0, 100)).toHaveLength(before)
    expect(w.rooms.get(roomId)?.state).toBe('active')
    expect(w.roomAcl.canWrite({ kind: 'user', id: 'bob', role: 'member' }, roomId)).toBe(true)
  })

  test('a room that keep ends (its last active member) is put back by the undo', async () => {
    const started = await w.svc.start(as('ana'), { invite: [] })
    const roomId = started.room.id
    const folder = join(dataDir, 'kept-last')
    mkdirSync(folder, { recursive: true })
    const undo = await hooksOf().keep?.('ana', folder)
    expect(w.rooms.get(roomId)).toMatchObject({ state: 'ended', endReason: 'empty' })
    await undo?.()
    expect(w.rooms.get(roomId)).toMatchObject({ state: 'open', endReason: null })
    expect(w.rooms.member(roomId, 'ana')?.status).toBe('active')
  })
})

describe('export', () => {
  test('a live person: the rows as they are now go into the export folder', async () => {
    await sampleRoom()
    const dest = join(dataDir, 'export-bob')
    await hooksOf().export?.('bob', dest)
    const dump = JSON.parse(readFileSync(join(dest, ROOMS_FILE), 'utf8'))
    expect(dump.personId).toBe('bob')
    expect(dump.lines.filter((l: { kind: string }) => l.kind === 'say')).toHaveLength(1)
  })

  test('a removed person: the kept dump is copied, the live rows are not read', async () => {
    const roomId = await sampleRoom()
    const folder = removedFolderOf(dataDir, 'bob')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'manifest.json'), '{}')
    writeFileSync(join(folder, ROOMS_FILE), JSON.stringify({ personId: 'bob', kept: roomId }))
    const dest = join(dataDir, 'export-removed')
    await hooksOf().export?.('bob', dest)
    expect(JSON.parse(readFileSync(join(dest, ROOMS_FILE), 'utf8'))).toEqual({
      personId: 'bob',
      kept: roomId,
    })
  })

  test('a person with no room rows writes nothing', async () => {
    const dest = join(dataDir, 'export-nobody')
    await hooksOf().export?.('dee', dest)
    expect(existsSync(join(dest, ROOMS_FILE))).toBe(false)
  })
})

describe('purge', () => {
  test('deletes the member rows; the transcript stays with the room', async () => {
    const roomId = await sampleRoom()
    const before = w.rooms.eventsForOwner(roomId, 0, 100).length
    await hooksOf().purge?.('bob', '')
    expect(w.rooms.member(roomId, 'bob')).toBeUndefined()
    expect(w.rooms.eventsForOwner(roomId, 0, 100)).toHaveLength(before)
  })
})

describe('suspension listener', () => {
  test('a suspension ends the person memberships with reason suspended; other changes do nothing', async () => {
    const roomId = await sampleRoom()
    const listener = roomsOnIdentityChanged(w.svc)
    listener({ personId: 'bob', reason: 'remove' })
    expect(w.rooms.member(roomId, 'bob')?.status).toBe('active')
    listener({ personId: 'bob', reason: 'suspend' })
    expect(w.rooms.member(roomId, 'bob')?.status).toBe('removed')
    expect(w.audit.at(-1)).toMatchObject({
      kind: 'room.remove',
      actor: 'system',
      detail: { roomId, subject: 'bob', reason: 'suspended' },
    })
  })
})

describe('audit registry', () => {
  test('every room.* kind has a subject field and a summary for the person it names', () => {
    const kinds = [
      'room.create',
      'room.invite',
      'room.accept',
      'room.decline',
      'room.leave',
      'room.remove',
      'room.end',
      'room.owner-end',
      'room.read',
      'room.handoff',
      'room.post',
      'room.turn.refused',
    ]
    for (const kind of kinds) {
      expect(AUDIT_SUBJECT_FIELDS[kind]).toBeDefined()
      expect(mySummaryKinds()).toContain(kind)
    }
    expect(AUDIT_SUBJECT_FIELDS['room.read']).toEqual(['owner', 'members'])
    expect(AUDIT_SUBJECT_FIELDS['room.turn.refused']).toEqual(['speaker'])
  })

  test('the kinds the service writes are all registered', async () => {
    const roomId = await sampleRoom()
    await w.svc.end(as('ana'), roomId)
    const written = new Set(w.audit.map((a) => a.kind))
    for (const kind of written) {
      expect(AUDIT_SUBJECT_FIELDS[kind]).toBeDefined()
      expect(mySummaryKinds()).toContain(kind)
    }
  })
})
