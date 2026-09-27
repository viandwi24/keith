/**
 * `@keith/web`: a `client-app` plugin that makes the core serve the browser app at `/`.
 *
 * The browser app (`plugins/web/app/`, a Node per ADR-0011) builds to `plugins/web/dist/`. This
 * server half never imports it: it only mounts the built output as static files with an SPA
 * fallback. The browser then talks to the core through the public `/v1` protocol like any Node (I-8).
 */
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { definePlugin } from '@keith/sdk'
import { z } from 'zod'

/** The app's entry file, also the SPA fallback for client-side routes. */
export const WEB_ENTRY = 'index.html'

/** Where the browser app's build lands by default: `plugins/web/dist/`, next to this package. */
export const DEFAULT_DIST_DIR = fileURLToPath(new URL('../dist', import.meta.url))

/** A tiny page served when the app has no build output, so the core keeps running without it. */
export const PLACEHOLDER_DIR = fileURLToPath(new URL('./placeholder', import.meta.url))

export const webConfig = z.object({
  /** Overrides the built app's folder. A relative path resolves against the core's working directory. */
  distDir: z.string().min(1).optional(),
})

export type WebConfig = z.output<typeof webConfig>

const isFile = (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() === true

/** Picks the folder to serve: the configured or default dist dir when it has an entry file, else the placeholder. */
export function resolveWebRoot(config: WebConfig): { dir: string; built: boolean; distDir: string } {
  const distDir = config.distDir === undefined ? DEFAULT_DIST_DIR : resolve(config.distDir)
  const built = isFile(resolve(distDir, WEB_ENTRY))
  return { dir: built ? distDir : PLACEHOLDER_DIR, built, distDir }
}

export default definePlugin({
  id: '@keith/web',
  namespace: 'web',
  version: '0.0.0',
  kind: 'client-app',
  config: webConfig,
  setup(ctx) {
    const root = resolveWebRoot(ctx.config)
    if (!root.built) {
      ctx.log.warn('web app is not built; serving a placeholder page at /', {
        distDir: root.distDir,
        missing: resolve(root.distDir, WEB_ENTRY),
      })
    }
    ctx.http.static('/', root.dir, { spaFallback: WEB_ENTRY })
  },
})
