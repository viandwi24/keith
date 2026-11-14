// The shared harness of the dreaming service tests (service*.test.ts): a fresh in-memory database and a per-test temp dataDir, a
// judge that keeps every candidate as a short-term fact (so the files show what the applier did), the service factory, and the
// helpers that plant chat messages and read the memory files. serviceKit() registers the beforeEach/afterEach hooks in the file that
// calls it; each file reads the live state through the object it returns (kit.repo, kit.clock, kit.audits, ...).
import { afterEach, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type DreamingRepo,
  dreamingRepo,
  migrateDatabase,
  openDatabase,
  type Sqlite,
} from '@keith/db'
import { frontSessionId } from '../../../platform/sessions.ts'
import type { Audit } from '../../audit/index.ts'
import { PROFILE_TIER, RECENT_TIER, readMemoryFile } from './files.ts'
import type { JudgeResult } from './judge.ts'
import type { JudgeCandidate } from './prompt.ts'
import { createDreamService, type DreamService } from './service.ts'

export const PERSON = 'ana'
export const OTHER = 'bob'
export const T0 = Date.UTC(2026, 10, 11, 3)
export const SECRET_WORD = 'PLANTED-WORD'
export const DAY = 365 * 24 * 60 * 60 * 1000

/** A judge that keeps every candidate as a short-term fact of recent.md with the candidate's own source pointer. */
export const keepJudge = async (
  _personId: string,
  candidates: readonly JudgeCandidate[],
): Promise<JudgeResult> => ({
  ok: true,
  plan: {
    candidates: candidates.map((c) => ({
      id: c.id,
      action: 'keep-short-term' as const,
      target: 'recent',
      text: c.text,
      reason: 'said today',
      importance: 3,
      sourceMessageId: c.messageId,
    })),
  },
})

export function serviceKit() {
  let messageSeq = 0

  const kit = {
    dataDir: '',
    sqlite: undefined as unknown as Sqlite,
    repo: undefined as unknown as DreamingRepo,
    clock: T0,
    audits: [] as { kind: string; actor: string; via: string; detail?: Record<string, unknown> }[],
    events: [] as { sessionId: string | null; type: string; payload: Record<string, unknown> }[],

    audit: {
      record(event) {
        kit.audits.push(event)
      },
    } satisfies Audit,

    service(overrides: Partial<Parameters<typeof createDreamService>[0]> = {}): DreamService {
      return createDreamService({
        dataDir: kit.dataDir,
        sqlite: kit.sqlite,
        repo: kit.repo,
        generations: { current: () => 0 },
        owner: { isOwner: async () => false },
        settings: () => ({ maxUsdPerRun: 0.05, memberDefault: 'off' }),
        judge: keepJudge,
        audit: kit.audit,
        activity: {
          record(sessionId, type, payload) {
            kit.events.push({ sessionId, type, payload })
          },
        },
        now: () => kit.clock,
        ...overrides,
      })
    },

    /** Plants user messages in the person's front session (the table eharness writes). */
    plant(texts: string[]): void {
      const stmt = kit.sqlite.query(
        'INSERT INTO eh_messages (session_id, id, role, parts, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      for (const text of texts) {
        messageSeq += 1
        stmt.run(
          frontSessionId(PERSON, 0),
          `m${String(messageSeq).padStart(4, '0')}`,
          'user',
          JSON.stringify([{ type: 'text', text }]),
          JSON.stringify({ eharness: { v: 1, createdAt: kit.clock } }),
          kit.clock,
        )
      }
    },

    recent: () => readMemoryFile(kit.dataDir, PERSON, RECENT_TIER),
    profile: () => readMemoryFile(kit.dataDir, PERSON, PROFILE_TIER),
  }

  beforeEach(() => {
    kit.dataDir = mkdtempSync(join(tmpdir(), 'keith-dream-service-'))
    kit.sqlite = openDatabase(':memory:')
    migrateDatabase(kit.sqlite)
    kit.clock = T0
    kit.repo = dreamingRepo(kit.sqlite, { now: () => kit.clock })
    kit.audits = []
    kit.events = []
    messageSeq = 0
  })

  afterEach(() => {
    kit.sqlite.close()
    rmSync(kit.dataDir, { recursive: true, force: true })
  })

  return kit
}
