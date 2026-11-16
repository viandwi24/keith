// The model tools of the front agent (ADR-0034 §8): owner only, the switch a reversible write with an undo, an unknown model
// refused, and the same audit row as `models.roles.set`.
import { describe, expect, test } from 'bun:test'
import { migrateDatabase, openDatabase, settingsRepo, sqliteProfileStore } from '@keith/db'
import type { HarnessContext } from 'eharness'
import { sealedProfileStore } from 'eharness/providers'
import { resolvePlugin, scriptedProvider } from 'eharness/testing'
import { createUndoLog } from '../../platform/undo-log.ts'
import { createVault, generateSecretKey } from '../../platform/vault.ts'
import {
  createModelToolsPlugin,
  MODEL_ROLE_SET_TOOL,
  MODEL_ROLES_GET_TOOL,
  MODEL_TOOLS_PLUGIN,
  modelToolsOf,
} from './model-tools.ts'
import { createProviderService } from './service.ts'

type Exec = { execute: (input: unknown, options: unknown) => Promise<Record<string, unknown>> }
const OPTIONS = { toolCallId: 't1', messages: [], abortSignal: new AbortController().signal }

async function world() {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  const { vault } = createVault(generateSecretKey(), '/unused')
  const providers = createProviderService({
    store: sealedProfileStore({ inner: sqliteProfileStore(sqlite), vault }),
    settings: settingsRepo(sqlite),
    definitions: [scriptedProvider({ models: { a: [{ text: 'a' }], b: [{ text: 'b' }] } })],
    catalogs: { offline: true },
  })
  await providers.ready()
  await providers.put({ providerId: 'scripted' })
  const audit: { kind: string; actor: string; via: string; detail?: unknown }[] = []
  const deps = {
    providers,
    audit: { record: (e: (typeof audit)[number]) => void audit.push(e) },
    isOwner: async (id: string) => id === 'boss',
  }
  const tools = modelToolsOf(deps)
  const run = (name: keyof typeof tools, as: string | undefined, input: unknown = {}) =>
    (
      tools[name]({
        session: { id: `front:${as}` },
        ...(as === undefined ? {} : { principal: { id: as } }),
      } as unknown as HarnessContext) as unknown as Exec
    ).execute(input, OPTIONS)
  return { providers, audit, deps, run }
}

describe('model tools', () => {
  test('a member is refused both tools and nothing changes', async () => {
    const w = await world()
    expect(await w.run(MODEL_ROLES_GET_TOOL, 'ana')).toMatchObject({
      ok: false,
      reason: 'not-owner',
    })
    expect(
      await w.run(MODEL_ROLE_SET_TOOL, 'ana', { role: 'front', model: 'scripted:a' }),
    ).toMatchObject({ ok: false, reason: 'not-owner' })
    expect((await w.providers.roles()).front).not.toBe('scripted:a')
    expect(w.audit).toHaveLength(0)
    expect(await w.run(MODEL_ROLES_GET_TOOL, undefined)).toMatchObject({ reason: 'no-person' })
  })

  test('the owner switches a role: the pick changes and one audit row is written', async () => {
    const w = await world()
    const done = await w.run(MODEL_ROLE_SET_TOOL, 'boss', { role: 'front', model: 'scripted:b' })
    expect(done).toMatchObject({ ok: true, role: 'front', model: 'scripted:b' })
    expect((await w.providers.roles()).front).toBe('scripted:b')
    expect(await w.run(MODEL_ROLES_GET_TOOL, 'boss')).toMatchObject({
      ok: true,
      roles: { front: 'scripted:b' },
    })
    expect(w.audit).toEqual([
      {
        kind: 'settings.model.set',
        actor: 'boss',
        via: 'local',
        detail: { role: 'front', ref: 'scripted:b' },
      },
    ])
  })

  test('an unknown connection is an answer, not a throw, and writes nothing', async () => {
    const w = await world()
    for (const model of ['missing:x', 'nope:a'])
      expect(await w.run(MODEL_ROLE_SET_TOOL, 'boss', { role: 'cortex', model })).toMatchObject({
        ok: false,
        reason: 'unknown-model',
      })
    expect((await w.providers.roles()).cortex).toBeNull()
    expect(w.audit).toHaveLength(0)
  })

  test('the plugin declares model_role_set a reversible write and the reads trusted; it asks for nothing itself (consent decides)', async () => {
    const w = await world()
    const resolved = await resolvePlugin(createModelToolsPlugin(w.deps))
    expect(resolved.name).toBe(MODEL_TOOLS_PLUGIN)
    expect(Object.keys(resolved.tools).sort()).toEqual(['model_role_set', 'model_roles_get'])
    const meta = (name: string) =>
      (resolved.tools[name] as unknown as { metadata?: unknown } | undefined)?.metadata
    expect(meta(MODEL_ROLE_SET_TOOL)).toEqual({
      risk: 'write',
      reversible: true,
      source: 'trusted',
      effect: 'behavior',
    })
    expect(meta(MODEL_ROLES_GET_TOOL)).toEqual({ risk: 'read', source: 'trusted' })
    expect(
      await resolved.runHook(
        'tool.approve',
        { toolName: MODEL_ROLE_SET_TOOL, toolCallId: 'c', input: {}, transcript: () => [] },
        { session: { id: 's' } } as Partial<HarnessContext>,
      ),
    ).toBeUndefined()
  })

  test('undo: the switch is taken back to the previous model, audited like the switch; the first pick has nothing to restore', async () => {
    const undo = createUndoLog()
    const w = await world()
    const tools = modelToolsOf({ ...w.deps, undo })
    const ctx = {
      session: { id: 'front:boss' },
      principal: { id: 'boss' },
    } as unknown as HarnessContext
    const set = (model: string) =>
      (tools[MODEL_ROLE_SET_TOOL](ctx) as unknown as Exec).execute(
        { role: 'front', model },
        OPTIONS,
      )
    await set('scripted:a')
    expect(undo.size('front:boss', 'boss')).toBe(0)
    await set('scripted:b')
    expect((await w.providers.roles()).front).toBe('scripted:b')
    const entry = undo.take('front:boss', 'boss')
    expect(await entry?.undo()).toMatchObject({ ok: true })
    expect((await w.providers.roles()).front).toBe('scripted:a')
    expect(w.audit.map((a) => (a.detail as { ref: string }).ref)).toEqual([
      'scripted:a',
      'scripted:b',
      'scripted:a',
    ])
  })
})
