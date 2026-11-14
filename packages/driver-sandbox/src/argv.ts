// The command lines of the driver, built as argument lists (never a shell string, never a host mount). Every
// `run` gets the same flags; the tests read them from a fake runtime (docs/specs/node-drivers.md, "Driver sandbox").
import { type ImageLanguage, LANGUAGE_COMMAND } from './images.ts'
import type { RuntimeName } from './runtime.ts'

export const CONTAINER_USER = '65534:65534'
export const CONTAINER_NAME_PREFIX = 'keith-sbx-'
export const MEMORY = '512m'
export const CPUS = '1'
export const PIDS_LIMIT = '128'
export const TMPFS_SIZE = 'size=64m'
export const WORK_DIR = '/work'

/** The fixed name of a call's container: `keith-sbx-<callId>`, with characters a runtime does not accept replaced. */
export function containerName(callId: string): string {
  const safe = callId.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 64)
  return `${CONTAINER_NAME_PREFIX}${safe}`
}

export interface RunArgvInput {
  readonly runtime: RuntimeName
  readonly name: string
  readonly image: string
  readonly language: ImageLanguage
  readonly code: string
  readonly network: boolean
  /** True when the call sends stdin: the container keeps its stdin open. */
  readonly stdin: boolean
}

/** The flags every container gets: no network unless asked, a read-only root, tmpfs folders, limits, no capabilities, one user. */
export function containerFlags(network: boolean): string[] {
  return [
    '--pull',
    'never',
    ...(network ? [] : ['--network', 'none']),
    '--read-only',
    '--tmpfs',
    `/tmp:rw,${TMPFS_SIZE}`,
    '--tmpfs',
    `${WORK_DIR}:rw,${TMPFS_SIZE}`,
    '-w',
    WORK_DIR,
    '--memory',
    MEMORY,
    '--cpus',
    CPUS,
    '--pids-limit',
    PIDS_LIMIT,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    CONTAINER_USER,
  ]
}

export function runArgv(input: RunArgvInput): string[] {
  const [program, flag] = LANGUAGE_COMMAND[input.language]
  return [
    input.runtime,
    'run',
    '--rm',
    '--name',
    input.name,
    ...containerFlags(input.network),
    ...(input.stdin ? ['-i'] : []),
    '--entrypoint',
    program,
    input.image,
    flag,
    input.code,
  ]
}

/**
 * Schema v2 (files) runs in a container that is created, started and kept alive by `sleep`; the files go in and come out
 * with `exec` (a copy with `docker cp` lands under a tmpfs mount and is hidden at start). Every command below is one argument list.
 */
export const KEEPER_SECONDS = '600'
/** Reads at most one byte over the file limit, so a larger output is seen as too large without reading all of it. */
export const READ_LIMIT_BYTES = 1_000_001

export function createArgv(runtime: RuntimeName, name: string, image: string, network: boolean) {
  return [
    runtime,
    'create',
    '--name',
    name,
    ...containerFlags(network),
    '--entrypoint',
    'sleep',
    image,
    KEEPER_SECONDS,
  ]
}

export const startArgv = (runtime: RuntimeName, name: string): string[] => [runtime, 'start', name]

/** Writes the base64 text on stdin to one file of the work folder, decoded. */
export const stageArgv = (runtime: RuntimeName, name: string, file: string): string[] => [
  runtime,
  'exec',
  '-i',
  name,
  'sh',
  '-c',
  'base64 -d > "$0" && chmod 444 "$0"',
  `${WORK_DIR}/${file}`,
]

/** Runs the code in the started container; the exec gets the same user and work folder as the container. */
export function execArgv(input: {
  runtime: RuntimeName
  name: string
  language: ImageLanguage
  code: string
  stdin: boolean
}): string[] {
  const [program, flag] = LANGUAGE_COMMAND[input.language]
  return [
    input.runtime,
    'exec',
    ...(input.stdin ? ['-i'] : []),
    input.name,
    program,
    flag,
    input.code,
  ]
}

/** Prints one output file as base64 (no line breaks needed: the reader drops whitespace); fails when it is missing. */
export const readArgv = (runtime: RuntimeName, name: string, file: string): string[] => [
  runtime,
  'exec',
  name,
  'sh',
  '-c',
  `test -f "$0" && head -c ${READ_LIMIT_BYTES} "$0" | base64`,
  `${WORK_DIR}/${file}`,
]

export const removeArgv = (runtime: RuntimeName, name: string): string[] => [
  runtime,
  'rm',
  '-f',
  name,
]

/** Stops a container by its name; `--rm` then removes it. Used by timeout and cancel. */
export function killArgv(runtime: RuntimeName, name: string): string[] {
  return [runtime, 'kill', name]
}
