/**
 * Clones the eharness repo into `.ref/eharness` at the tag of the version pinned in the
 * workspace catalog, so agents can read its specs and examples (the npm package has `dist` only).
 *
 * The commit the tag names is recorded in `scripts/ref-pin.json` (committed; `tag` is readable, `commit`
 * is the full SHA). Every sync checks that the checkout is that commit. A tag that moved upstream stops the
 * sync with an explanation; `--update` accepts the move and rewrites the pin. The first sync with no pin
 * file records the commit the tag names now (trust on first use: check it when you commit the pin).
 *
 *   bun run ref:sync
 *   bun run ref:sync -- --update
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO = 'https://github.com/viandwi24/eharness'
/** The committed pin, relative to the repo root. */
export const PIN_FILE = 'scripts/ref-pin.json'

export interface RefPin {
  /** The tag, e.g. `eharness@0.12.0`. */
  tag: string
  /** The full 40-character commit the tag named when the pin was written. */
  commit: string
}

/** The eharness version pinned in `workspaces.catalog`. */
export function catalogVersion(pkg: { workspaces?: { catalog?: Record<string, string> } }): string {
  const version = pkg.workspaces?.catalog?.eharness
  if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`workspaces.catalog.eharness must be an exact version, got ${String(version)}`)
  }
  return version
}

/** True when `.gitignore` ignores `.ref/` (so the clone can never be committed). */
export function ignoresRef(gitignore: string): boolean {
  return gitignore.split('\n').some((line) => /^\/?\.ref\/?$/.test(line.trim()))
}

/** The git commands that bring `.ref/eharness` to the tag, given whether it already exists. */
export function syncCommands(version: string, exists: boolean): string[][] {
  const tag = `eharness@${version}`
  if (!exists) return [['git', 'clone', '--depth', '1', '--branch', tag, REPO, '.ref/eharness']]
  // fetch from REPO itself (not the clone's origin) and force the tag: a tag moved upstream is fetched, not refused
  return [
    [
      'git',
      '-C',
      '.ref/eharness',
      'fetch',
      '--depth',
      '1',
      '--force',
      REPO,
      `+refs/tags/${tag}:refs/tags/${tag}`,
    ],
    ['git', '-C', '.ref/eharness', 'checkout', '--quiet', tag],
  ]
}

/** The `git ls-remote` arguments that list the tag and its peeled commit. */
export function lsRemoteArgs(version: string): string[] {
  const ref = `refs/tags/eharness@${version}`
  return ['git', 'ls-remote', REPO, ref, `${ref}^{}`]
}

const SHA = /^[0-9a-f]{40}$/

/**
 * The commit a tag names, from the `ls-remote` output. An annotated tag lists its tag object and, on a
 * second line, the peeled commit (`^{}`): the commit wins.
 */
export function commitOfTag(lsRemote: string, tag: string): string {
  const rows = lsRemote
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length === 2)
  const ref = `refs/tags/${tag}`
  const sha = (rows.find(([, name]) => name === `${ref}^{}`) ??
    rows.find(([, name]) => name === ref))?.[0]
  if (sha === undefined || !SHA.test(sha)) throw new Error(`the tag ${tag} was not found upstream`)
  return sha
}

/** The pin file's text, read as a pin. Throws on anything that is not a tag and a full SHA. */
export function parsePin(text: string): RefPin {
  const data: unknown = JSON.parse(text)
  const { tag, commit } = (data ?? {}) as Partial<Record<keyof RefPin, unknown>>
  if (typeof tag !== 'string' || typeof commit !== 'string' || !SHA.test(commit))
    throw new Error(`${PIN_FILE} must hold a "tag" and a full 40-character "commit"`)
  return { tag, commit }
}

/** The explanation for a tag that moved upstream since the pin was written. */
export function movedMessage(tag: string, pinned: string, upstream: string): string {
  return [
    `${tag} moved upstream: ${PIN_FILE} records ${pinned}, the tag now names ${upstream}.`,
    `A release tag should not move: check ${REPO}/releases before you accept it.`,
    'If the move is intended, run `bun run ref:sync -- --update` to rewrite the pin.',
  ].join('\n')
}

/**
 * The pin a sync records, given the pin on disk (if any), the commit the tag names upstream and the commit
 * the checkout is at. Throws when the checkout is not the tag's commit, or when the pin for this tag differs
 * from the checkout and `--update` was not given.
 */
export function nextPin(
  tag: string,
  pin: RefPin | undefined,
  upstream: string,
  head: string,
  update: boolean,
): RefPin {
  if (head !== upstream)
    throw new Error(`the checkout is at ${head}, but ${tag} names ${upstream}: run ref:sync again`)
  if (pin !== undefined && pin.tag === tag && pin.commit !== head && !update)
    throw new Error(movedMessage(tag, pin.commit, upstream))
  return { tag, commit: head }
}

function git(args: string[], cwd: string): { code: number; stdout: string } {
  const proc = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'inherit' })
  return { code: proc.exitCode ?? 1, stdout: proc.stdout.toString().trim() }
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..')
  const update = process.argv.slice(2).includes('--update')
  // The annotation on the binding (not only on the arrow) lets control-flow analysis see that `fail` never returns.
  const fail: (message: string) => never = (message) => {
    console.error(`ref:sync: ${message}`)
    process.exit(1)
  }
  const gitignore = Bun.file(resolve(root, '.gitignore'))
  if (!(await gitignore.exists()) || !ignoresRef(await gitignore.text())) {
    fail('refuses to run: add `.ref/` to .gitignore first')
  }
  const version = catalogVersion(await Bun.file(resolve(root, 'package.json')).json())
  const tag = `eharness@${version}`
  const pinPath = resolve(root, PIN_FILE)
  const pin = existsSync(pinPath) ? parsePin(readFileSync(pinPath, 'utf8')) : undefined

  const listed = git(lsRemoteArgs(version).slice(1), root)
  if (listed.code !== 0) fail(`cannot reach ${REPO} (git ls-remote failed)`)
  const upstream = commitOfTag(listed.stdout, tag)
  if (pin !== undefined && pin.tag === tag && pin.commit !== upstream && !update)
    fail(movedMessage(tag, pin.commit, upstream))

  const dir = '.ref/eharness'
  for (const cmd of syncCommands(version, existsSync(resolve(root, dir)))) {
    const proc = Bun.spawnSync(cmd, { cwd: root, stdout: 'inherit', stderr: 'inherit' })
    if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1)
  }
  const head = git(['-C', dir, 'rev-parse', 'HEAD'], root).stdout
  let next: RefPin
  try {
    next = nextPin(tag, pin, upstream, head, update)
  } catch (error) {
    fail((error as Error).message)
  }
  if (pin?.tag !== next.tag || pin?.commit !== next.commit) {
    writeFileSync(pinPath, `${JSON.stringify(next, null, 2)}\n`)
    console.log(
      `${PIN_FILE}: ${pin === undefined ? 'recorded' : 'rewritten to'} ${next.tag} ${next.commit}`,
    )
  }
  console.log(`${dir} is at ${tag} (${head})`)
}
