import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { NodeId, PersonDto } from '@keith/protocol'
import { z } from 'zod'
import { TuiError } from './errors.ts'

/**
 * What the TUI remembers between runs, in `$XDG_CONFIG_HOME/keith/tui.json` (mode 600).
 * The token is a secret: the file is never world or group readable.
 */
export const StoredSession = z.object({
  url: z.string().min(1),
  token: z.string().min(1),
  person: PersonDto,
  expiresAt: z.number().int().nonnegative(),
  /** Issued by the core on the first `welcome` and sent back in later `hello`s. */
  nodeId: NodeId.optional(),
})
export type StoredSession = z.infer<typeof StoredSession>

export type Env = Readonly<Record<string, string | undefined>>

/** `$XDG_CONFIG_HOME/keith/tui.json`, or `~/.config/keith/tui.json` when the variable is unset. */
export function sessionFilePath(env: Env): string {
  const xdg = env.XDG_CONFIG_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(env.HOME ?? homedir(), '.config')
  return join(base, 'keith', 'tui.json')
}

/** Reads the stored session. Returns null when there is none or it is unreadable. */
export async function loadSession(path: string): Promise<StoredSession | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isNotFound(error)) return null
    throw new TuiError('CONFIG_INVALID', `cannot read ${path}`, { cause: error })
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    // A corrupt file is treated as "not signed in"; the next login overwrites it.
    return null
  }
  const parsed = StoredSession.safeParse(json)
  return parsed.success ? parsed.data : null
}

/** Writes the session atomically with file mode 600 (the directory gets 700). */
export async function saveSession(path: string, session: StoredSession): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 })
  // `mode` is filtered by the umask; chmod makes 600 exact.
  await chmod(tmp, 0o600)
  await rename(tmp, path)
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
