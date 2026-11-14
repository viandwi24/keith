/**
 * Backup and restore steps of the smoke test (docs/specs/backup.md, ADR-0027 §25, P26.2): `keith-core backup` writes a
 * private archive while the core keeps running, and `keith-core restore` puts it back into a fresh data folder. The
 * restored database must open, pass `integrity_check`, and hold data the smoke wrote earlier: the person `ana` and the
 * owner's first chat message ("hello", written by the TUI step). A second restore into the same folder is refused
 * without `--force`; with `--force` the files that were there move to `restore-previous-<stamp>/`, never deleted.
 *
 * The restore target is a fresh folder, not the live one, so the running core is not touched: `restore` only needs the
 * core stopped for the folder it writes into. Plain CLIs and `bun:sqlite` on the files (a Bun built-in): scripts import
 * no workspace package. Temporary folders live in the OS temp folder and are removed with `node:fs`.
 */
import { Database } from 'bun:sqlite'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message)
}

interface Ran {
  code: number
  out: string
}

export interface BackupContext {
  step(name: string, fn: () => Promise<void>): Promise<void>
  run(cmd: string[], env: Record<string, string>): Promise<Ran>
  ok(ran: Promise<Ran>, what: string): Promise<string>
  /** `keith-core` as a command line (the real CLI). */
  coreBin: string[]
  /** The smoke's environment: its own temporary KEITH_DATA_DIR, the fake provider, the port. */
  env: Record<string, string>
  /** The smoke's temporary folder; the restore target is created inside it. */
  tmp: string
  /** The live data folder the running core uses. */
  dataDir: string
}

/** What the smoke can check in a database file: the integrity verdict, ana's id and the owner's first message. */
interface Opened {
  integrity: string | undefined
  anaId: string | undefined
  firstMessages: number
}

function open(file: string): Opened {
  const db = new Database(file, { readonly: true })
  try {
    return {
      integrity: db.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()
        ?.integrity_check,
      anaId: db
        .query<{ id: string }, [string]>('SELECT id FROM people WHERE username = ?')
        .get('ana')?.id,
      firstMessages:
        db
          .query<{ n: number }, [string]>(
            'SELECT count(*) AS n FROM eh_messages WHERE parts LIKE ?',
          )
          .get('%hello%')?.n ?? 0,
    }
  } finally {
    db.close()
  }
}

export async function backupSteps(c: BackupContext): Promise<void> {
  const restored = join(c.tmp, 'restored-home')
  const restoreEnv = { ...c.env, KEITH_DATA_DIR: restored }
  let archive = ''
  let listed: string[] = []

  try {
    // The target folder does not exist yet: `keith-core restore` creates it (a restore into a new folder is the common case).
    await c.step(
      'backup: keith-core backup writes a private, non-empty archive while the core runs',
      async () => {
        const out = await c.ok(c.run([...c.coreBin, 'backup'], c.env), 'backup')
        const printed = /^backup (\S+) \((\d+) bytes\)$/m.exec(out)
        assert(printed !== null, `backup printed no archive path:\n${out}`)
        archive = printed[1] ?? ''
        assert(
          archive.startsWith(join(c.dataDir, 'backups', 'keith-backup-')) &&
            archive.endsWith('.tar'),
          `the archive is not in the default backups folder: ${archive}`,
        )
        assert(existsSync(archive), `the archive does not exist: ${archive}`)
        const info = statSync(archive)
        assert(
          info.size > 0 && info.size === Number(printed[2]),
          `the archive is empty or its size differs`,
        )
        assert(
          (info.mode & 0o777) === 0o600,
          `the archive is mode ${(info.mode & 0o777).toString(8)}, expected 600`,
        )
        listed = (/^includes: (.+)$/m.exec(out)?.[1] ?? '').split(', ').filter((n) => n !== '')
        assert(
          listed.includes('keith.db'),
          `the archive does not include keith.db: ${listed.join(', ')}`,
        )
      },
    )

    await c.step(
      'backup: a restore into a fresh data folder brings back the people and the owner chat',
      async () => {
        const out = await c.ok(c.run([...c.coreBin, 'restore', archive], restoreEnv), 'restore')
        assert(
          out.includes('run keith-core doctor, then keith-core start'),
          `restore did not print the next step:\n${out}`,
        )
        for (const name of listed)
          assert(existsSync(join(restored, name)), `restore did not bring back ${name}`)
        assert(
          (statSync(join(restored, 'keith.db')).mode & 0o777) === 0o600,
          'the restored keith.db is not mode 0600',
        )
        const source = open(join(c.dataDir, 'keith.db'))
        assert(
          source.anaId !== undefined,
          'the live database has no ana: an earlier block did not write her',
        )
        const copy = open(join(restored, 'keith.db'))
        assert(
          copy.integrity === 'ok',
          `the restored database fails integrity_check: ${copy.integrity}`,
        )
        assert(
          copy.anaId === source.anaId,
          'the restored database does not hold ana with the same id',
        )
        assert(
          copy.firstMessages > 0,
          'the restored database holds no owner chat message ("hello")',
        )
      },
    )

    await c.step(
      'backup: restore refuses a folder that holds a database; --force moves the old files aside',
      async () => {
        const refused = await c.run([...c.coreBin, 'restore', archive], restoreEnv)
        assert(
          refused.code !== 0 && refused.out.includes('--force'),
          `a restore over a database was not refused:\n${refused.out}`,
        )
        assert(
          !readdirSync(restored).some((n) => n.startsWith('restore-previous-')),
          'a refused restore moved files',
        )
        const forced = await c.ok(
          c.run([...c.coreBin, 'restore', archive, '--force'], restoreEnv),
          'restore --force',
        )
        assert(
          forced.includes('the files that were there are in'),
          `no moved-aside note:\n${forced}`,
        )
        const moved = readdirSync(restored).find((n) => n.startsWith('restore-previous-'))
        assert(
          moved !== undefined && existsSync(join(restored, moved, 'keith.db')),
          'the old keith.db was not kept in restore-previous-*',
        )
        assert(
          open(join(restored, 'keith.db')).integrity === 'ok',
          'the restored database does not open after --force',
        )
      },
    )
  } finally {
    rmSync(restored, { recursive: true, force: true })
  }
}
