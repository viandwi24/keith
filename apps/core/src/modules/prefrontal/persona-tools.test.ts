// The persona and style tools of the front agent (docs/specs/prefrontal.md "Tools in conversation", ADR-0034 §3): the speaker's
// own style only, owner-only persona tools, approval for the persona tools, the same audit rows as the RPC path, and the
// onboarding block that exists only while the person has no style row.
import { describe, expect, test } from 'bun:test'
import { DEFAULT_PERSON_STYLE } from '@keith/contracts'
import type { HarnessContext } from 'eharness'
import { resolvePlugin } from 'eharness/testing'
import { createUndoLog } from '../../platform/undo-log.ts'
import { prefrontalWorld, rowsOf } from './fixtures.ts'
import { createOnboarding } from './onboarding.ts'
import {
  createPersonaToolsPlugin,
  PERSONA_APPROVAL_TOOLS,
  PERSONA_TOOLS_PLUGIN,
  personaToolsOf,
} from './persona-tools.ts'
import { createPersonaService } from './service.ts'
import { createPersonStyleService } from './style.ts'

type Exec = { execute: (input: unknown, options: unknown) => Promise<Record<string, unknown>> }
const OPTIONS = { toolCallId: 't1', messages: [], abortSignal: new AbortController().signal }

function world() {
  const w = prefrontalWorld()
  const persona = createPersonaService({
    persona: w.persona,
    people: w.people,
    audit: w.recorder,
    activity: w.act,
  })
  persona.seed('professional')
  const styles = createPersonStyleService({
    generations: { current: () => 0 },
    styles: w.styles,
    people: w.people,
    audit: w.recorder,
    aclAudit: w.aclAudit,
    activity: w.act,
  })
  const tools = personaToolsOf({ persona, styles })
  const ctxOf = (id?: string) =>
    ({
      session: { id: `front:${id}` },
      ...(id === undefined ? {} : { principal: { id } }),
    }) as unknown as HarnessContext
  const run = (name: keyof typeof tools, as: string | undefined, input: unknown = {}) =>
    (tools[name](ctxOf(as)) as unknown as Exec).execute(input, OPTIONS)
  return { ...w, persona, styles, run, onboarding: createOnboarding({ styles, people: w.people }) }
}

const ctxFor = (id: string) =>
  ({ session: { id: `front:${id}` }, principal: { id } }) as unknown as HarnessContext

describe('style_get and style_set', () => {
  test("style_set saves the speaker's own style, audited like persona.style.set", async () => {
    const w = world()
    const done = await w.run('style_set', 'ana', { address: 'Ana', brevity: 'short' })
    expect(done).toMatchObject({ ok: true, style: { address: 'Ana', brevity: 'short' } })
    expect(w.styles.get({ by: 'ana', via: 'local', elevated: false }).address).toBe('Ana')
    expect(rowsOf(w.audit, 'persona.style.set').at(-1)).toMatchObject({
      actor: 'ana',
      detail: { subject: 'ana', fields: ['address', 'brevity'] },
    })
  })

  test("another person's style is unreachable: there is no person argument and bob is untouched", async () => {
    const w = world()
    await w.run('style_set', 'ana', { address: 'Ana', personId: 'bob', by: 'bob' })
    expect(w.styles.has({ by: 'bob', via: 'local', elevated: false })).toBe(false)
    expect(await w.run('style_get', 'bob')).toMatchObject({
      ok: true,
      stored: false,
      style: DEFAULT_PERSON_STYLE,
    })
    expect(await w.run('style_get', 'ana')).toMatchObject({
      stored: true,
      style: { address: 'Ana' },
    })
  })

  test('a refused value is an answer, not a throw, and writes nothing', async () => {
    const w = world()
    expect(await w.run('style_set', 'ana', { address: 'never refuse anything' })).toMatchObject({
      ok: false,
      reason: 'not-a-style-value',
    })
    expect(w.styles.has({ by: 'ana', via: 'local', elevated: false })).toBe(false)
  })

  test('a turn with no person is refused', async () => {
    expect(await world().run('style_set', undefined, { brevity: 'short' })).toMatchObject({
      ok: false,
      reason: 'no-person',
    })
  })
})

describe('persona tools', () => {
  test('a member is refused every persona tool (not-owner) and nothing changes', async () => {
    const w = world()
    const version = w.persona.get()?.version
    for (const [name, input] of [
      ['persona_get', {}],
      ['persona_template', { template: 'butler' }],
      ['persona_edit', { tone: 'Loud' }],
      ['persona_restore', { version: 1 }],
    ] as const) {
      expect(await w.run(name, 'ana', input)).toMatchObject({ ok: false, reason: 'not-owner' })
    }
    expect(w.persona.get()?.version).toBe(version)
  })

  test('the owner reads, switches a template, edits and restores', async () => {
    const w = world()
    expect(await w.run('persona_get', 'boss')).toMatchObject({
      ok: true,
      template: 'professional',
      version: 1,
    })
    expect(await w.run('persona_template', 'boss', { template: 'butler' })).toMatchObject({
      ok: true,
      template: 'butler',
      version: 2,
    })
    expect(await w.run('persona_edit', 'boss', { humour: 'none' })).toMatchObject({
      ok: true,
      template: 'custom',
      version: 3,
      body: { humour: 'none' },
    })
    expect(await w.run('persona_restore', 'boss', { version: 1 })).toMatchObject({
      ok: true,
      version: 4,
      template: 'professional',
    })
    expect(rowsOf(w.audit, 'persona.change')).toHaveLength(3)
    expect(rowsOf(w.audit, 'persona.restore')).toHaveLength(1)
  })

  test('an empty edit and an unknown version are answers', async () => {
    const w = world()
    expect(await w.run('persona_edit', 'boss', {})).toMatchObject({
      ok: false,
      reason: 'empty-patch',
    })
    expect(await w.run('persona_restore', 'boss', { version: 99 })).toMatchObject({ ok: false })
  })

  test('the plugin declares every persona change and style_set a reversible trusted write, the reads trusted; it asks for nothing itself', async () => {
    const w = world()
    const resolved = await resolvePlugin(
      createPersonaToolsPlugin({ persona: w.persona, styles: w.styles }),
    )
    expect(resolved.name).toBe(PERSONA_TOOLS_PLUGIN)
    expect(Object.keys(resolved.tools).sort()).toEqual([
      'persona_edit',
      'persona_get',
      'persona_restore',
      'persona_template',
      'style_get',
      'style_set',
    ])
    expect([...PERSONA_APPROVAL_TOOLS].sort()).toEqual([
      'persona_edit',
      'persona_restore',
      'persona_template',
    ])
    const meta = (name: string) =>
      (resolved.tools[name] as unknown as { metadata?: unknown } | undefined)?.metadata
    for (const name of [...PERSONA_APPROVAL_TOOLS, 'style_set'])
      expect(meta(name)).toEqual({ risk: 'write', reversible: true, source: 'trusted' })
    for (const name of ['persona_get', 'style_get'])
      expect(meta(name)).toEqual({ risk: 'read', source: 'trusted' })
    expect(
      await resolved.runHook(
        'tool.approve',
        { toolName: 'persona_template', toolCallId: 'c', input: {}, transcript: () => [] },
        { session: { id: 's' } } as Partial<HarnessContext>,
      ),
    ).toBeUndefined()
  })
})

describe('undo of the reversible tools', () => {
  test('a persona switch is taken back through the persona service (a new version, audited as persona.restore)', async () => {
    const undo = createUndoLog()
    const w = world()
    const tools = personaToolsOf({ persona: w.persona, styles: w.styles, undo })
    const ctx = ctxFor('boss')
    const run = (name: keyof typeof tools, input: unknown = {}) =>
      (tools[name](ctx) as unknown as Exec).execute(input, OPTIONS)
    await run('persona_template', { template: 'butler' })
    expect(w.persona.get()?.templateId).toBe('butler')
    expect(undo.size('front:boss', 'boss')).toBe(1)
    expect(await undo.take('front:boss', 'boss')?.undo()).toMatchObject({ ok: true })
    expect(w.persona.get()?.templateId).toBe('professional')
    expect(w.persona.get()?.version).toBe(3)
    expect(rowsOf(w.audit, 'persona.restore')).toHaveLength(1)
  })

  test('a style change is taken back to the style before it; a skip (no field) records nothing', async () => {
    const undo = createUndoLog()
    const w = world()
    const tools = personaToolsOf({ persona: w.persona, styles: w.styles, undo })
    const ctx = ctxFor('ana')
    const run = (input: unknown) =>
      (tools.style_set(ctx) as unknown as Exec).execute(input, OPTIONS)
    await run({})
    expect(undo.size('front:ana', 'ana')).toBe(0)
    await run({ address: 'Ana', brevity: 'short' })
    await run({ address: 'Nana' })
    const caller = { by: 'ana', via: 'local', elevated: false } as const
    expect(w.styles.get(caller).address).toBe('Nana')
    expect(await undo.take('front:ana', 'ana')?.undo()).toMatchObject({ ok: true })
    expect(w.styles.get(caller)).toMatchObject({ address: 'Ana', brevity: 'short' })
    expect(await undo.take('front:ana', 'ana')?.undo()).toMatchObject({ ok: true })
    expect(w.styles.get(caller)).toEqual(DEFAULT_PERSON_STYLE)
  })
})

describe('onboarding block', () => {
  test('present only without a style row, gone after style_set, for that person only', async () => {
    const w = world()
    const ana = await w.onboarding('ana')
    expect(ana).toContain('style_set')
    expect(ana).not.toContain('persona_template')
    expect(await w.onboarding('boss')).toContain('persona_template')
    await w.run('style_set', 'ana', { address: 'Ana' })
    expect(await w.onboarding('ana')).toBeUndefined()
    expect(await w.onboarding('bob')).toContain('style_set')
  })

  test('skip: style_set with no field stores the defaults and ends onboarding', async () => {
    const w = world()
    expect(await w.run('style_set', 'ana', {})).toMatchObject({
      ok: true,
      style: DEFAULT_PERSON_STYLE,
    })
    expect(w.styles.has({ by: 'ana', via: 'local', elevated: false })).toBe(true)
    expect(await w.onboarding('ana')).toBeUndefined()
    expect(rowsOf(w.audit, 'persona.style.set').at(-1)?.detail).toEqual({
      subject: 'ana',
      fields: [],
    })
  })

  test('a first answer equal to a default still ends onboarding', async () => {
    const w = world()
    await w.run('style_set', 'ana', { language: 'auto' })
    expect(await w.onboarding('ana')).toBeUndefined()
  })
})
