/**
 * Builds the browser app into static files with Bun's HTML bundler (ADR-0012): `index.html` plus
 * hashed JS/CSS assets in `plugins/web/dist/`, which the `@keith/web` plugin serves at `/`.
 * Tailwind runs through `bun-plugin-tailwind` (plugins need the `Bun.build` API, not the CLI).
 *
 * Usage: bun app/build.ts [outdir]   (from plugins/web; `bun run build` does this)
 */
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwind from 'bun-plugin-tailwind'

export const APP_ENTRY = fileURLToPath(new URL('./index.html', import.meta.url))
export const DEFAULT_OUTDIR = fileURLToPath(new URL('../dist', import.meta.url))

export type BuildOptions = { outdir?: string | undefined; minify?: boolean | undefined }

/** Cleans `outdir` and builds the app into it. Throws with the bundler's messages when it fails. */
export async function buildApp(opts: BuildOptions = {}): Promise<{ outdir: string; files: string[] }> {
  const outdir = resolve(opts.outdir ?? DEFAULT_OUTDIR)
  await rm(outdir, { recursive: true, force: true })
  const result = await Bun.build({
    entrypoints: [APP_ENTRY],
    outdir,
    minify: opts.minify ?? true,
    sourcemap: 'linked',
    publicPath: '/',
    target: 'browser',
    plugins: [tailwind],
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  })
  if (!result.success) {
    throw new AggregateError(result.logs, `web app build failed:\n${result.logs.map(String).join('\n')}`)
  }
  return { outdir, files: result.outputs.map((o) => o.path) }
}

if (import.meta.main) {
  const { outdir, files } = await buildApp({ outdir: process.argv[2] })
  console.log(`built ${files.length} files into ${outdir}`)
}
