// The four languages `sandbox.run` runs, the image each one uses and the command that runs the code
// (docs/specs/node-drivers.md, "Driver sandbox"). The defaults are pinned by tag here: the manifest schema of
// driver-sdk is strict, so keith-driver.json cannot carry them.
/** The languages `sandbox.run` takes: one image and one command each (the contract's `SandboxRunInputSchema` enum). */
export const IMAGE_LANGUAGES = ['sh', 'python', 'node', 'bun'] as const
export type ImageLanguage = (typeof IMAGE_LANGUAGES)[number]

export const DEFAULT_IMAGES: Readonly<Record<ImageLanguage, string>> = {
  sh: 'alpine:3.20',
  python: 'python:3.12-alpine',
  node: 'node:22-alpine',
  bun: 'oven/bun:1.2-alpine',
}

/**
 * The program and the flag that takes the code as its argument. The entrypoint is set with `--entrypoint`, so an
 * image's own entrypoint never runs.
 */
export const LANGUAGE_COMMAND: Readonly<Record<ImageLanguage, readonly [string, string]>> = {
  sh: ['sh', '-c'],
  python: ['python', '-c'],
  node: ['node', '-e'],
  bun: ['bun', '-e'],
}

/** A Docker or Podman image reference: lowercase name, optional registry, tag or digest. */
export const IMAGE_REF_PATTERN = /^[a-z0-9][a-z0-9._/:@-]{0,199}$/

export const isImageLanguage = (value: unknown): value is ImageLanguage =>
  typeof value === 'string' && (IMAGE_LANGUAGES as readonly string[]).includes(value)
