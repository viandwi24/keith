import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../../../..')

/** Keith's version (apps/core/package.json, bumped by Changesets) and short git SHA (`KEITH_BUILD_SHA`, else git). */
export async function buildInfo(
  buildSha: string | undefined,
): Promise<{ version: string; sha: string }> {
  const pkg = (await Bun.file(resolve(import.meta.dir, '../../package.json')).json()) as {
    version?: string
  }
  let sha = buildSha
  if (sha === undefined) {
    const git = await Bun.$`git rev-parse --short HEAD`.cwd(ROOT).quiet().nothrow()
    sha = git.exitCode === 0 ? git.stdout.toString().trim() : 'unknown'
  }
  return { version: pkg.version ?? '0.0.0', sha }
}
