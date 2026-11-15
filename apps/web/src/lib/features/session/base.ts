import { resolve } from '$app/paths'

// the route ids are typed, and `/` is not one of them for this typing: ask with a plain string
const resolvePath = resolve as unknown as (path: string) => string

/** The base path of the app (`/app`, from `paths.base` in vite.config.ts), without a trailing slash. SvelteKit 3 has no `base` export. */
export const appBase = (): string => resolvePath('/').replace(/\/+$/, '')
