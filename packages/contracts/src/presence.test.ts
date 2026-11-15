import { describe, expect, test } from 'bun:test'
import {
  ClientAckSchema,
  ClientCapabilitySchema,
  ClientEnvironmentSchema,
  ClientHeartbeatSchema,
  ClientKindSchema,
  ClientNetworkSchema,
  ClientRecordSchema,
  ClientRegisterSchema,
  DisclosureAudienceSchema,
  DisclosureLevelSchema,
  DisclosureSetSchema,
  PresenceSchema,
  PresenceStateSchema,
  PresenceStatusSetSchema,
  RENDER_CAPABILITY_IDS,
  RenderCapabilitySchema,
  SignalTypeSchema,
} from './presence.ts'

const id = '5f1c1d6e-2a4b-4c8d-9e0f-1a2b3c4d5e6f'
const registerBase = {
  id,
  kind: 'tui',
  label: 'laptop',
  version: '0.1.0',
}
const register = { ...registerBase, capabilities: ['chat', 'notify'] }

describe('client registration', () => {
  test('a tui client with chat and notify parses', () => {
    expect(ClientRegisterSchema.safeParse(register).success).toBe(true)
  })

  test('the id must be a uuid', () => {
    expect(ClientRegisterSchema.safeParse({ ...register, id: 'not-a-uuid' }).success).toBe(false)
    expect(ClientHeartbeatSchema.safeParse({ id: 'client-1', active: true }).success).toBe(false)
  })

  test('kinds are tui, web and mobile only', () => {
    expect(ClientKindSchema.options).toEqual(['tui', 'web', 'mobile'])
    expect(ClientRegisterSchema.safeParse({ ...register, kind: 'desktop' }).success).toBe(false)
  })

  test('at most ten capabilities and a label of forty characters', () => {
    const eleven = Array.from({ length: 11 }, () => 'chat')
    expect(ClientRegisterSchema.safeParse({ ...register, capabilities: eleven }).success).toBe(
      false,
    )
    expect(ClientRegisterSchema.safeParse({ ...register, label: 'x'.repeat(41) }).success).toBe(
      false,
    )
  })

  test('a record adds the person, the times and whether it is online', () => {
    const record = {
      ...register,
      personId: 'ana',
      firstSeenAt: 1,
      lastSeenAt: 2,
      lastActiveAt: null,
      online: true,
    }
    expect(ClientRecordSchema.safeParse(record).success).toBe(true)
    expect(ClientRecordSchema.safeParse({ ...record, lastActiveAt: undefined }).success).toBe(false)
  })

  test('an ack names its delivery, carries an optional result of at most 4000 characters', () => {
    const ack = { id, deliveryId: 'reminder:r1', ok: true }
    expect(ClientAckSchema.safeParse(ack).success).toBe(true)
    expect(ClientAckSchema.safeParse({ ...ack, result: 'done' }).success).toBe(true)
    expect(ClientAckSchema.safeParse({ ...ack, result: 'x'.repeat(4001) }).success).toBe(false)
    expect(ClientAckSchema.safeParse({ ...ack, deliveryId: '' }).success).toBe(false)
  })
})

describe('capability ids (ADR-0023 §5)', () => {
  test('the ids are lowercase words with at most one dot (the `client.` prefix is a naming rule of the docs, not checked here)', () => {
    for (const ok of ['chat', 'notify', 'open.view', 'location.share'])
      expect(ClientCapabilitySchema.safeParse(ok).success, ok).toBe(true)
  })

  test('no prefix, no upper case, no empty or deeper names', () => {
    for (const bad of ['Notify', 'open.view.now', '', 'open_view', 'notify!', '1notify'])
      expect(ClientCapabilitySchema.safeParse(bad).success, bad).toBe(false)
  })
})

describe('rendering ids (ADR-0029 §5)', () => {
  test('a client may declare render.markdown and render.speech-only', () => {
    for (const ok of ['render.markdown', 'render.speech-only'])
      expect(ClientCapabilitySchema.safeParse(ok).success, ok).toBe(true)
    expect(RENDER_CAPABILITY_IDS).toEqual(['render.markdown', 'render.speech-only'])
    const register = { ...registerBase, capabilities: ['chat', 'render.markdown'] }
    expect(ClientRegisterSchema.safeParse(register).success).toBe(true)
  })

  test('the render ids are a closed set: render.table and other render names are refused', () => {
    for (const bad of ['render.table', 'render.html', 'render.markdown.full'])
      expect(RenderCapabilitySchema.safeParse(bad).success, bad).toBe(false)
    expect(RenderCapabilitySchema.safeParse('render.markdown').success).toBe(true)
    expect(RenderCapabilitySchema.safeParse('render.speech-only').success).toBe(true)
  })

  test('a hyphen is allowed in the second segment only', () => {
    expect(ClientCapabilitySchema.safeParse('speech-only').success).toBe(false)
    expect(ClientCapabilitySchema.safeParse('render-markdown.x').success).toBe(false)
  })
})

describe('presence', () => {
  test('states are the five of ADR-0025 §3', () => {
    expect(PresenceStateSchema.options).toEqual(['active', 'idle', 'away', 'busy', 'offline'])
  })

  test('a presence names its clients and a note of at most 200 characters', () => {
    const presence = {
      personId: 'ana',
      state: 'busy',
      reachableOn: [id],
      activeClient: null,
      note: 'in a meeting until 10:00',
      asOf: 1,
    }
    expect(PresenceSchema.safeParse(presence).success).toBe(true)
    expect(PresenceSchema.safeParse({ ...presence, note: 'x'.repeat(201) }).success).toBe(false)
    // `where` and `until` are optional (an older reader keeps working) and `where` is a closed set
    expect(PresenceSchema.safeParse({ ...presence, where: 'desk', until: 5 }).success).toBe(true)
    expect(PresenceSchema.safeParse({ ...presence, where: 'home' }).success).toBe(false)
  })

  test('signal types are the six of ADR-0025 §1', () => {
    expect(SignalTypeSchema.options).toEqual([
      'client.connected',
      'client.disconnected',
      'client.active',
      'device.location',
      'node.event',
      'activity',
    ])
  })

  test('the manual status takes a busy flag, a note and minutes between 1 and 1440', () => {
    expect(PresenceStatusSetSchema.safeParse({ busy: true, minutes: 30 }).success).toBe(true)
    expect(PresenceStatusSetSchema.safeParse({ busy: false }).success).toBe(true)
    expect(PresenceStatusSetSchema.safeParse({ busy: true, minutes: 0 }).success).toBe(false)
    expect(PresenceStatusSetSchema.safeParse({ busy: true, minutes: 1441 }).success).toBe(false)
  })
})

describe('disclosure', () => {
  test('levels are none, state and detail', () => {
    expect(DisclosureLevelSchema.options).toEqual(['none', 'state', 'detail'])
  })

  test('audiences are the owner, every member, or a group id', () => {
    for (const ok of ['owner', '@users', 'group:team_1', 'group:a-b'])
      expect(DisclosureAudienceSchema.safeParse(ok).success, ok).toBe(true)
    for (const bad of ['@public', 'group:', 'group:a b', 'member', 'Owner'])
      expect(DisclosureAudienceSchema.safeParse(bad).success, bad).toBe(false)
  })

  test('a set names one audience and one level', () => {
    expect(DisclosureSetSchema.safeParse({ audience: '@users', level: 'state' }).success).toBe(true)
    expect(DisclosureSetSchema.safeParse({ audience: 'owner', level: 'all' }).success).toBe(false)
  })
})

describe('client environment (docs/decisions/0033 §2)', () => {
  const env = {
    host: 'ana-laptop',
    os: 'macos',
    osVersion: '15.2',
    arch: 'arm64',
    device: 'laptop',
    timezone: 'Europe/Paris',
    locale: 'id-ID',
  } as const

  test('a complete environment parses, and a register may leave it out', () => {
    expect(ClientEnvironmentSchema.parse(env)).toEqual(env)
    expect(ClientRegisterSchema.parse({ ...register, environment: env }).environment).toEqual(env)
    expect(ClientRegisterSchema.parse(register).environment).toBeUndefined()
  })

  test('the enums are closed: an unknown OS or device kind is refused', () => {
    expect(ClientEnvironmentSchema.safeParse({ ...env, os: 'freebsd' }).success).toBe(false)
    expect(ClientEnvironmentSchema.safeParse({ ...env, device: 'tablet' }).success).toBe(false)
    expect(ClientEnvironmentSchema.safeParse({ ...env, device: 'phone' }).success).toBe(true)
  })

  test('the length caps hold: host 60, OS version 40, arch 20, locale 20', () => {
    expect(ClientEnvironmentSchema.safeParse({ ...env, host: 'h'.repeat(61) }).success).toBe(false)
    expect(ClientEnvironmentSchema.safeParse({ ...env, osVersion: 'v'.repeat(41) }).success).toBe(
      false,
    )
    expect(ClientEnvironmentSchema.safeParse({ ...env, arch: 'a'.repeat(21) }).success).toBe(false)
    expect(ClientEnvironmentSchema.safeParse({ ...env, locale: 'l'.repeat(21) }).success).toBe(
      false,
    )
  })

  test('the time zone must be a zone the platform knows', () => {
    expect(ClientEnvironmentSchema.safeParse({ ...env, timezone: 'Mars/Olympus' }).success).toBe(
      false,
    )
    expect(ClientEnvironmentSchema.safeParse({ ...env, timezone: 'UTC' }).success).toBe(true)
  })

  test('control characters are removed from every text, and white space is folded', () => {
    const cleaned = ClientEnvironmentSchema.parse({
      ...env,
      host: 'ana\u0000\n-laptop\u001b[31m',
      osVersion: '15 \t.2\u007f',
    })
    expect(cleaned.host).toBe('ana-laptop[31m')
    expect(cleaned.osVersion).toBe('15 .2')
  })

  test('no field carries an address, a user name or a path', () => {
    expect(Object.keys(ClientEnvironmentSchema.shape).sort()).toEqual([
      'arch',
      'device',
      'host',
      'locale',
      'os',
      'osVersion',
      'timezone',
    ])
  })

  test('the network is a closed set the core derives', () => {
    for (const network of ['local-socket', 'loopback', 'lan', 'tailscale', 'public'])
      expect(ClientNetworkSchema.safeParse(network).success).toBe(true)
    expect(ClientNetworkSchema.safeParse('wifi').success).toBe(false)
  })
})
