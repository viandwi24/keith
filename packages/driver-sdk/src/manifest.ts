// The driver manifest, `keith-driver.json` (docs/specs/node-drivers.md, "Driver package").

import { isAbsolute } from 'node:path'
import { CapabilityIdSchema, driverOf } from '@keith/contracts'
import { z } from 'zod'

/** The manifest format this SDK reads. */
export const DRIVER_MANIFEST_VERSION = 1
/** The file at the root of every driver folder. */
export const DRIVER_MANIFEST_FILE = 'keith-driver.json'
/** The platforms a driver can declare: the `process.platform` values Keith runs on. */
export const DRIVER_PLATFORMS = ['darwin', 'linux', 'win32'] as const
export type DriverPlatform = (typeof DRIVER_PLATFORMS)[number]

/** A driver name is the first segment of each of its capability ids (`desktop` in `desktop.screenshot`). */
export const DriverNameSchema = z
  .string()
  .max(32)
  .regex(/^[a-z][a-z0-9]*$/, 'lowercase letters and digits, starting with a letter')
/** Semantic version of a driver, e.g. `0.1.0`. */
export const DriverVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, 'a semantic version such as 0.1.0')
/** The entry module, relative to the driver folder; it may not leave that folder. */
const EntrySchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (path) => !isAbsolute(path) && !path.split(/[\\/]/).includes('..'),
    'a path inside the driver folder',
  )

export const DriverCapabilityDeclSchema = z
  .object({
    id: CapabilityIdSchema,
    schemaVersion: z.number().int().min(1).max(1000),
  })
  .strict()

export const DriverManifestSchema = z
  .object({
    manifestVersion: z.literal(DRIVER_MANIFEST_VERSION),
    name: DriverNameSchema,
    version: DriverVersionSchema,
    entry: EntrySchema,
    capabilities: z.array(DriverCapabilityDeclSchema).min(1).max(64),
    platforms: z.array(z.enum(DRIVER_PLATFORMS)).min(1),
    needs: z.array(z.string().min(1).max(80)).max(16).default([]),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const seen = new Set<string>()
    manifest.capabilities.forEach((capability, index) => {
      const path = ['capabilities', index, 'id']
      if (driverOf(capability.id) !== manifest.name) {
        ctx.addIssue({
          code: 'custom',
          path,
          message: `must start with the driver name ${manifest.name}`,
        })
      }
      if (seen.has(capability.id)) {
        ctx.addIssue({ code: 'custom', path, message: `${capability.id} is declared twice` })
      }
      seen.add(capability.id)
    })
  })

export type DriverManifest = z.infer<typeof DriverManifestSchema>
export type DriverCapabilityDecl = z.infer<typeof DriverCapabilityDeclSchema>
