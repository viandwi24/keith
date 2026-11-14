import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type BootedCore, bootCore } from '../testing/boot-core.ts'
import { testIo } from '../testing/cli-io.ts'
import type { CliDeps } from './context.ts'
import { runCoreCli } from './program.ts'

// `keith-core nodes sandbox-limit [<n>]` over the owner socket (node-drivers.md "Settings", core-cli.md): no argument
// prints the calls per hour, a whole number 1 to 1000 sets it. The RPC itself is tested in modules/nodes/settings.test.ts.
let b: BootedCore
let deps: CliDeps

beforeAll(async () => {
  b = await bootCore()
  deps = { env: { KEITH_DATA_DIR: b.dir, KEITH_BUILD_SHA: 'test' } }
})
afterAll(async () => {
  await b.stop()
})

async function cli(...argv: string[]) {
  const io = testIo()
  io.end()
  const code = await runCoreCli(argv, io, deps)
  return { code, out: io.out(), err: io.err() }
}

describe('keith-core nodes sandbox-limit', () => {
  test('no argument prints the value with its bounds and default', async () => {
    const res = await cli('nodes', 'sandbox-limit')
    expect(res.code).toBe(0)
    expect(res.out).toContain('sandbox: 60 calls per hour per person (1 to 1000, default 60)')
  })

  test('a whole number sets the value and prints the value in force', async () => {
    const res = await cli('nodes', 'sandbox-limit', '12')
    expect(res.code).toBe(0)
    expect(res.out).toContain('sandbox: 12 calls per hour per person')
    expect((await b.local.rpc.nodes.settings.get()).maxPerHourPerPerson).toBe(12)
    await cli('nodes', 'sandbox-limit', '60')
  })

  test('the bounds 1 and 1000 are accepted', async () => {
    expect((await cli('nodes', 'sandbox-limit', '1000')).code).toBe(0)
    expect((await cli('nodes', 'sandbox-limit', '1')).code).toBe(0)
    expect((await b.local.rpc.nodes.settings.get()).maxPerHourPerPerson).toBe(1)
    await cli('nodes', 'sandbox-limit', '60')
  })

  test('out of bounds, fractions and words are usage errors and nothing changes', async () => {
    for (const bad of ['0', '1001', '2.5', 'many', '']) {
      const res = await cli('nodes', 'sandbox-limit', bad)
      expect(res.code, `input ${JSON.stringify(bad)}`).toBe(2)
      expect(res.err).toContain('give a whole number of calls per hour, 1 to 1000')
    }
    expect((await cli('nodes', 'sandbox-limit', '-1')).code).toBe(2)
    expect((await b.local.rpc.nodes.settings.get()).maxPerHourPerPerson).toBe(60)
  })

  test('too many arguments is a usage error', async () => {
    expect((await cli('nodes', 'sandbox-limit', '5', '6')).code).toBe(2)
    expect((await b.local.rpc.nodes.settings.get()).maxPerHourPerPerson).toBe(60)
  })

  test('the command is listed in the nodes help', async () => {
    const res = await cli('nodes', '--help')
    expect(res.out).toContain('sandbox-limit')
  })
})
