// The driver options (`keith-node driver add sandbox`, stored in the node config): what the driver may do on this
// node. Public facts only; the call input is checked separately (`parseRunInput`).
import { SandboxRunWireSchema } from '@keith/contracts'
import { DEFAULT_IMAGES, IMAGE_LANGUAGES, IMAGE_REF_PATTERN, type ImageLanguage } from './images.ts'
import type { RuntimeName } from './runtime.ts'

export const MAX_CONCURRENT_DEFAULT = 2
export const MAX_CONCURRENT_LIMIT = 8

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string }

export const invalid = (message: string): { readonly ok: false; readonly message: string } => ({
  ok: false,
  message,
})

export interface SandboxOptions {
  /** Requested runtime; absent means detect (`chooseRuntime`). */
  readonly runtime?: RuntimeName
  /** Whether a call may ask for network. Off by default: a `network: true` call is refused. */
  readonly network: boolean
  /** Containers at once on this node; a call over it is `busy`. */
  readonly maxConcurrent: number
  readonly images: Readonly<Record<ImageLanguage, string>>
}

const RUNTIME_OPTION = ['docker', 'podman'] as const

/** Reads the options a node stored; an unknown or malformed value is a refusal, never a guess. */
export function parseSandboxOptions(
  raw: Readonly<Record<string, unknown>>,
): Parsed<SandboxOptions> {
  const runtime = raw.runtime
  if (runtime !== undefined && !(RUNTIME_OPTION as readonly unknown[]).includes(runtime)) {
    return invalid('runtime must be docker or podman')
  }
  const network = raw.network ?? false
  if (typeof network !== 'boolean') return invalid('network must be true or false')
  const maxConcurrent = raw.maxConcurrent ?? MAX_CONCURRENT_DEFAULT
  if (
    typeof maxConcurrent !== 'number' ||
    !Number.isInteger(maxConcurrent) ||
    maxConcurrent < 1 ||
    maxConcurrent > MAX_CONCURRENT_LIMIT
  ) {
    return invalid(`maxConcurrent must be a whole number from 1 to ${MAX_CONCURRENT_LIMIT}`)
  }
  const images = { ...DEFAULT_IMAGES }
  for (const lang of IMAGE_LANGUAGES) {
    const ref = raw[`image.${lang}`]
    if (ref === undefined) continue
    if (typeof ref !== 'string' || !IMAGE_REF_PATTERN.test(ref)) {
      return invalid(`image.${lang} must be an image reference such as ${DEFAULT_IMAGES[lang]}`)
    }
    images[lang] = ref
  }
  return {
    ok: true,
    value: {
      ...(runtime === undefined ? {} : { runtime: runtime as RuntimeName }),
      network,
      maxConcurrent,
      images,
    },
  }
}

/** A call the driver will run, with the defaults filled in. */
export interface RunRequest {
  readonly language: ImageLanguage
  readonly code: string
  readonly stdin?: string
  readonly timeoutMs: number
  readonly network: boolean
  /** Schema v2: the input files, already decoded from the wire (base64 text, checked by the contract). */
  readonly files: ReadonlyArray<{ readonly name: string; readonly data: string }>
  /** Schema v2: the names of the output files to read back. */
  readonly outputFiles: readonly string[]
}

export const DEFAULT_TIMEOUT_MS = 30_000

/** The `sandbox.run` wire input of the contract (schema v1 plus the v2 files): the core's own check, run again here. */
const RUN_INPUT = SandboxRunWireSchema

/** The shape the contract's schema admits (its inferred type is not exported; the schema is the check). */
interface ContractRunInput {
  readonly language: ImageLanguage
  readonly code: string
  readonly stdin?: string
  readonly timeoutMs?: number
  readonly network?: boolean
  readonly files?: ReadonlyArray<{ readonly name: string; readonly data: string }>
  readonly outputFiles?: readonly string[]
}

/**
 * Checks the `sandbox.run` input against the contract. The core checks it first; this is the last check. `schemaVersion`
 * 1 takes no files: a v1 call that names files is refused, so a v1 caller never gets a file it did not ask for.
 */
export function parseRunInput(input: unknown, schemaVersion: number = 2): Parsed<RunRequest> {
  if (schemaVersion === 1 && typeof input === 'object' && input !== null) {
    if ('files' in input || 'outputFiles' in input) {
      return invalid('files need sandbox.run schema version 2')
    }
  }
  const parsed = RUN_INPUT.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = issue?.path.map(String).join('.') || '(input)'
    return invalid(`${path} ${issue?.message ?? 'is not valid'}`)
  }
  const value = parsed.data as ContractRunInput
  return {
    ok: true,
    value: {
      language: value.language,
      code: value.code,
      ...(value.stdin === undefined ? {} : { stdin: value.stdin }),
      timeoutMs: value.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      network: value.network === true,
      files: value.files ?? [],
      outputFiles: value.outputFiles ?? [],
    },
  }
}
