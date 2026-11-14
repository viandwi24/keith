// Workspace files of a `sandbox.run` call (schema v2, ADR-0021 §2; docs/specs/node-drivers.md "Driver sandbox"). The core
// reads each file the person named through `resolveWorkspacePath`, sends its bytes as base64 (the node never sees a core
// path), audits the send by path and size, and writes the returned outputs back into the person's `sandbox/` folder.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  SANDBOX_FILE_MAX_BYTES,
  type SandboxRunInputV2,
  SandboxRunInputV2Schema,
  type SandboxRunWire,
} from '@keith/contracts'
import { resolveWorkspacePath, type WorkspaceCaller } from '../../platform/workspace-resolve.ts'
import type { Audit } from '../audit/index.ts'
import type { InvokeOutcome } from '../nodes/index.ts'

/** Where a call's outputs are written: `people/<id>/sandbox/<name>`. */
export const SANDBOX_OUTPUT_FOLDER = 'sandbox'

/** What the core does with a motor call's files: the wiring of `motorRemote`, absent in tests that send no files. */
export interface SandboxFilesOptions {
  readonly dataDir: string
  /** Room membership of the person (the rooms service, injected): a room path is allowed only for a member. */
  readonly isRoomMember?: (roomId: string, person: string) => boolean
  /** Writes `workspace.file.send` (`{ person, path, bytes }`, never the content). */
  readonly audit?: Pick<Audit, 'record'>
}

/** A call ready for the node: its input (files as base64) and how its outcome is handed back. */
export type PreparedCall =
  | {
      readonly ok: true
      readonly input: unknown
      readonly finish: (outcome: InvokeOutcome) => InvokeOutcome
    }
  | { readonly ok: false; readonly message: string }

const unchanged = (input: unknown): PreparedCall => ({
  ok: true,
  input,
  finish: (outcome) => outcome,
})

/** Reads each named file through the resolver. A refusal names the file and stops the call before anything runs. */
function readFiles(
  caller: WorkspaceCaller,
  input: SandboxRunInputV2,
):
  | { ok: true; input: SandboxRunWire; sent: Array<{ path: string; bytes: number }> }
  | { ok: false; message: string } {
  const sent: Array<{ path: string; bytes: number }> = []
  const files: Array<{ name: string; data: string }> = []
  for (const file of input.files ?? []) {
    const resolved = resolveWorkspacePath(caller, file.ref)
    if (!resolved.ok) return { ok: false, message: `${file.ref}: ${resolved.message}` }
    try {
      const size = statSync(resolved.file.real).size
      if (size > SANDBOX_FILE_MAX_BYTES) return { ok: false, message: `${file.ref} is over 1 MB` }
      const bytes = readFileSync(resolved.file.real)
      files.push({ name: file.name, data: bytes.toString('base64') })
      sent.push({ path: resolved.file.path, bytes: bytes.length })
    } catch {
      return { ok: false, message: `${file.ref} is not a readable file` }
    }
  }
  const { files: _named, ...rest } = input
  return { ok: true, input: files.length === 0 ? rest : { ...rest, files }, sent }
}

/**
 * Writes the outputs the node returned into the person's `sandbox/` folder, under the names the call asked for, and
 * hands the model the names and sizes only (never the bytes). A name that cannot be written is listed as missing.
 */
function saveOutputs(
  caller: WorkspaceCaller,
  requested: readonly string[],
  outcome: InvokeOutcome,
): InvokeOutcome {
  if (!outcome.ok || requested.length === 0) return outcome
  const output = (outcome.output ?? {}) as Record<string, unknown>
  const returned = Array.isArray(output.files)
    ? (output.files as Array<{ name: string; data: string }>)
    : []
  const saved: Array<{ name: string; path: string; bytes: number }> = []
  const missing = new Set<string>(Array.isArray(output.missing) ? (output.missing as string[]) : [])
  const written = new Set<string>()
  for (const file of returned) {
    // the node names files, the core picks the folder: a name the call did not ask for is dropped
    if (!requested.includes(file.name) || written.has(file.name)) continue
    written.add(file.name)
    const target = resolveWorkspacePath(
      caller,
      `people/${caller.person}/${SANDBOX_OUTPUT_FOLDER}/${file.name}`,
    )
    if (!target.ok) {
      missing.add(file.name)
      continue
    }
    const bytes = Buffer.from(file.data, 'base64')
    try {
      mkdirSync(dirname(target.file.real), { recursive: true })
      writeFileSync(target.file.real, bytes)
      saved.push({ name: file.name, path: target.file.path, bytes: bytes.length })
    } catch {
      missing.add(file.name)
    }
  }
  for (const name of requested) if (!written.has(name)) missing.add(name)
  const { files: _returned, ...rest } = output
  return { ...outcome, output: { ...rest, saved, missing: [...missing] } }
}

/**
 * Prepares a motor call. A `sandbox.run` without files or outputs goes unchanged (schema v1 behaviour). With files, each
 * is read for the caller (`person`) and the audit row is written before the call is sent. Outputs are saved when the
 * outcome comes back.
 */
export function prepareCall(
  options: SandboxFilesOptions | undefined,
  person: string | undefined,
  capability: string,
  input: unknown,
): PreparedCall {
  if (capability !== 'sandbox.run') return unchanged(input)
  const parsed = SandboxRunInputV2Schema.safeParse(input)
  if (!parsed.success) return unchanged(input)
  const { files = [], outputFiles = [] } = parsed.data
  if (files.length === 0 && outputFiles.length === 0) return unchanged(input)
  if (options === undefined || person === undefined) {
    return { ok: false, message: 'files need a person with a workspace' }
  }
  const caller: WorkspaceCaller = {
    dataDir: options.dataDir,
    person,
    ...(options.isRoomMember === undefined ? {} : { isRoomMember: options.isRoomMember }),
  }
  const read = readFiles(caller, parsed.data)
  if (!read.ok) return { ok: false, message: read.message }
  for (const sent of read.sent) {
    options.audit?.record({
      kind: 'workspace.file.send',
      actor: person,
      via: 'local',
      detail: { person, path: sent.path, bytes: sent.bytes },
    })
  }
  return {
    ok: true,
    input: read.input,
    finish: (outcome) => {
      try {
        return saveOutputs(caller, outputFiles, outcome)
      } catch (error) {
        return {
          ok: false,
          code: 'failed',
          message: error instanceof Error ? error.message : String(error),
        }
      }
    },
  }
}
