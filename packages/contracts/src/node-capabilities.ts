// Capability model of the nodes (docs/specs/node-drivers.md, "Contracts"; ADR-0023 §2–§4). Re-exported by node-protocol.ts
// and area-nodes.ts. Ids and manifests are wire shapes; NodeCapabilitySpec holds zod objects and is core-side only (never sent).
import { z } from 'zod'

/** Risk levels, the eharness names, so they match approval rules directly. Ordered from least to most risky. */
export const RISKS = ['read', 'write', 'external', 'destructive'] as const
export const RiskSchema = z.enum(RISKS)
export type Risk = z.infer<typeof RiskSchema>

/** A capability id: `<driver>.<action>`, the first segment names the driver. */
export const CAPABILITY_ID_MAX = 64
export const CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/
export const CapabilityIdSchema = z.string().max(CAPABILITY_ID_MAX).regex(CAPABILITY_ID_PATTERN)

/** Upper bounds of a manifest: a node announces at most this many drivers and capabilities. */
export const MANIFEST_DRIVERS_MAX = 16
export const MANIFEST_CAPABILITIES_MAX = 64

/** The driver name of a capability id: its first segment. */
export function driverOf(id: string): string {
  return id.split('.')[0] ?? ''
}

/** Why the core refuses one announced capability (the node stays online with the rest). */
export const RefusalReasonSchema = z.enum([
  'unknown-capability',
  'unsupported-schema',
  'driver-mismatch',
  'wrong-layer',
])
export type RefusalReason = z.infer<typeof RefusalReasonSchema>

/** The core side of one capability: what it is, how risky, who approves, and the zod schemas. Never sent. */
export interface NodeCapabilitySpec<I extends z.ZodType = z.ZodType> {
  id: string
  /** The newest schema version the core knows (integer, at least 1). */
  version: number
  /** Schema versions the core can talk; must contain `version`. */
  supports: readonly number[]
  /** The driver that provides it; equals the first segment of `id`. */
  driver: string
  layer: 'self' | 'ecosystem'
  summary: string
  /** Fixed risk, or a pure function of the parsed input (decided from input only, never live state). */
  risk: Risk | ((input: z.output<I>) => Risk)
  /**
   * `by-risk`: read is approved, anything riskier asks the owner. `never`: an input whose computed risk is at most
   * `write` runs without asking the owner; a riskier input asks by its risk (see `defineNodeCapability`).
   */
  approval: 'by-risk' | 'never'
  input: I
  output?: z.ZodType
  /**
   * Representative raw inputs. Required when `approval` is `never` and `risk` is a function: the definition checks
   * each one, and at least one must come out at `write` or below (the input that runs without asking the owner).
   */
  examples?: readonly unknown[]
}

function riskRank(risk: Risk): number {
  return RISKS.indexOf(risk)
}

/**
 * Validate and freeze a capability spec. Throws on a spec the core must not register: a bad id, a driver that is not the
 * id's first segment, versions that do not fit `supports`, or `approval: 'never'` whose risk can never be `write` or
 * below (a fixed risk above `write`, or a risk function that no example brings down to `write`).
 */
export function defineNodeCapability<I extends z.ZodType>(
  spec: NodeCapabilitySpec<I>,
): NodeCapabilitySpec<I> {
  const fail = (why: string): never => {
    throw new Error(`capability ${spec.id}: ${why}`)
  }
  if (!CapabilityIdSchema.safeParse(spec.id).success) fail('id is not <driver>.<action>')
  if (spec.driver !== driverOf(spec.id))
    fail(`driver "${spec.driver}" must be the id's first segment`)
  if (!Number.isInteger(spec.version) || spec.version < 1) fail('version must be an integer >= 1')
  if (spec.supports.length === 0 || !spec.supports.includes(spec.version))
    fail('supports must include the version')
  if (!spec.supports.every((v) => Number.isInteger(v) && v >= 1))
    fail('supports must be integers >= 1')

  if (spec.approval === 'never') {
    if (typeof spec.risk !== 'function') {
      if (riskRank(spec.risk) > riskRank('write'))
        fail(`approval never with risk ${spec.risk} (the limit is write)`)
    } else {
      const examples = spec.examples ?? []
      if (examples.length === 0) fail('approval never with a risk function needs examples')
      let someInputRunsUnasked = false
      for (const example of examples) {
        const parsed = spec.input.safeParse(example)
        if (!parsed.success) fail('an example does not match the input schema')
        const risk = spec.risk(parsed.data as z.output<I>)
        if (!RiskSchema.safeParse(risk).success) fail(`risk function returned ${String(risk)}`)
        if (riskRank(risk) <= riskRank('write')) someInputRunsUnasked = true
      }
      if (!someInputRunsUnasked)
        fail('approval never but no example has a risk of write or below (the limit is write)')
    }
  }
  return Object.freeze({ ...spec })
}

/** Built-in capabilities: the ones the core knows before any node announces them. */
const shellExecInput = z.object({
  command: z.string().min(1).max(4000),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
})
export type ShellExecInput = z.infer<typeof shellExecInput>

/** Desktop (driver `desktop`, docs/specs/node-drivers.md, "Driver desktop"): schemas of the three built-in capabilities. */
const coordinate = z.number().int().min(0).max(20_000)
export const DESKTOP_ACTION_TYPES = [
  'move',
  'click',
  'double_click',
  'right_click',
  'drag',
  'scroll',
  'type',
  'key',
] as const
export const DesktopActionSchema = z.object({
  type: z.enum(DESKTOP_ACTION_TYPES),
  x: coordinate.optional(),
  y: coordinate.optional(),
  /** The end point of a drag. */
  to: z.object({ x: coordinate, y: coordinate }).optional(),
  text: z.string().max(1000).optional(),
  keys: z.array(z.string().min(1).max(32)).max(8).optional(),
})
export type DesktopAction = z.infer<typeof DesktopActionSchema>
export const DESKTOP_ACTIONS_MAX = 10
export const DesktopInfoInputSchema = z.object({})
export const DesktopScreenshotInputSchema = z.object({
  /** A display id from `desktop.info`; the main display by default. */
  display: z.number().int().min(0).max(31).optional(),
  /** Longest side of the image in pixels; the node scales the capture down to it. */
  maxWidth: z.number().int().min(320).max(3840).default(1280),
})
export type DesktopScreenshotInput = z.infer<typeof DesktopScreenshotInputSchema>
export const DesktopInputInputSchema = z.object({
  actions: z.array(DesktopActionSchema).min(1).max(DESKTOP_ACTIONS_MAX),
})
export type DesktopInputInput = z.infer<typeof DesktopInputInputSchema>
/** A screenshot as a node returns it: base64 bytes and their type, with the size and scale of the capture. */
export const DesktopScreenshotOutputSchema = z.object({
  data: z.string(),
  mimeType: z.enum(['image/jpeg', 'image/png']),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  scale: z.number().positive(),
})

/**
 * Sandbox (driver `sandbox`, docs/specs/node-drivers.md, "Driver sandbox"): code run in a disposable container on a
 * sandbox node. The code limit counts bytes (UTF-8), not characters.
 */
export const SANDBOX_LANGUAGES = ['sh', 'python', 'node', 'bun'] as const
export const SANDBOX_CODE_MAX_BYTES = 100_000
export const SANDBOX_TIMEOUT_MAX_MS = 120_000
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).byteLength
export const SandboxRunInputSchema = z.object({
  language: z.enum(SANDBOX_LANGUAGES),
  code: z
    .string()
    .min(1)
    .refine(
      (code) => utf8Bytes(code) <= SANDBOX_CODE_MAX_BYTES,
      `code is at most ${SANDBOX_CODE_MAX_BYTES} bytes`,
    ),
  stdin: z
    .string()
    .refine(
      (s) => utf8Bytes(s) <= SANDBOX_CODE_MAX_BYTES,
      `stdin is at most ${SANDBOX_CODE_MAX_BYTES} bytes`,
    )
    .optional(),
  timeoutMs: z.number().int().positive().max(SANDBOX_TIMEOUT_MAX_MS).optional(),
  /** Off by default: the container has no network. `true` is external (the owner is asked) and needs the node's option. */
  network: z.boolean().optional(),
})
export type SandboxRunInput = z.infer<typeof SandboxRunInputSchema>
export const SandboxRunOutputSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int(),
  timedOut: z.boolean(),
  truncated: z.boolean(),
})
export type SandboxRunOutput = z.infer<typeof SandboxRunOutputSchema>

/**
 * Schema v2 (P31.6.2, docs/specs/node-drivers.md "Driver sandbox"): workspace files move by reference. The model names a
 * file of the person (`ref`, resolved by the core) and the name it gets in the container. The node never sees a core path:
 * it gets the bytes as base64 (`SandboxRunWireSchema`) and returns the output files the same way.
 */
export const SANDBOX_FILES_MAX = 5
export const SANDBOX_FILE_MAX_BYTES = 1_000_000
const SANDBOX_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export const SandboxFileNameSchema = z
  .string()
  .regex(
    SANDBOX_FILE_NAME_PATTERN,
    'a file name of letters, digits, dot, dash or underscore, at most 128',
  )
/** Bytes a base64 text stands for (`=` padding excluded). */
export function base64ByteLength(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return (data.length / 4) * 3 - padding
}
const uniqueNames = (names: readonly string[]): boolean => new Set(names).size === names.length

/** A workspace file to copy into the container: `ref` is a path of the person's workspace (`resolveWorkspacePath`). */
export const SandboxFileRefSchema = z.object({
  ref: z.string().min(1).max(512),
  name: SandboxFileNameSchema,
})
export type SandboxFileRef = z.infer<typeof SandboxFileRefSchema>

/** The input the model gives `sandbox.run` at schema v2: v1 plus files in and out. */
export const SandboxRunInputV2Schema = SandboxRunInputSchema.extend({
  files: z
    .array(SandboxFileRefSchema)
    .max(SANDBOX_FILES_MAX)
    .refine((files) => uniqueNames(files.map((f) => f.name)), 'each file name is used once')
    .optional(),
  outputFiles: z
    .array(SandboxFileNameSchema)
    .max(SANDBOX_FILES_MAX)
    .refine(uniqueNames, 'each output file name is listed once')
    .optional(),
})
export type SandboxRunInputV2 = z.infer<typeof SandboxRunInputV2Schema>

/** A file on the wire: its name in the container and its bytes as base64 (at most `SANDBOX_FILE_MAX_BYTES` decoded). */
export const SandboxStagedFileSchema = z.object({
  name: SandboxFileNameSchema,
  data: z
    .string()
    .max(Math.ceil(SANDBOX_FILE_MAX_BYTES / 3) * 4)
    .regex(BASE64_PATTERN, 'base64')
    .refine((data) => base64ByteLength(data) <= SANDBOX_FILE_MAX_BYTES, 'a file is at most 1 MB'),
})
export type SandboxStagedFile = z.infer<typeof SandboxStagedFileSchema>

/** What a node receives for `sandbox.run` at schema v2: the core has read the files and encoded them. */
export const SandboxRunWireSchema = SandboxRunInputSchema.extend({
  files: z
    .array(SandboxStagedFileSchema)
    .max(SANDBOX_FILES_MAX)
    .refine((files) => uniqueNames(files.map((f) => f.name)), 'each file name is used once')
    .optional(),
  outputFiles: z
    .array(SandboxFileNameSchema)
    .max(SANDBOX_FILES_MAX)
    .refine(uniqueNames, 'each output file name is listed once')
    .optional(),
})
export type SandboxRunWire = z.infer<typeof SandboxRunWireSchema>

/**
 * The output at schema v2. `files` are the requested outputs the container produced (at most 1 MB each); `missing` names
 * the requested ones it did not produce, or that were over 1 MB. Both are absent for a call with no `outputFiles`.
 */
export const SandboxRunOutputV2Schema = SandboxRunOutputSchema.extend({
  files: z.array(SandboxStagedFileSchema).optional(),
  missing: z.array(SandboxFileNameSchema).optional(),
})
export type SandboxRunOutputV2 = z.infer<typeof SandboxRunOutputV2Schema>

export const CAPABILITIES = {
  'desktop.info': defineNodeCapability({
    id: 'desktop.info',
    version: 1,
    supports: [1],
    driver: 'desktop',
    layer: 'self',
    summary: 'The displays of the node (id, size in pixels, scale) and the app in front.',
    risk: 'read',
    approval: 'by-risk',
    input: DesktopInfoInputSchema,
  }),
  'desktop.screenshot': defineNodeCapability({
    id: 'desktop.screenshot',
    version: 1,
    supports: [1],
    driver: 'desktop',
    layer: 'self',
    summary: 'A screenshot of one display. The pixels go to the model provider.',
    risk: 'external',
    approval: 'by-risk',
    input: DesktopScreenshotInputSchema,
    output: DesktopScreenshotOutputSchema,
  }),
  'desktop.input': defineNodeCapability({
    id: 'desktop.input',
    version: 1,
    supports: [1],
    driver: 'desktop',
    layer: 'self',
    summary:
      'Mouse and keyboard actions on the node screen, at most 10 per call. Refused unless the node allows input.',
    risk: 'destructive',
    approval: 'by-risk',
    input: DesktopInputInputSchema,
  }),
  'system.info': defineNodeCapability({
    id: 'system.info',
    version: 1,
    supports: [1],
    driver: 'system',
    layer: 'self',
    summary: 'Facts about the node machine (OS, arch, version).',
    risk: 'read',
    approval: 'by-risk',
    input: z.object({}),
  }),
  'shell.exec': defineNodeCapability({
    id: 'shell.exec',
    version: 1,
    supports: [1],
    driver: 'shell',
    layer: 'self',
    summary: 'Run one shell command on the node, when the node allows shell.',
    risk: 'destructive',
    approval: 'by-risk',
    input: shellExecInput,
  }),
  'sandbox.run': defineNodeCapability({
    id: 'sandbox.run',
    version: 2,
    supports: [1, 2],
    driver: 'sandbox',
    layer: 'self',
    summary:
      'Run code in a disposable container on a sandbox node: no network unless network is true, which the owner approves. Files of the person go in and out by workspace reference (files, outputFiles).',
    // without network the code cannot reach anything outside its container: write, approved without asking
    risk: (input) => (input.network === true ? 'external' : 'write'),
    approval: 'never',
    input: SandboxRunInputV2Schema,
    output: SandboxRunOutputV2Schema,
    examples: [{ language: 'python', code: 'print(1)' }],
  }),
} as const

/** The built-in ids. Narrower than the wire schema, which accepts any well-formed id a driver announces. */
export type CapabilityId = keyof typeof CAPABILITIES

/**
 * Risk of a capability, or undefined for an id core does not know. A fixed risk ignores `input`; a risk function gets the
 * input parsed by the spec, and an input that does not parse yields undefined (the call is refused before approval).
 */
export function capabilityRisk(id: string, input?: unknown): Risk | undefined {
  if (!Object.hasOwn(CAPABILITIES, id)) return undefined
  const spec = CAPABILITIES[id as CapabilityId] as NodeCapabilitySpec
  if (typeof spec.risk !== 'function') return spec.risk
  const parsed = spec.input.safeParse(input ?? {})
  return parsed.success ? spec.risk(parsed.data) : undefined
}

/** A capability entry in a v2 driver announcement. */
export const CapabilityEntrySchema = z.object({
  id: CapabilityIdSchema,
  schemaVersion: z.number().int().min(1).max(1000),
})
export type CapabilityEntry = z.infer<typeof CapabilityEntrySchema>

/** Driver options are public facts only (`allowInput`, `network`), never secrets. Bounded: few keys, short values. */
export const DriverOptionsSchema = z
  .record(z.string().max(64), z.union([z.string().max(256), z.number(), z.boolean(), z.null()]))
  .refine((o) => Object.keys(o).length <= 32, 'at most 32 options')

/** One installed driver as a node announces it (v2). */
export const DriverAnnouncementSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9]*$/)
    .max(32),
  /** Semver of the driver package. */
  version: z
    .string()
    .max(32)
    .regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/),
  capabilities: z.array(CapabilityEntrySchema).max(MANIFEST_CAPABILITIES_MAX),
  options: DriverOptionsSchema.optional(),
})
export type DriverAnnouncement = z.infer<typeof DriverAnnouncementSchema>

const NodeIdentity = {
  /** Slug, e.g. `laptop-e`. */
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  os: z.string(),
  arch: z.string(),
  /** Keith version of the node. */
  version: z.string(),
  policy: z.object({ allowShell: z.boolean() }),
}

/** Manifest v1 (protocol 1 and 2 nodes): a flat capability list; the core maps it to the drivers `system` and `shell`. */
export const NodeManifestV1Schema = z.object({
  ...NodeIdentity,
  manifestVersion: z.literal(1).optional(),
  capabilities: z.array(CapabilityIdSchema).max(MANIFEST_CAPABILITIES_MAX),
})
export type NodeManifestV1 = z.infer<typeof NodeManifestV1Schema>

/** Manifest v2 (protocol 3): drivers with their capabilities and schema versions. */
export const NodeManifestV2Schema = z
  .object({
    ...NodeIdentity,
    manifestVersion: z.literal(2),
    drivers: z.array(DriverAnnouncementSchema).max(MANIFEST_DRIVERS_MAX),
  })
  .refine(
    (m) => m.drivers.reduce((n, d) => n + d.capabilities.length, 0) <= MANIFEST_CAPABILITIES_MAX,
    `at most ${MANIFEST_CAPABILITIES_MAX} capabilities`,
  )
export type NodeManifestV2 = z.infer<typeof NodeManifestV2Schema>

/** Either manifest version. v2 is tried first; a v2 that fails stays a failure (it has no `capabilities` for v1). */
export const NodeManifestSchema = z.union([NodeManifestV2Schema, NodeManifestV1Schema])
export type NodeManifest = z.infer<typeof NodeManifestSchema>
