import { expect, test } from 'bun:test'
import type { WorkspaceChangedRecord, WorkspaceOp } from '@keith/contracts'
import { migrateDatabase, openDatabase, workspacesRepo } from '@keith/db'
import { createWorkspaceService } from './workspace.ts'

// The workspace document of each person: read, applied on a base version, announced, isolated per person.

const setup = () => {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  const repo = workspacesRepo(sqlite)
  const announced: { personId: string; record: WorkspaceChangedRecord }[] = []
  const warnings: string[] = []
  const service = createWorkspaceService({
    repo,
    announce: (personId, record) => announced.push({ personId, record }),
    now: () => 1000,
    warn: (m) => warnings.push(m),
  })
  return { repo, service, announced, warnings }
}

const open = (id: string): WorkspaceOp => ({
  op: 'window.open',
  desktopId: 'd1',
  id,
  app: 'web:chat',
  title: id,
})

test('a person starts with one empty desktop at version 0; an apply writes version 1 and announces it', () => {
  const { service, announced } = setup()
  expect(service.get('ana')).toMatchObject({ version: 0, desktops: [{ id: 'd1', windows: [] }] })
  const r = service.apply('ana', { baseVersion: 0, ops: [open('w1')], clientId: 'tab-1' }, 'person')
  expect(r.status).toBe('applied')
  expect(r.doc.version).toBe(1)
  expect(service.get('ana')).toEqual(r.doc)
  expect(announced).toEqual([
    { personId: 'ana', record: { version: 1, ops: [open('w1')], by: 'person', clientId: 'tab-1' } },
  ])
})

test('two applies on the same version: one lands, the other gets the newest document and lands on retry', () => {
  const { service } = setup()
  const a = service.apply('ana', { baseVersion: 0, ops: [open('a')] }, 'person')
  const b = service.apply('ana', { baseVersion: 0, ops: [open('b')] }, 'person')
  expect(a.status).toBe('applied')
  expect(b).toMatchObject({ status: 'conflict', doc: { version: 1 } })
  const retry = service.apply('ana', { baseVersion: b.doc.version, ops: [open('b')] }, 'person')
  expect(retry.status).toBe('applied')
  expect(retry.doc.desktops[0]?.windows.map((w) => w.id)).toEqual(['a', 'b'])
})

test('a refused operation writes nothing and says which one; a no-op writes and announces nothing', () => {
  const { service, announced } = setup()
  const r = service.apply(
    'ana',
    { baseVersion: 0, ops: [open('a'), { op: 'window.close', id: 'x' }] },
    'person',
  )
  expect(r).toMatchObject({
    status: 'refused',
    error: 'unknown-window',
    at: 1,
    doc: { version: 0 },
  })
  const same = service.apply(
    'ana',
    { baseVersion: 0, ops: [{ op: 'desktop.layout', id: 'd1', layout: 'split' }] },
    'person',
  )
  expect(same).toMatchObject({ status: 'applied', doc: { version: 0 } })
  expect(announced).toHaveLength(0)
})

test("each person has their own workspace; Keith's windows are marked as his", () => {
  const { service } = setup()
  service.apply('ana', { baseVersion: 0, ops: [open('a')] }, 'keith')
  expect(service.get('ben').desktops[0]?.windows).toEqual([])
  expect(service.get('ana').desktops[0]?.windows[0]?.openedBy).toBe('keith')
})

test('a stored document that no longer reads starts empty at its version, so the next write lands', () => {
  const { repo, service, warnings } = setup()
  repo.put('ana', 0, 3, '{"version":3,"desktops":"broken"}', 1)
  expect(service.get('ana')).toMatchObject({ version: 3, desktops: [{ id: 'd1' }] })
  expect(warnings).toHaveLength(1)
  expect(service.apply('ana', { baseVersion: 3, ops: [open('a')] }, 'person').doc.version).toBe(4)
})

test("Keith's latest change can be taken back while nothing changed after it", () => {
  const { service, announced } = setup()
  service.apply('ana', { baseVersion: 0, ops: [open('mine')] }, 'person')
  service.apply('ana', { baseVersion: 1, ops: [open('map')] }, 'keith')
  const undone = service.undoKeith('ana')
  expect(undone).toMatchObject({ status: 'applied', doc: { version: 3 } })
  expect(service.get('ana').desktops[0]?.windows.map((w) => w.id)).toEqual(['mine'])
  expect(announced.at(-1)?.record).toEqual({ version: 3, ops: [], by: 'person' })
  expect(service.undoKeith('ana')).toMatchObject({ status: 'refused', error: 'nothing-to-undo' })

  service.apply('ana', { baseVersion: 3, ops: [open('map2')] }, 'keith')
  service.apply('ana', { baseVersion: 4, ops: [{ op: 'window.focus', id: 'mine' }] }, 'person')
  expect(service.undoKeith('ana')).toMatchObject({ status: 'refused', error: 'nothing-to-undo' })
})
