import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runCli } from '@keith/cli'
import { fakeIo } from '@keith/cli/testing'
import { driverCommand, permissionNotes, type SandboxHost } from './driver-command.ts'
import {
  type DriverEntry,
  driverFingerprint,
  loadConfig,
  type NodeConfig,
  saveConfig,
} from './platform/config.ts'

let root: string
let packages: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'keith-node-driver-'))
  packages = join(root, 'packages')
  // a bundled desktop driver for this platform; sandbox is not in the fixture folder
  await writeDriver(join(packages, 'driver-desktop'), 'desktop')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A driver folder whose entry needs no SDK import (a fixture folder has no node_modules). */
async function writeDriver(dir: string, name: string, body = 'ok'): Promise<void> {
  await mkdir(join(dir, 'dist'), { recursive: true })
  await writeFile(
    join(dir, 'keith-driver.json'),
    JSON.stringify({
      manifestVersion: 1,
      name,
      version: '0.1.0',
      entry: 'dist/index.js',
      capabilities: [{ id: `${name}.ping`, schemaVersion: 1 }],
      platforms: [process.platform],
      needs: ['screen-recording'],
    }),
  )
  await writeFile(
    join(dir, 'dist', 'index.js'),
    `export default { name: '${name}', version: '0.1.0', capabilities: [{ id: '${name}.ping', schemaVersion: 1 }], invoke: () => ({ ok: true, output: '${body}' }) }\n`,
  )
}

/** A path driver whose entry writes `marker` when it is imported (and throws right after, when asked). */
async function writeMarkerDriver(
  dir: string,
  name: string,
  marker: string,
  options: { throwsOnImport?: boolean } = {},
): Promise<void> {
  await mkdir(join(dir, 'dist'), { recursive: true })
  await writeFile(
    join(dir, 'keith-driver.json'),
    JSON.stringify({
      manifestVersion: 1,
      name,
      version: '0.1.0',
      entry: 'dist/index.js',
      capabilities: [{ id: `${name}.ping`, schemaVersion: 1 }],
      platforms: [process.platform],
      needs: [],
    }),
  )
  await writeFile(
    join(dir, 'dist', 'index.js'),
    [
      "import { writeFileSync } from 'node:fs'",
      `writeFileSync(${JSON.stringify(marker)}, 'ran')`,
      options.throwsOnImport ? "throw new Error('the entry ran')" : '',
      `export default { name: '${name}', version: '0.1.0', capabilities: [{ id: '${name}.ping', schemaVersion: 1 }], invoke: () => ({ ok: true, output: null }) }`,
      '',
    ].join('\n'),
  )
}

async function setupConfig(path: string, drivers: DriverEntry[] = []): Promise<void> {
  const config: NodeConfig = {
    core: 'http://core.test:1',
    nodeId: 'n1',
    token: 't',
    name: 'box',
    policy: { allowShell: false, workdir: join(root, 'w') },
    drivers,
  }
  await saveConfig(path, config)
}

function run(argv: string[], io = fakeIo()) {
  return runCli({
    program: 'keith-node',
    version: '0.1.0',
    commands: [driverCommand({ packagesRoot: packages })],
    argv,
    io,
  }).then((code) => ({ code, out: io.out(), err: io.err() }))
}

describe('keith-node driver', () => {
  test('--help lists list, add and remove', async () => {
    const { code, out } = await run(['driver', '--help'])
    expect(code).toBe(0)
    expect(out).toContain('list')
    expect(out).toContain('add')
    expect(out).toContain('remove')
  })

  test('add a folder with --yes writes a path entry with the hash and options', async () => {
    const config = join(root, 'node.json')
    await setupConfig(config)
    const folder = join(root, 'fake')
    await writeDriver(folder, 'fake')
    const { code, out } = await run([
      'driver',
      'add',
      folder,
      '--yes',
      '--config',
      config,
      '--option',
      'allowInput=true',
      '--option',
      'limit=5',
      '--option',
      'label=lab',
    ])
    expect(code).toBe(0)
    expect(out).toContain('Restart keith-node run to announce it')
    const saved = (await loadConfig(config)).drivers
    expect(saved).toEqual([
      {
        name: 'fake',
        source: 'path',
        path: resolve(folder),
        sha256: await driverFingerprint(folder),
        options: { allowInput: true, limit: 5, label: 'lab' },
      },
    ])
  })

  test('add a bundled name writes a bundled entry without a path', async () => {
    const config = join(root, 'node.json')
    await setupConfig(config)
    const { code } = await run([
      'driver',
      'add',
      'desktop',
      '--yes',
      '--config',
      config,
      '--allow-input',
    ])
    expect(code).toBe(0)
    const [entry] = (await loadConfig(config)).drivers
    expect(entry).toMatchObject({
      name: 'desktop',
      source: 'bundled',
      options: { allowInput: true },
    })
    expect(entry?.path).toBeUndefined()
  })

  test('without --yes and no terminal, add refuses and writes nothing', async () => {
    const config = join(root, 'node.json')
    await setupConfig(config)
    const { code, err } = await run(['driver', 'add', 'desktop', '--config', config])
    expect(code).toBe(1)
    expect(err).toContain('--yes')
    expect((await loadConfig(config)).drivers).toEqual([])
  })

  test('a declined confirmation installs nothing; a yes installs', async () => {
    const config = join(root, 'node.json')
    await setupConfig(config)
    const declined = fakeIo({ tty: true })
    const no = runCli({
      program: 'keith-node',
      version: '0.1.0',
      commands: [driverCommand({ packagesRoot: packages })],
      argv: ['driver', 'add', 'desktop', '--config', config],
      io: declined,
    })
    declined.send('n\n')
    expect(await no).toBe(0)
    expect(declined.out()).toContain('Not installed')
    expect((await loadConfig(config)).drivers).toEqual([])

    const yes = fakeIo({ tty: true })
    const done = runCli({
      program: 'keith-node',
      version: '0.1.0',
      commands: [driverCommand({ packagesRoot: packages })],
      argv: ['driver', 'add', 'desktop', '--config', config],
      io: yes,
    })
    yes.send('y\n')
    expect(await done).toBe(0)
    expect((await loadConfig(config)).drivers.map((d) => d.name)).toEqual(['desktop'])
  })

  test('a declined add of a path driver never imports its entry: no marker, and no error', async () => {
    const config = join(root, 'node.json')
    await setupConfig(config)
    const folder = join(root, 'marked')
    const marker = join(root, 'marker-declined')
    await writeMarkerDriver(folder, 'marked', marker, { throwsOnImport: true })
    const io = fakeIo({ tty: true })
    const pending = runCli({
      program: 'keith-node',
      version: '0.1.0',
      commands: [driverCommand({ packagesRoot: packages })],
      argv: ['driver', 'add', folder, '--config', config],
      io,
    })
    io.send('n\n')
    expect(await pending).toBe(0)
    expect(io.out()).toContain('Not installed')
    expect(await Bun.file(marker).exists()).toBe(false)
    expect((await loadConfig(config)).drivers).toEqual([])
  })

  test('an accepted add imports the entry only after the confirmation, then writes the config', async () => {
    const config = join(root, 'node.json')
    await setupConfig(config)
    const folder = join(root, 'marked-yes')
    const marker = join(root, 'marker-accepted')
    await writeMarkerDriver(folder, 'marked', marker)
    const io = fakeIo({ tty: true })
    const pending = runCli({
      program: 'keith-node',
      version: '0.1.0',
      commands: [driverCommand({ packagesRoot: packages })],
      argv: ['driver', 'add', folder, '--config', config],
      io,
    })
    expect(await Bun.file(marker).exists()).toBe(false)
    io.send('y\n')
    expect(await pending).toBe(0)
    expect(await Bun.file(marker).exists()).toBe(true)
    expect((await loadConfig(config)).drivers.map((d) => d.name)).toEqual(['marked'])
  })

  test('a folder that does not load is refused with its reason', async () => {
    const config = join(root, 'node.json')
    await setupConfig(config)
    const folder = join(root, 'broken')
    await mkdir(folder, { recursive: true })
    const { code, err } = await run(['driver', 'add', folder, '--yes', '--config', config])
    expect(code).toBe(1)
    expect(err).toContain('cannot add')
    expect((await loadConfig(config)).drivers).toEqual([])
  })

  test('a built-in name cannot be installed', async () => {
    const config = join(root, 'node.json')
    await setupConfig(config)
    const folder = join(root, 'shell')
    await writeDriver(folder, 'shell')
    const { code, err } = await run(['driver', 'add', folder, '--yes', '--config', config])
    expect(code).toBe(1)
    expect(err).toContain('built-in')
  })

  test('add replaces the entry of the same name; a changed folder is listed as changed until added again', async () => {
    const config = join(root, 'node.json')
    await setupConfig(config)
    const folder = join(root, 'fake')
    await writeDriver(folder, 'fake', 'one')
    await run(['driver', 'add', folder, '--yes', '--config', config])
    await writeDriver(folder, 'fake', 'two')
    const listed = await run(['driver', 'list', '--config', config])
    expect(listed.out).toContain(
      'driver changed since it was added: run keith-node driver add again',
    )
    await run(['driver', 'add', folder, '--yes', '--config', config])
    expect((await loadConfig(config)).drivers).toHaveLength(1)
    expect((await run(['driver', 'list', '--config', config])).out).not.toContain('changed since')
  })

  test('list shows installed drivers and the bundled ones that can be added', async () => {
    const config = join(root, 'node.json')
    await setupConfig(config)
    await run(['driver', 'add', 'desktop', '--yes', '--config', config, '--allow-input'])
    const { code, out } = await run(['driver', 'list', '--config', config])
    expect(code).toBe(0)
    expect(out).toContain('desktop')
    expect(out).toContain('0.1.0')
    expect(out).toContain('desktop.ping')
    expect(out).toContain('allowInput=true')
    expect(out).toContain('fits this platform')
    expect(out).toContain('sandbox')
    expect(out).toContain('bundled folder not found')
    expect(out).not.toContain('Can be added (keith-node driver add <name>):\n  desktop')
  })

  test('remove deletes only its entry; a second remove is an error', async () => {
    const config = join(root, 'node.json')
    const folder = join(root, 'fake')
    await writeDriver(folder, 'fake')
    await setupConfig(config)
    await run(['driver', 'add', folder, '--yes', '--config', config])
    await run(['driver', 'add', 'desktop', '--yes', '--config', config])
    expect((await run(['driver', 'remove', 'fake', '--config', config])).code).toBe(0)
    expect((await loadConfig(config)).drivers.map((d) => d.name)).toEqual(['desktop'])
    const again = await run(['driver', 'remove', 'fake', '--config', config])
    expect(again.code).toBe(1)
    expect(again.err).toContain('no driver named fake')
  })

  test('a bad --runtime is a usage error', async () => {
    const config = join(root, 'node.json')
    await setupConfig(config)
    const { code } = await run(['driver', 'add', 'desktop', '--runtime', 'lxc', '--config', config])
    expect(code).toBe(2)
  })
})

/** A driver folder with source and a `build` script, but no entry yet (the bundled desktop after a fresh checkout). */
async function writeBuildable(dir: string, name: string): Promise<void> {
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({
      name,
      scripts: { build: 'bun build ./src/index.ts --outfile ./dist/index.js --target bun' },
    }),
  )
  await writeFile(
    join(dir, 'keith-driver.json'),
    JSON.stringify({
      manifestVersion: 1,
      name,
      version: '0.1.0',
      entry: 'dist/index.js',
      capabilities: [{ id: `${name}.ping`, schemaVersion: 1 }],
      platforms: [process.platform],
      needs: [],
    }),
  )
  await writeFile(
    join(dir, 'src', 'index.ts'),
    `export default { name: '${name}', version: '0.1.0', capabilities: [{ id: '${name}.ping', schemaVersion: 1 }], invoke: () => ({ ok: true, output: 'built' }) }\n`,
  )
}

describe('keith-node driver: build and announcement', () => {
  test('add rebuilds a bundled driver even when a stale entry exists', async () => {
    const dir = join(packages, 'driver-desktop')
    await writeBuildable(dir, 'desktop')
    await writeFile(join(dir, 'dist', 'index.js'), 'throw new Error("stale")\n')
    const config = join(root, 'node.json')
    await setupConfig(config)
    const { code } = await run(['driver', 'add', 'desktop', '--yes', '--config', config])
    expect(code).toBe(0)
    expect(await Bun.file(join(dir, 'dist', 'index.js')).text()).not.toContain('stale')
  })

  test('add builds a bundled driver whose entry is missing, then installs it', async () => {
    const dir = join(packages, 'driver-desktop')
    await rm(join(dir, 'dist'), { recursive: true, force: true })
    await writeBuildable(dir, 'desktop')
    const config = join(root, 'node.json')
    await setupConfig(config)
    const { code, out } = await run(['driver', 'add', 'desktop', '--yes', '--config', config])
    expect(code).toBe(0)
    expect(await Bun.file(join(dir, 'dist', 'index.js')).exists()).toBe(true)
    expect(out).toContain('Installed desktop 0.1.0')
    expect((await loadConfig(config)).drivers[0]?.name).toBe('desktop')
  })

  test('add of a bundled driver with no entry and no build script is refused and writes nothing', async () => {
    const dir = join(packages, 'driver-desktop')
    await rm(join(dir, 'dist'), { recursive: true, force: true })
    const config = join(root, 'node.json')
    await setupConfig(config)
    const { code, err } = await run(['driver', 'add', 'desktop', '--yes', '--config', config])
    expect(code).not.toBe(0)
    expect(err).toContain('has no build script')
    expect((await loadConfig(config)).drivers).toEqual([])
  })

  test('list builds a missing bundled entry before it reads the driver', async () => {
    const dir = join(packages, 'driver-desktop')
    await rm(join(dir, 'dist'), { recursive: true, force: true })
    await writeBuildable(dir, 'desktop')
    const config = join(root, 'node.json')
    await setupConfig(config)
    await run(['driver', 'list', '--config', config])
    expect(await Bun.file(join(dir, 'dist', 'index.js')).exists()).toBe(true)
  })

  test('permission notes name the macOS grants for the terminal, and only that on darwin', () => {
    const [line] = permissionNotes(['screen-recording', 'accessibility'], 'darwin')
    expect(line).toContain('macOS Screen Recording and Accessibility for the terminal')
    expect(line).toContain('Keith cannot grant them')
    expect(permissionNotes([], 'darwin')).toEqual([])
    expect(permissionNotes(['screen-recording'], 'linux')).toEqual(['needs:     screen-recording'])
  })

  test('add prints the capabilities a driver withholds with its options', async () => {
    const dir = join(root, 'gizmo')
    await mkdir(join(dir, 'dist'), { recursive: true })
    await writeFile(
      join(dir, 'keith-driver.json'),
      JSON.stringify({
        manifestVersion: 1,
        name: 'gizmo',
        version: '0.1.0',
        entry: 'dist/index.js',
        capabilities: [
          { id: 'gizmo.a', schemaVersion: 1 },
          { id: 'gizmo.b', schemaVersion: 1 },
        ],
        platforms: [process.platform],
        needs: [],
      }),
    )
    await writeFile(
      join(dir, 'dist', 'index.js'),
      `export default { name: 'gizmo', version: '0.1.0', capabilities: [{ id: 'gizmo.a', schemaVersion: 1 }, { id: 'gizmo.b', schemaVersion: 1 }], offered: () => [{ id: 'gizmo.a', schemaVersion: 1 }], invoke: () => ({ ok: true, output: null }) }\n`,
    )
    const config = join(root, 'node.json')
    await setupConfig(config)
    const { code, out } = await run(['driver', 'add', dir, '--yes', '--config', config])
    expect(code).toBe(0)
    expect(out).toContain('can do:    gizmo.a\n')
    expect(out).toContain('withheld:  gizmo.b')
  })
})

/** A fake host: the runtimes on PATH and a pull that records its command line (no runtime program runs). */
function fakeHost(runtimes: string[] = ['docker'], pullExit = 0) {
  const pulled: string[][] = []
  const host: SandboxHost = {
    which: (name) => (runtimes.includes(name) ? `/bin/${name}` : undefined),
    run: async (argv) => {
      pulled.push([...argv])
      return { exitCode: pullExit, stderr: pullExit === 0 ? '' : 'pull denied\n' }
    },
  }
  return { host, pulled }
}

function runSandbox(argv: string[], host: SandboxHost, io = fakeIo({ tty: true })) {
  return runCli({
    program: 'keith-node',
    version: '0.1.0',
    commands: [driverCommand({ packagesRoot: packages, sandbox: host })],
    argv,
    io,
  }).then((code) => ({ code, out: io.out(), err: io.err() }))
}

describe('keith-node driver add sandbox', () => {
  beforeEach(async () => {
    await writeDriver(join(packages, 'driver-sandbox'), 'sandbox')
  })

  test('no runtime on PATH: add fails with the install hint and writes nothing', async () => {
    const config = join(root, 'node.json')
    await setupConfig(config)
    const { host, pulled } = fakeHost([])
    const { code, err } = await runSandbox(
      ['driver', 'add', 'sandbox', '--yes', '--config', config],
      host,
    )
    expect(code).toBe(1)
    expect(err).toContain('install Docker')
    expect(err).toContain('Podman')
    expect(pulled).toEqual([])
    expect((await loadConfig(config)).drivers).toEqual([])
  })

  test('--yes pulls the four default images through docker and records the runtime and images', async () => {
    const config = join(root, 'node.json')
    await setupConfig(config)
    const { host, pulled } = fakeHost(['docker'])
    const { code, out } = await runSandbox(
      ['driver', 'add', 'sandbox', '--yes', '--config', config],
      host,
    )
    expect(code).toBe(0)
    expect(pulled).toEqual([
      ['docker', 'pull', 'alpine:3.20'],
      ['docker', 'pull', 'python:3.12-alpine'],
      ['docker', 'pull', 'node:22-alpine'],
      ['docker', 'pull', 'oven/bun:1.2-alpine'],
    ])
    expect(out).toContain('Installed sandbox 0.1.0')
    const entry = (await loadConfig(config)).drivers[0]
    expect(entry?.name).toBe('sandbox')
    expect(entry?.options).toEqual({
      runtime: 'docker',
      'image.sh': 'alpine:3.20',
      'image.python': 'python:3.12-alpine',
      'image.node': 'node:22-alpine',
      'image.bun': 'oven/bun:1.2-alpine',
    })
  })

  test('the confirmation asks to pull; declining pulls nothing and records nothing', async () => {
    const config = join(root, 'node.json')
    await setupConfig(config)
    const { host, pulled } = fakeHost(['docker'])
    const io = fakeIo({ tty: true })
    const pending = runSandbox(['driver', 'add', 'sandbox', '--config', config], host, io)
    io.send('n\n')
    const { code, out } = await pending
    expect(code).toBe(0)
    expect(out).toContain('Pull 4 images and install sandbox')
    expect(out).toContain('Not installed')
    expect(pulled).toEqual([])
    expect((await loadConfig(config)).drivers).toEqual([])
  })

  test('--runtime, --network and --image set what the node records', async () => {
    const config = join(root, 'node.json')
    await setupConfig(config)
    const { host, pulled } = fakeHost(['podman'])
    const { code } = await runSandbox(
      [
        'driver',
        'add',
        'sandbox',
        '--yes',
        '--runtime',
        'podman',
        '--network',
        '--image',
        'python=python:3.13-alpine',
        '--config',
        config,
      ],
      host,
    )
    expect(code).toBe(0)
    expect(pulled[1]).toEqual(['podman', 'pull', 'python:3.13-alpine'])
    expect((await loadConfig(config)).drivers[0]?.options).toMatchObject({
      runtime: 'podman',
      network: true,
      'image.python': 'python:3.13-alpine',
    })
  })

  test('a failed pull refuses the add and records nothing', async () => {
    const config = join(root, 'node.json')
    await setupConfig(config)
    const { host } = fakeHost(['docker'], 1)
    const { code, err } = await runSandbox(
      ['driver', 'add', 'sandbox', '--yes', '--config', config],
      host,
    )
    expect(code).toBe(1)
    expect(err).toContain('docker pull alpine:3.20 failed')
    expect((await loadConfig(config)).drivers).toEqual([])
  })

  test('driver list shows the runtime and the images of the installed sandbox', async () => {
    const config = join(root, 'node.json')
    await setupConfig(config)
    const { host } = fakeHost(['docker'])
    await runSandbox(['driver', 'add', 'sandbox', '--yes', '--config', config], host)
    const io = fakeIo()
    const code = await runCli({
      program: 'keith-node',
      version: '0.1.0',
      commands: [driverCommand({ packagesRoot: packages, sandbox: host })],
      argv: ['driver', 'list', '--config', config],
      io,
    })
    expect(code).toBe(0)
    expect(io.out()).toContain('runtime=docker')
    expect(io.out()).toContain('image.python=python:3.12-alpine')
  })

  test('a bad --image language or reference is a refusal; --image on another driver is a usage error', async () => {
    const config = join(root, 'node.json')
    await setupConfig(config)
    const { host } = fakeHost(['docker'])
    const badLang = await runSandbox(
      ['driver', 'add', 'sandbox', '--yes', '--image', 'ruby=x', '--config', config],
      host,
    )
    expect(badLang.code).toBe(2)
    const badRef = await runSandbox(
      ['driver', 'add', 'sandbox', '--yes', '--image', 'python=Has Space', '--config', config],
      host,
    )
    expect(badRef.code).toBe(1)
    expect(badRef.err).toContain('cannot add sandbox')
    const onDesktop = await runSandbox(
      ['driver', 'add', 'desktop', '--yes', '--image', 'python=x', '--config', config],
      host,
    )
    expect(onDesktop.code).toBe(2)
    expect((await loadConfig(config)).drivers).toEqual([])
  })
})
