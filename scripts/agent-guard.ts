/**
 * Coding-agent hooks for this repo (wired in .claude/settings.json). Exit code 2 blocks the tool
 * call (or the stop) and shows stderr to the agent.
 *
 *   bun scripts/agent-guard.ts pre-bash    block destructive commands and pushes
 *   bun scripts/agent-guard.ts pre-edit    block edits to generated files and lockfiles
 *   bun scripts/agent-guard.ts post-edit   format and lint the edited file with Biome
 *   bun scripts/agent-guard.ts stop        refuse to stop while `bun run check` fails
 */

import { relative, resolve } from 'node:path'

interface HookInput {
  tool_input?: { command?: string; file_path?: string }
  stop_hook_active?: boolean
}

const BLOCKED_COMMANDS: [RegExp, string][] = [
  // Agents never push or add remotes: the owner pushes and reviews (ADR-0001, public repository amendment).
  [/\bgit\s+push\b/, 'git push is blocked for agents: the owner pushes'],
  [/\bgit\s+remote\s+add\b/, 'git remote add is blocked for agents: the owner manages remotes'],
  [/\bgit\s+reset\s+--hard\b/, 'git reset --hard is blocked: it discards work'],
  [/--no-verify\b/, '--no-verify is blocked: the hooks scan for secrets and lint commits'],
]

const SAFE_RM_TARGET = /^(?:\.\/)?data\/|^\/(?:private\/)?tmp\/|^\/var\/folders\//

/** Reason to block a shell command, or undefined when it may run. */
export function checkCommand(command: string): string | undefined {
  for (const [pattern, reason] of BLOCKED_COMMANDS) if (pattern.test(command)) return reason
  for (const segment of command.split(/&&|\|\||;|\|/)) {
    const words = segment.trim().split(/\s+/)
    if (words[0] !== 'rm') continue
    const flags = words.filter((w) => w.startsWith('-')).join('')
    if (!(flags.includes('r') || flags.includes('R')) || !flags.includes('f')) continue
    const targets = words.slice(1).filter((w) => !w.startsWith('-'))
    if (targets.some((t) => !SAFE_RM_TARGET.test(t))) {
      return 'rm -rf is allowed only under data/ or a temp directory'
    }
  }
  return undefined
}

const PROTECTED_FILES = [
  /(^|\/)bun\.lock$/,
  /(^|\/)drizzle\//,
  /^scripts\/exports\.snapshot\.json$/,
]

/** Reason to block an edit of `path` (relative to the repo root), or undefined. */
export function checkEdit(path: string): string | undefined {
  if (PROTECTED_FILES.some((re) => re.test(path))) {
    return `${path} is generated: regenerate it with its tool instead of editing it`
  }
  return undefined
}

async function readInput(): Promise<HookInput> {
  const text = await Bun.stdin.text()
  return text.trim() === '' ? {} : (JSON.parse(text) as HookInput)
}

function block(reason: string): never {
  console.error(reason)
  process.exit(2)
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..')
  const mode = process.argv[2]
  const input = await readInput()
  const filePath = input.tool_input?.file_path
  const rel = filePath === undefined ? undefined : relative(root, resolve(root, filePath))

  if (mode === 'pre-bash') {
    const reason = checkCommand(input.tool_input?.command ?? '')
    if (reason !== undefined) block(reason)
  } else if (mode === 'pre-edit') {
    const reason = rel === undefined ? undefined : checkEdit(rel)
    if (reason !== undefined) block(reason)
  } else if (mode === 'post-edit') {
    if (rel !== undefined && !rel.startsWith('..') && /\.(?:[cm]?[jt]sx?|json)$/.test(rel)) {
      const proc = Bun.spawnSync(['bunx', 'biome', 'check', '--write', rel], { cwd: root })
      if (proc.exitCode !== 0)
        block(`biome found problems in ${rel}:\n${proc.stdout}${proc.stderr}`)
    }
  } else if (mode === 'stop') {
    if (input.stop_hook_active === true) process.exit(0)
    const proc = Bun.spawnSync(['bun', 'run', 'check'], { cwd: root })
    if (proc.exitCode !== 0) {
      const tail = `${proc.stdout}${proc.stderr}`.split('\n').slice(-40).join('\n')
      block(`bun run check fails; fix it before finishing:\n${tail}`)
    }
  } else {
    block(`agent-guard: unknown mode ${String(mode)}`)
  }
}
