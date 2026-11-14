// What `keith-node driver add sandbox` records: the runtime found now and the images to pull, so the node runs with
// the same images the owner confirmed. Pure: the runtime lookup is passed in.
import { DEFAULT_IMAGES, IMAGE_LANGUAGES } from './images.ts'
import { invalid, type Parsed, parseSandboxOptions } from './options.ts'
import { chooseRuntime, type RuntimeName, type WhichFn } from './runtime.ts'

export type SetupOption = string | number | boolean

export interface SandboxSetup {
  /** The runtime the node will run containers with. */
  readonly runtime: RuntimeName
  /** The options to store in the node config (`runtime`, `network` when on, `image.<lang>` for each language). */
  readonly options: Readonly<Record<string, SetupOption>>
  /** The distinct images `driver add` pulls, in language order. */
  readonly pulls: readonly string[]
}

export function resolveSandboxSetup(
  raw: Readonly<Record<string, unknown>>,
  which: WhichFn,
): Parsed<SandboxSetup> {
  const parsed = parseSandboxOptions(raw)
  if (!parsed.ok) return invalid(parsed.message)
  const runtime = chooseRuntime(parsed.value.runtime, which)
  if (!runtime.ok) return invalid(runtime.message)
  const options: Record<string, SetupOption> = { runtime: runtime.value }
  if (parsed.value.network) options.network = true
  if (raw.maxConcurrent !== undefined) options.maxConcurrent = parsed.value.maxConcurrent
  for (const lang of IMAGE_LANGUAGES) {
    options[`image.${lang}`] = parsed.value.images[lang] ?? DEFAULT_IMAGES[lang]
  }
  const pulls = [...new Set(IMAGE_LANGUAGES.map((lang) => parsed.value.images[lang]))].filter(
    (image): image is string => image !== undefined,
  )
  return { ok: true, value: { runtime: runtime.value, options, pulls } }
}
