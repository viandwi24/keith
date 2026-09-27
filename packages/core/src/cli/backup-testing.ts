// Test helpers for cli/backup.test.ts and cli/restore.test.ts: temp homes, a running Keith on the
// fake LLM, and seed rows.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeLlm, createFakeLlmPlugin } from '@keith/sdk/testing'
import { createOwner, createTestHome, quietLogger, testClock } from '../../test/helpers.ts'
import { bootstrap, type Keith } from '../bootstrap.ts'
import { createIds } from '../shared/index.ts'
import type { MemoryId, MessageId, PersonId, ReminderId, ThreadId } from '../shared/types.ts'
import type { CliIo } from './index.ts'

export type Cleanups = (() => Promise<void> | void)[]

/** A temp folder, removed by the cleanups. */
export function tempDir(cleanups: Cleanups, prefix = 'keith-backup-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A home with the fake-LLM config and the owner, not started. */
export async function ownerHome(cleanups: Cleanups): Promise<{ home: string; owner: PersonId }> {
  const home = await createTestHome()
  cleanups.push(() => home.remove())
  const owner = await createOwner(home.dir, testClock())
  return { home: home.dir, owner }
}

export async function startKeith(home: string, cleanups: Cleanups): Promise<Keith> {
  const clock = testClock()
  const keith = await bootstrap({
    home,
    env: {},
    plugins: [createFakeLlmPlugin(createFakeLlm())],
    clock,
    log: quietLogger(clock),
  })
  cleanups.push(() => keith.stop())
  return keith
}

export type Seeded = { threadId: ThreadId; messageId: MessageId; memoryId: MemoryId; reminderId: ReminderId }

/** A thread with one message, one memory and one pending reminder (due in a day), owned by `owner`. */
export async function seed(keith: Keith, owner: PersonId): Promise<Seeded> {
  const clock = testClock()
  const ids = createIds({ clock })
  const threadId = ids.next('thr')
  const messageId = ids.next('msg')
  const memoryId = ids.next('mem')
  const reminderId = ids.next('rem')
  const at = clock.now()
  await keith.repos.threads.create(
    {
      id: threadId,
      kind: 'direct',
      slug: 'garden',
      title: 'Garden',
      ownerPersonId: owner,
      summary: null,
      createdAt: at,
      updatedAt: at,
    },
    [owner],
  )
  await keith.repos.messages.append({
    id: messageId,
    threadId,
    role: 'user',
    authorPersonId: owner,
    nodeId: null,
    modality: 'text',
    content: 'Plant the tomatoes in May.',
    meta: null,
    createdAt: at,
  })
  await keith.repos.memories.create({
    id: memoryId,
    content: 'Tony grows tomatoes',
    subjectPersonId: owner,
    visibility: 'household',
    threadId: null,
    source: 'stated',
    authorPersonId: owner,
    pinned: false,
    createdAt: at,
    updatedAt: at,
    lastRecalledAt: null,
  })
  await keith.repos.reminders.create({
    id: reminderId,
    personId: owner,
    threadId,
    text: 'Water the tomatoes',
    dueAt: at + 86_400_000,
    status: 'pending',
    createdAt: at,
    firedAt: null,
    cancelledAt: null,
    deliveryId: null,
  })
  return { threadId, messageId, memoryId, reminderId }
}

export function cliIo(home: string): CliIo & { lines: string[]; errors: string[] } {
  const lines: string[] = []
  const errors: string[] = []
  return {
    env: { KEITH_HOME: home },
    out: (l) => lines.push(l),
    err: (l) => errors.push(l),
    clock: testClock(),
    lines,
    errors,
  }
}
