// Removed people's data (ADR-0027 §26, docs/specs/people.md "Removal"): what a removal keeps for 30 days,
// the three built-in parts (memory, workspace, conversations) and the purge after the keep time.
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { Sqlite } from '@keith/db'
import { personWorkspaceDir, workspaceDir } from '../../platform/workspace-paths.ts'
import type { Audit } from '../audit/index.ts'
import { memoryDir } from '../hippocampus/index.ts'
import { PeopleError } from './people.ts'
import {
  createRemovalRegistry,
  type PersonRemovalHooks,
  type RemovalRegistry,
  type RemovalUndo,
} from './removal-registry.ts'

/** Ids that may name a folder (the same rule as the workspace layout). */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

/** A removed person's data is kept this long (`CoreTiming.removedKeepMs`, 30 days by default). */
export const REMOVED_KEEP_MS = 30 * 86_400_000

/** `<dataDir>/workspace/keith/removed`: one folder per removed person, never mounted into a worker. */
export const removedRootOf = (dataDir: string): string =>
  join(workspaceDir(dataDir), 'keith', 'removed')
/** `<dataDir>/workspace/keith/removed/<personId>`. */
export const removedFolderOf = (dataDir: string, personId: string): string =>
  join(removedRootOf(dataDir), personId)

/** `manifest.json` of a kept folder. A folder without a valid one is never purged. */
export interface RemovedManifest {
  personId: string
  username: string | null
  name: string
  removedAt: number
  purgeAt: number
}

export interface KeptPerson {
  id: string
  username: string | null
  name: string
}

/** What `keep` returns: when the data is purged, and how to put it back if the removal fails later. */
export interface KeptData {
  keptUntil: number
  undo(): Promise<void>
}

export interface RemovalService {
  registry: RemovalRegistry
  /**
   * Keep everything registered for the person, in the kept folder. A part that throws refuses the
   * removal: the parts that already ran are undone and the folder is removed, then the error is thrown.
   */
  keep(person: KeptPerson): Promise<KeptData>
  /**
   * Purge every kept folder whose purge time has passed, with a valid manifest. One folder that fails
   * stays for the next tick and is listed in `failed`.
   */
  purge(): Promise<{ purged: string[]; failed: string[] }>
  /** Write every module's part of a person into `dest` (`people export`); see `PersonRemovalHooks.export`. */
  exportData(personId: string, dest: string): Promise<void>
}

export interface RemovalOptions {
  dataDir: string
  /** How long the data is kept (`CoreTiming.removedKeepMs`). */
  keepMs: number
  /** The database holding the conversations (`eh_messages`). */
  sqlite: Sqlite
  audit?: Pick<Audit, 'record'>
  now?: () => number
}

/** Read a folder's manifest; `undefined` for a folder without a valid one. */
export function readRemovedManifest(folder: string): RemovedManifest | undefined {
  try {
    const raw = JSON.parse(
      readFileSync(join(folder, 'manifest.json'), 'utf8'),
    ) as Partial<RemovedManifest>
    if (
      typeof raw.personId !== 'string' ||
      typeof raw.purgeAt !== 'number' ||
      typeof raw.removedAt !== 'number' ||
      typeof raw.name !== 'string'
    )
      return undefined
    return {
      personId: raw.personId,
      username: typeof raw.username === 'string' ? raw.username : null,
      name: raw.name,
      removedAt: raw.removedAt,
      purgeAt: raw.purgeAt,
    }
  } catch {
    return undefined
  }
}

/**
 * The removal service: the registry plus the keep and purge runs. The three built-in parts (memory,
 * workspace, conversations) are registered here; later modules register their own in their wiring.
 */
export function createRemoval(options: RemovalOptions): RemovalService {
  const now = options.now ?? Date.now
  const registry = createRemovalRegistry()
  registry.registerRemoval({ module: 'memory', onPersonRemoved: memoryRemoval(options.dataDir) })
  registry.registerRemoval({
    module: 'workspace',
    onPersonRemoved: workspaceRemoval(options.dataDir),
  })
  registry.registerRemoval({
    module: 'conversations',
    onPersonRemoved: conversationRemoval(options.sqlite, options.dataDir),
  })

  return {
    registry,
    async keep(person) {
      if (!SAFE_ID.test(person.id))
        throw new PeopleError('BAD_REQUEST', `${person.id} cannot name a folder`)
      const folder = removedFolderOf(options.dataDir, person.id)
      if (existsSync(folder))
        throw new PeopleError('CONFLICT', `the data of ${person.id} is already kept`)
      for (const { onPersonRemoved } of registry.registrations())
        await onPersonRemoved.stop?.(person.id)
      const removedAt = now()
      const keptUntil = removedAt + options.keepMs
      const undos: RemovalUndo[] = []
      const undo = async (): Promise<void> => {
        for (const run of undos.reverse()) await run()
        rmSync(folder, { recursive: true, force: true })
      }
      mkdirSync(folder, { recursive: true, mode: 0o700 })
      try {
        const manifest: RemovedManifest = {
          personId: person.id,
          username: person.username,
          name: person.name,
          removedAt,
          purgeAt: keptUntil,
        }
        writeFileSync(join(folder, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
          mode: 0o600,
        })
        for (const { onPersonRemoved } of registry.registrations()) {
          const run = await onPersonRemoved.keep(person.id, folder)
          if (typeof run === 'function') undos.push(run)
        }
      } catch (error) {
        await undo()
        throw error
      }
      return { keptUntil, undo }
    },
    async exportData(personId, dest) {
      for (const { onPersonRemoved } of registry.registrations())
        await onPersonRemoved.export(personId, dest)
    },
    async purge() {
      const root = removedRootOf(options.dataDir)
      const result = { purged: [] as string[], failed: [] as string[] }
      if (!existsSync(root)) return result
      for (const name of readdirSync(root)) {
        const folder = join(root, name)
        const manifest = readRemovedManifest(folder)
        if (manifest === undefined || manifest.personId !== name || manifest.purgeAt > now())
          continue
        try {
          for (const { onPersonRemoved } of registry.registrations())
            await onPersonRemoved.purge(name, folder)
          rmSync(folder, { recursive: true, force: true })
          options.audit?.record({
            kind: 'person.removed.purged',
            actor: 'system',
            via: 'local',
            detail: { person: name, subject: name },
          })
          result.purged.push(name)
        } catch {
          result.failed.push(name)
        }
      }
      return result
    },
  }
}

/**
 * Where a person's part is read from for an export: the kept folder once the person is removed (nothing
 * else is looked at then), else the live folder. `undefined` when there is nothing to read.
 */
function sourceOf(
  dataDir: string,
  personId: string,
  kept: string,
  live: string,
): string | undefined {
  const folder = removedFolderOf(dataDir, personId)
  if (existsSync(join(folder, 'manifest.json'))) {
    const path = join(folder, kept)
    return existsSync(path) ? path : undefined
  }
  return existsSync(live) ? live : undefined
}

/** Memory: `memory/<id>` moves into the kept folder; purge is the folder removal itself. */
export function memoryRemoval(dataDir: string): PersonRemovalHooks {
  return {
    keep(personId, folder) {
      const from = memoryDir(dataDir, personId)
      if (!existsSync(from)) return undefined
      const to = join(folder, 'memory')
      renameSync(from, to)
      return () => void renameSync(to, from)
    },
    export(personId, dest) {
      const from = sourceOf(dataDir, personId, 'memory', memoryDir(dataDir, personId))
      if (from !== undefined) cpSync(from, join(dest, 'memory'), { recursive: true })
    },
    purge() {},
  }
}

/** Workspace: `workspace/people/<id>` moves into the kept folder (no worker mounts it any more). */
export function workspaceRemoval(dataDir: string): PersonRemovalHooks {
  return {
    keep(personId, folder) {
      const from = personWorkspaceDir(dataDir, personId)
      if (!existsSync(from)) return undefined
      const to = join(folder, 'workspace')
      renameSync(from, to)
      return () => void renameSync(to, from)
    },
    export(personId, dest) {
      const from = sourceOf(dataDir, personId, 'workspace', personWorkspaceDir(dataDir, personId))
      if (from !== undefined) cpSync(from, join(dest, 'workspace'), { recursive: true })
    },
    purge() {},
  }
}

/** One stored message as `conversation.jsonl` holds it. */
export interface StoredMessage {
  session_id: string
  id: string
  role: string
  parts: string
  metadata: string | null
  created_at: number
}

/** The sessions of a person: the front session `front:<id>` and the workers under it (`front:<id>:...`). */
const sessionFilter = (personId: string) => {
  const front = `front:${personId}`
  return {
    where: '(session_id = ? OR substr(session_id, 1, ?) = ?)',
    args: [front, front.length + 1, `${front}:`],
  }
}

/** The stored messages of a person's sessions, in order. */
export function messagesOf(sqlite: Sqlite, personId: string): StoredMessage[] {
  const filter = sessionFilter(personId)
  return sqlite
    .query(
      `SELECT session_id, id, role, parts, metadata, created_at FROM eh_messages WHERE ${filter.where} ORDER BY session_id, id`,
    )
    .all(...filter.args) as StoredMessage[]
}

const jsonl = (rows: StoredMessage[]): string =>
  rows.map((row) => `${JSON.stringify(row)}\n`).join('')

/**
 * Conversations: the messages of the person's sessions are written to `conversation.jsonl`, one stored
 * message per line, and their rows are deleted in the same call. Undo puts the rows back and removes the file.
 * An export reads the file once the person is removed, else the rows.
 */
export function conversationRemoval(sqlite: Sqlite, dataDir: string): PersonRemovalHooks {
  return {
    keep(personId, folder) {
      const rows = messagesOf(sqlite, personId)
      const file = join(folder, 'conversation.jsonl')
      writeFileSync(file, jsonl(rows), { mode: 0o600 })
      chmodSync(file, 0o600)
      const filter = sessionFilter(personId)
      sqlite.query(`DELETE FROM eh_messages WHERE ${filter.where}`).run(...filter.args)
      return () => {
        if (existsSync(file)) unlinkSync(file)
        sqlite.transaction(() => {
          const insert = sqlite.query(
            'INSERT OR IGNORE INTO eh_messages (session_id, id, role, parts, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          for (const r of rows)
            insert.run(r.session_id, r.id, r.role, r.parts, r.metadata, r.created_at)
        })()
      }
    },
    export(personId, dest) {
      const target = join(dest, 'conversation.jsonl')
      if (existsSync(join(removedFolderOf(dataDir, personId), 'manifest.json'))) {
        const kept = join(removedFolderOf(dataDir, personId), 'conversation.jsonl')
        if (existsSync(kept)) copyFileSync(kept, target)
        return
      }
      writeFileSync(target, jsonl(messagesOf(sqlite, personId)), { mode: 0o600 })
    },
    purge() {},
  }
}
