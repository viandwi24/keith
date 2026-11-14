import { describe, expect, test } from 'bun:test'
import { defineKeithPlugin, defineOperation } from './define.ts'
import { PROTOCOL_NOTIFY_TEXT_MAX, PROTOCOL_WAKE_TEXT_MAX } from './protocols.ts'
import { z } from './schema.ts'
import { memoryHost } from './testing/index.ts'

// k.protocols (docs/specs/plugins/reminders.md, "Internals"): the memory double records what the plugin asks, the
// step rule and the text limits are the host's, and a run's end reaches the plugin's own handler only.
const In = z.object({
  key: z.string(),
  owner: z.string(),
  step: z.enum(['notify', 'wake']).optional(),
  to: z.string().optional(),
  text: z.string(),
  at: z.number().optional(),
})
const plugin = defineKeithPlugin({
  id: 'remind',
  version: '1.0.0',
  apiVersion: 1,
  operations: [
    defineOperation({
      name: 'set',
      description: 'set',
      input: In,
      output: z.object({}).passthrough(),
      permission: { capability: 'authenticated' },
      async run(i, k) {
        const info = await k.protocols.upsertTime({
          key: i.key,
          owner: i.owner,
          when: { kind: 'once', at: i.at ?? Date.now() + 60_000 },
          step: i.step ?? 'notify',
          ...(i.to === undefined ? {} : { to: i.to }),
          text: i.text,
        })
        return { protocolId: info.protocolId, nextFireAt: info.nextFireAt }
      },
    }),
    defineOperation({
      name: 'drop',
      description: 'drop',
      input: z.object({ key: z.string(), owner: z.string() }),
      output: z.object({ ok: z.boolean() }),
      permission: { capability: 'authenticated' },
      async run(i, k) {
        return { ok: await k.protocols.cancel(i.key, i.owner) }
      },
    }),
  ],
})

const setup = () => {
  const host = memoryHost({ plugins: [plugin] })
  host.add('boss', 'owner')
  host.add('ana')
  host.add('ben')
  return host
}
const code = async (p: Promise<unknown>) => {
  try {
    await p
    return 'none'
  } catch (e) {
    return (e as { code?: string }).code
  }
}

describe('k.protocols in the memory host', () => {
  test('a member sets a time step for themselves and cancels it; the double records both', async () => {
    const host = setup()
    const set = await host.call(
      'remind',
      'set',
      { key: 'r1', owner: 'ana', text: 'stand up' },
      'ana',
    )
    expect(set).toMatchObject({ protocolId: expect.any(String), nextFireAt: expect.any(Number) })
    expect(host.protocols.rows.get('remind:ana:r1')).toMatchObject({
      owner: 'ana',
      step: 'notify',
      to: 'ana',
      text: 'stand up',
    })
    expect(await host.call('remind', 'drop', { key: 'r1', owner: 'ana' }, 'ana')).toEqual({
      ok: true,
    })
    expect(host.protocols.rows.has('remind:ana:r1')).toBe(false)
  })

  test('a member cannot set a step for another person or for someone else as owner: nothing is stored', async () => {
    const host = setup()
    expect(
      await code(
        host.call('remind', 'set', { key: 'r2', owner: 'ana', to: 'ben', text: 'hi' }, 'ana'),
      ),
    ).toBe('FORBIDDEN')
    expect(
      await code(host.call('remind', 'set', { key: 'r3', owner: 'ben', text: 'hi' }, 'ana')),
    ).toBe('FORBIDDEN')
    expect(host.protocols.rows.size).toBe(0)
  })

  test('no one sets a step for another person through a person-owned protocol, the owner role included', async () => {
    const host = setup()
    expect(
      await code(
        host.call('remind', 'set', { key: 'r4', owner: 'ana', to: 'ben', text: 'hi' }, 'boss'),
      ),
    ).toBe('FORBIDDEN')
    expect(host.protocols.rows.has('remind:ana:r4')).toBe(false)
  })

  test('a text over the step limit is refused at creation, never cut; a bad key and a wrong step too', async () => {
    const host = setup()
    const long = (n: number) => 'x'.repeat(n)
    expect(
      await code(
        host.call(
          'remind',
          'set',
          { key: 'a1', owner: 'ana', text: long(PROTOCOL_NOTIFY_TEXT_MAX + 1) },
          'ana',
        ),
      ),
    ).toBe('INVALID_INPUT')
    expect(
      await code(
        host.call(
          'remind',
          'set',
          { key: 'a2', owner: 'ana', step: 'wake', text: long(PROTOCOL_WAKE_TEXT_MAX + 1) },
          'ana',
        ),
      ),
    ).toBe('INVALID_INPUT')
    expect(
      await code(host.call('remind', 'set', { key: 'bad key!', owner: 'ana', text: 'hi' }, 'ana')),
    ).toBe('INVALID_INPUT')
    expect(
      await code(
        host.call(
          'remind',
          'set',
          { key: 'a3', owner: 'ana', step: 'wake', text: long(PROTOCOL_WAKE_TEXT_MAX) },
          'ana',
        ),
      ),
    ).toBe('none')
    expect(
      await code(
        host.call(
          'remind',
          'set',
          { key: 'a4', owner: 'ana', text: long(PROTOCOL_NOTIFY_TEXT_MAX) },
          'ana',
        ),
      ),
    ).toBe('none')
    expect([...host.protocols.rows.keys()].sort()).toEqual(['remind:ana:a3', 'remind:ana:a4'])
  })

  test("a member cancels only what is theirs: another person's protocol is not removed", async () => {
    const host = setup()
    await host.call('remind', 'set', { key: 'r5', owner: 'ana', text: 'hi' }, 'ana')
    expect(await host.call('remind', 'drop', { key: 'r5', owner: 'ana' }, 'ben')).toEqual({
      ok: false,
    })
    expect(host.protocols.rows.has('remind:ana:r5')).toBe(true)
  })

  test('a run that ends reaches the handler of its own plugin only, until unsubscribed', async () => {
    const host = setup()
    await host.call('remind', 'set', { key: 'r6', owner: 'ana', text: 'hi' }, 'ana')
    const seen: string[] = []
    const stop = host.protocols.port.onRunEnd('remind', (end) =>
      seen.push(`${end.key}:${end.status}`),
    )
    host.protocols.endRun('remind', 'r6', 'run_1', 'done')
    host.protocols.endRun('other', 'r6', 'run_2', 'done')
    expect(seen).toEqual(['r6:done'])
    stop()
    host.protocols.endRun('remind', 'r6', 'run_3', 'failed')
    expect(seen).toEqual(['r6:done'])
  })
})
