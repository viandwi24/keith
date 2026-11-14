// `keith-node driver list|add|remove`: edits the local node config only; nothing is sent to the core
// (docs/specs/node-drivers.md, "CLI"). Built on @keith/cli, so --help is generated.
import { join, resolve } from 'node:path'
import {
  CliError,
  type Command,
  type CommandContext,
  confirm,
  defineCommand,
  type FlagDef,
  isInteractive,
  printTable,
  UsageError,
} from '@keith/cli'
import {
  IMAGE_LANGUAGES,
  pullArgv,
  type RuntimeName,
  resolveSandboxSetup,
  spawnRuntime,
  type WhichFn,
} from '@keith/driver-sandbox'
import {
  DRIVER_MANIFEST_FILE,
  type DriverFolder,
  type DriverManifest,
  DriverManifestSchema,
  type LoadedDriver,
  loadDriver,
  readDriverManifest,
} from '@keith/driver-sdk'
import {
  BUILTIN_DRIVERS,
  BUNDLED_DRIVERS,
  bundledDir,
  CHECKOUT_PACKAGES,
  type DriverSources,
  ensureBundledBuilt,
  loadInstalledDrivers,
} from './drivers.ts'
import {
  DriverEntrySchema,
  driverFingerprint,
  loadConfig,
  type NodeConfig,
  resolveConfigPath,
  saveConfig,
} from './platform/config.ts'

const configFlag: FlagDef = {
  type: 'string',
  placeholder: 'path',
  description: 'Node config file (default: $KEITH_NODE_CONFIG or ~/.keith/node.json)',
}

/** The host side of `driver add sandbox`: the runtime lookup and the `pull` command. Tests replace both. */
export interface SandboxHost {
  /** Finds a program on PATH; defaults to Bun.which. */
  readonly which?: WhichFn
  /** Runs one command (a `pull`) and returns its exit code and stderr; defaults to starting the runtime program. */
  readonly run?: (argv: readonly string[]) => Promise<{ exitCode: number; stderr: string }>
}

export interface DriverCommandOptions {
  /** Where bundled drivers are looked up; the checkout's `packages/` by default. */
  packagesRoot?: string
  sandbox?: SandboxHost
}

/** The `driver` command group with `list`, `add` and `remove`. */
export function driverCommand(options: DriverCommandOptions = {}): Command {
  const sources: DriverSources = { packagesRoot: options.packagesRoot ?? CHECKOUT_PACKAGES }
  const host = options.sandbox ?? {}
  return defineCommand({
    name: 'driver',
    summary: 'List, add and remove the drivers this node runs (restart run to apply)',
    subcommands: [listCommand(sources), addCommand(sources, host), removeCommand],
  })
}

const defaultWhich: WhichFn = (name) => Bun.which(name) ?? undefined

/** Starts one runtime command and collects its exit code and stderr (its stdout is drained so it never blocks). */
const defaultRun = async (argv: readonly string[]) => {
  const proc = spawnRuntime(argv, {})
  const [exitCode, , stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { exitCode, stderr }
}

/** The manifest of a bundled driver, read without importing its entry; undefined when it is not there. */
async function bundledManifest(
  name: string,
  sources: DriverSources,
): Promise<DriverManifest | undefined> {
  const file = Bun.file(join(bundledDir(name, sources.packagesRoot), DRIVER_MANIFEST_FILE))
  if (!(await file.exists())) return undefined
  const json = await file.json().catch(() => undefined)
  const parsed = DriverManifestSchema.safeParse(json)
  return parsed.success ? parsed.data : undefined
}

const MAC_PERMISSIONS: Record<string, string> = {
  'screen-recording': 'Screen Recording',
  accessibility: 'Accessibility',
}

/**
 * The line that tells the owner what the OS asks for. On macOS the grants go to the app that runs keith-node (the
 * terminal), by hand in System Settings; Keith cannot grant them.
 */
export function permissionNotes(needs: readonly string[], platform: string): string[] {
  if (needs.length === 0) return []
  if (platform !== 'darwin') return [`needs:     ${needs.join(', ')}`]
  const names = needs.map((need) => MAC_PERMISSIONS[need] ?? need).join(' and ')
  return [
    `needs:     macOS ${names} for the terminal that runs keith-node (System Settings > Privacy & Security). Keith cannot grant them.`,
  ]
}

/**
 * Builds the bundled drivers that are missing their entry (`bun run build`), so add and list work from a fresh
 * checkout. Returns one line per driver that could not be built.
 */
async function buildBundled(names: readonly string[], sources: DriverSources): Promise<string[]> {
  const problems: string[] = []
  for (const name of names) {
    const problem = await ensureBundledBuilt(name, sources)
    if (problem !== undefined) problems.push(problem)
  }
  return problems
}

const platformFits = (manifest: DriverManifest): string =>
  (manifest.platforms as readonly string[]).includes(process.platform)
    ? 'fits this platform'
    : `runs on ${manifest.platforms.join(', ')} only`

const listCommand = (sources: DriverSources): Command =>
  defineCommand({
    name: 'list',
    summary: 'Installed drivers with their state, and the bundled ones that can be added',
    flags: { config: configFlag },
    examples: ['keith-node driver list'],
    run: async (ctx) => {
      const configPath = resolveConfigPath(ctx.string('config'))
      const config = await loadConfig(configPath)
      const installedBundled = config.drivers
        .filter((d) => d.source === 'bundled')
        .map((d) => d.name)
      for (const problem of await buildBundled(installedBundled, sources)) {
        ctx.io.stdout.write(`note: ${problem}\n`)
      }
      const states = await loadInstalledDrivers(config.drivers, sources)
      if (states.length === 0) {
        ctx.io.stdout.write('No drivers installed.\n')
      } else {
        const rows = states.map((state) => {
          const { entry } = state
          if (!state.ok)
            return [entry.name, '-', entry.source, `not loaded: ${state.message}`, '-', '-']
          const { manifest, driver } = state.driver
          const options = Object.entries(entry.options).map(([k, v]) => `${k}=${String(v)}`)
          const offered = driver.offered?.(entry.options) ?? manifest.capabilities
          return [
            entry.name,
            manifest.version,
            entry.source,
            `ok, ${platformFits(manifest)}`,
            offered.map((c) => c.id).join(', '),
            options.length > 0 ? options.join(' ') : '-',
          ]
        })
        printTable(ctx.io, rows, {
          header: ['DRIVER', 'VERSION', 'SOURCE', 'STATE', 'CAPABILITIES', 'OPTIONS'],
        })
      }
      const installed = new Set(config.drivers.map((d) => d.name))
      const addable = BUNDLED_DRIVERS.filter((name) => !installed.has(name))
      await buildBundled(addable, sources)
      if (addable.length > 0) {
        const rows: string[][] = []
        for (const name of addable) {
          const manifest = await bundledManifest(name, sources)
          rows.push(
            manifest === undefined
              ? [name, '-', 'bundled folder not found', '-']
              : [
                  name,
                  manifest.version,
                  platformFits(manifest),
                  manifest.capabilities.map((c) => c.id).join(', '),
                ],
          )
        }
        ctx.io.stdout.write('\nCan be added (keith-node driver add <name>):\n')
        printTable(ctx.io, rows)
      }
      return 0
    },
  })

/** `--option key=value` values: booleans and numbers keep their type, everything else is text. */
function optionValue(text: string): string | number | boolean {
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  return text
}

function driverOptions(ctx: CommandContext): Record<string, string | number | boolean> {
  const options: Record<string, string | number | boolean> = {}
  const raw = Array.isArray(ctx.values.option) ? ctx.values.option : []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const eq = item.indexOf('=')
    if (eq <= 0) throw new UsageError(`--option wants key=value, got "${item}"`, ctx.path)
    options[item.slice(0, eq)] = optionValue(item.slice(eq + 1))
  }
  if (ctx.bool('allow-input')) options.allowInput = true
  if (ctx.bool('network')) options.network = true
  const runtime = ctx.string('runtime')
  if (runtime !== undefined) {
    if (runtime !== 'docker' && runtime !== 'podman') {
      throw new UsageError('--runtime is docker or podman', ctx.path)
    }
    options.runtime = runtime
  }
  return options
}

/** `--image lang=ref` pairs of the sandbox driver, as the `image.<lang>` options they set. */
function imageFlags(ctx: CommandContext): Record<string, string> {
  const images: Record<string, string> = {}
  const raw = Array.isArray(ctx.values.image) ? ctx.values.image : []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const eq = item.indexOf('=')
    const lang = item.slice(0, Math.max(eq, 0))
    if (eq <= 0 || !(IMAGE_LANGUAGES as readonly string[]).includes(lang)) {
      throw new UsageError(
        `--image wants ${IMAGE_LANGUAGES.join('|')}=<image>, got "${item}"`,
        ctx.path,
      )
    }
    images[`image.${lang}`] = item.slice(eq + 1)
  }
  return images
}

const addCommand = (sources: DriverSources, host: SandboxHost): Command =>
  defineCommand({
    name: 'add',
    summary: 'Install a bundled driver or a driver folder; shows what it can do and asks first',
    usage:
      '<name|path> [--option key=value] [--allow-input] [--runtime docker|podman] [--network] [--image lang=ref] [--yes]',
    positionals: true,
    flags: {
      config: configFlag,
      option: {
        type: 'string',
        multiple: true,
        placeholder: 'key=value',
        description: 'A driver option (repeat for more)',
      },
      'allow-input': {
        type: 'boolean',
        default: false,
        description: 'desktop: allow mouse and keyboard input (default: screenshots only)',
      },
      runtime: {
        type: 'string',
        placeholder: 'docker|podman',
        description: 'sandbox: the container runtime',
      },
      network: {
        type: 'boolean',
        default: false,
        description: 'sandbox: allow network calls from the container',
      },
      image: {
        type: 'string',
        multiple: true,
        placeholder: 'lang=image',
        description:
          'sandbox: the image of one language, e.g. python=python:3.13-alpine (repeat for more)',
      },
      yes: { type: 'boolean', default: false, description: 'Install without asking' },
    },
    examples: [
      'keith-node driver add desktop',
      'keith-node driver add sandbox --yes',
      'keith-node driver add ./my-driver --yes',
    ],
    run: async (ctx) => {
      const [target, ...extra] = ctx.positionals
      if (target === undefined || extra.length > 0) {
        throw new UsageError('driver add takes one bundled name or one folder', ctx.path)
      }
      const configPath = resolveConfigPath(ctx.string('config'))
      const config = await loadConfig(configPath)

      const bundled =
        !target.includes('/') && (BUNDLED_DRIVERS as readonly string[]).includes(target)
      const dir = bundled ? bundledDir(target, sources.packagesRoot) : resolve(target)
      if (bundled) {
        const problem = await ensureBundledBuilt(target, sources, { force: true })
        if (problem !== undefined) throw new CliError(`cannot add ${target}: ${problem}`)
      }
      // Before the owner agrees, only the manifest, the platform and the entry path are read. The entry is not
      // imported until the confirmation (below), so a declined add runs none of the driver's code.
      let folder: DriverFolder
      try {
        folder = await readDriverManifest(dir)
      } catch (error) {
        throw new CliError(`cannot add ${target}: ${(error as Error).message}`)
      }
      const { manifest } = folder
      if (bundled && manifest.name !== target) {
        throw new CliError(`${dir} holds ${manifest.name}, not ${target}`)
      }
      if ((BUILTIN_DRIVERS as readonly string[]).includes(manifest.name)) {
        throw new CliError(`${manifest.name} is a built-in driver name`)
      }
      // sandbox: the runtime found now and the images to pull are recorded, so the node runs what the owner confirmed
      const sandbox = bundled && manifest.name === 'sandbox'
      const images = imageFlags(ctx)
      if (!sandbox && Object.keys(images).length > 0) {
        throw new UsageError('--image is an option of the sandbox driver', ctx.path)
      }
      let options: Record<string, string | number | boolean> = driverOptions(ctx)
      let pulls: string[] = []
      let runtime: RuntimeName = 'docker'
      if (sandbox) {
        const setup = resolveSandboxSetup({ ...options, ...images }, host.which ?? defaultWhich)
        if (!setup.ok) throw new CliError(`cannot add sandbox: ${setup.message}`)
        options = { ...setup.value.options }
        pulls = [...setup.value.pulls]
        runtime = setup.value.runtime
      }
      const entry = DriverEntrySchema.safeParse({
        name: manifest.name,
        source: bundled ? 'bundled' : 'path',
        ...(bundled ? {} : { path: dir }),
        sha256: await driverFingerprint(dir),
        options,
      })
      if (!entry.success) {
        throw new CliError(`cannot add ${target}: ${entry.error.issues[0]?.message ?? 'invalid'}`)
      }

      const out = ctx.io.stdout
      out.write(`${manifest.name} ${manifest.version} from ${dir}\n`)
      // What the driver declares in its manifest. The driver's own offered(options) is known only after the import.
      out.write(`  declares:  ${manifest.capabilities.map((c) => c.id).join(', ')}\n`)
      out.write(`  platforms: ${manifest.platforms.join(', ')}\n`)
      for (const line of permissionNotes(manifest.needs, process.platform)) {
        out.write(`  ${line}\n`)
      }
      if (Object.keys(options).length > 0) {
        out.write(
          `  options:   ${Object.entries(options)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ')}\n`,
        )
      }
      if (sandbox) {
        out.write(`  pulls:     ${pulls.join(', ')} (through ${runtime}, before the install)\n`)
      }
      if (!ctx.bool('yes')) {
        if (!isInteractive(ctx.io)) {
          throw new CliError(
            'driver add asks before it installs: run it in a terminal or pass --yes',
          )
        }
        const question = sandbox
          ? `Pull ${pulls.length} images and install ${manifest.name} on this node?`
          : `Install ${manifest.name} on this node?`
        const ok = await confirm(question, { default: false, io: ctx.io })
        if (!ok) {
          out.write('Not installed.\n')
          return 0
        }
      }
      // The owner agreed: only now the entry is imported (its code runs). The folder must still match the hash
      // taken above, so the config records the code that was checked.
      let loaded: LoadedDriver
      try {
        loaded = await loadDriver(dir)
      } catch (error) {
        throw new CliError(`cannot add ${target}: ${(error as Error).message}`)
      }
      if ((await driverFingerprint(dir)) !== entry.data.sha256) {
        throw new CliError(
          `cannot add ${target}: the folder changed while it was checked; run driver add again`,
        )
      }
      const offered = loaded.driver.offered?.(options) ?? manifest.capabilities
      const offeredIds = new Set<string>(offered.map((c) => c.id))
      const withheld = manifest.capabilities.filter((c) => !offeredIds.has(c.id))
      out.write(`  can do:    ${[...offeredIds].join(', ')}\n`)
      if (withheld.length > 0) {
        out.write(
          `  withheld:  ${withheld.map((c) => c.id).join(', ')} (the driver offers them only with an option, e.g. --allow-input for desktop.input)\n`,
        )
      }
      for (const image of pulls) {
        out.write(`pulling ${image}\n`)
        const pulled = await (host.run ?? defaultRun)(pullArgv(runtime, image))
        if (pulled.exitCode !== 0) {
          const reason = pulled.stderr.trim().split('\n').pop() ?? ''
          throw new CliError(`cannot add sandbox: ${runtime} pull ${image} failed: ${reason}`)
        }
      }
      await saveConfig(configPath, withDriver(config, entry.data))
      out.write(
        `Installed ${manifest.name} ${manifest.version}. Restart keith-node run to announce it.\n`,
      )
      return 0
    },
  })

/** The config with `entry` added, or replacing the entry of the same name (how a changed driver is re-hashed). */
function withDriver(config: NodeConfig, entry: NodeConfig['drivers'][number]): NodeConfig {
  const exists = config.drivers.some((d) => d.name === entry.name)
  const drivers = exists
    ? config.drivers.map((d) => (d.name === entry.name ? entry : d))
    : [...config.drivers, entry]
  return { ...config, drivers }
}

const removeCommand: Command = defineCommand({
  name: 'remove',
  summary: 'Remove a driver from the node config (nothing is sent to the core)',
  usage: '<name>',
  positionals: true,
  flags: { config: configFlag },
  examples: ['keith-node driver remove desktop'],
  run: async (ctx) => {
    const [name, ...extra] = ctx.positionals
    if (name === undefined || extra.length > 0) {
      throw new UsageError('driver remove takes one driver name', ctx.path)
    }
    const configPath = resolveConfigPath(ctx.string('config'))
    const config = await loadConfig(configPath)
    if (!config.drivers.some((d) => d.name === name)) {
      throw new CliError(`no driver named ${name} is installed`)
    }
    await saveConfig(configPath, {
      ...config,
      drivers: config.drivers.filter((d) => d.name !== name),
    })
    ctx.io.stdout.write(`Removed ${name}. Restart keith-node run to stop announcing it.\n`)
    return 0
  },
})
