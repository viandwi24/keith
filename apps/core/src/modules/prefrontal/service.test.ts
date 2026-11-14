import { describe, expect, test } from 'bun:test'
import { PERSONA_CHANGED, type PersonaPatch } from '@keith/contracts'
import { as, prefrontalWorld, rowsOf } from './fixtures.ts'
import { PrefrontalError } from './service.ts'
import { templateToBody } from './templates.ts'

// The persona service (docs/specs/prefrontal.md, "Persona", P33.2.3): first boot seeds from a template, each write is one
// version and one audit row, the owner and the step-up are checked before any write, and a restore writes a new version.

const OWNER = as('boss')
const PATCH_TONE: PersonaPatch = { tone: 'Measured and kind.' }

/** The refusal of a call, as the error it throws (fails the test when the call does not refuse). */
async function refusal(call: () => unknown): Promise<PrefrontalError> {
  try {
    await call()
  } catch (error) {
    if (error instanceof PrefrontalError) return error
    throw error
  }
  throw new Error('expected a refusal')
}

describe('first boot seed', () => {
  test('seeds version 1 from professional, with one audit row, one brain event and one feed record', () => {
    const w = prefrontalWorld()
    expect(w.service.get()).toBeUndefined()
    expect(w.service.seed()).toBe(true)
    const view = w.service.get()
    expect(view).toMatchObject({ version: 1, templateId: 'professional' })
    expect(view?.body).toEqual(templateToBody('professional'))
    expect(rowsOf(w.audit, 'persona.change')).toMatchObject([
      {
        actor: 'system',
        via: 'local',
        detail: { version: 1, reason: 'template', members: [], templateId: 'professional' },
      },
    ])
    expect(w.activity.map((a) => a.type)).toEqual(['brain.prefrontal.change', PERSONA_CHANGED])
    expect(w.activity[0]?.sessionId).toBeNull()
  })

  test('seeds from the template chosen in setup, and a second seed changes nothing', () => {
    const w = prefrontalWorld()
    expect(w.service.seed('butler')).toBe(true)
    expect(w.service.get()?.templateId).toBe('butler')
    expect(w.service.seed('friend')).toBe(false)
    expect(w.service.get()).toMatchObject({ version: 1, templateId: 'butler' })
    expect(rowsOf(w.audit, 'persona.change')).toHaveLength(1)
  })
})

describe('owner changes', () => {
  test('setTemplate writes one version and one persona.change row', async () => {
    const w = prefrontalWorld()
    w.service.seed()
    const version = await w.service.setTemplate(OWNER, 'friend')
    expect(version).toBe(2)
    expect(w.service.get()).toMatchObject({ version: 2, templateId: 'friend' })
    expect(w.service.get()?.body).toEqual(templateToBody('friend'))
    const rows = rowsOf(w.audit, 'persona.change')
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({
      actor: 'boss',
      via: 'tcp',
      detail: {
        version: 2,
        reason: 'template',
        members: ['boss', 'ana', 'bob'],
        templateId: 'friend',
      },
    })
    expect(w.persona.versions()).toHaveLength(2)
  })

  test('edit merges the patch over the current body and validates the whole', async () => {
    const w = prefrontalWorld()
    w.service.seed('butler')
    const before = w.service.get()?.body
    const version = await w.service.edit(OWNER, PATCH_TONE)
    expect(version).toBe(2)
    const view = w.service.get()
    expect(view).toMatchObject({ version: 2, templateId: 'custom' })
    expect(view?.body.tone).toBe('Measured and kind.')
    expect(view?.body.humour).toBe(before?.humour)
    expect(view?.body.lines).toEqual(before?.lines)
    const row = rowsOf(w.audit, 'persona.change').at(-1)
    expect(row?.detail).toEqual({
      version: 2,
      reason: 'edit',
      members: ['boss', 'ana', 'bob'],
      templateId: 'custom',
      fields: ['tone'],
    })
  })

  test('edit of one fixed line keeps the other one', async () => {
    const w = prefrontalWorld()
    w.service.seed('professional')
    await w.service.edit(OWNER, { lines: { answerFailed: 'Sorry, not now.' } })
    expect(w.service.get()?.body.lines).toEqual({
      answerFailed: 'Sorry, not now.',
      guestUnavailable: templateToBody('professional').lines.guestUnavailable,
    })
  })

  test('a fixed line over 120 characters is refused and writes nothing', async () => {
    const w = prefrontalWorld()
    w.service.seed()
    const error = await refusal(() =>
      w.service.edit(OWNER, { lines: { answerFailed: 'x'.repeat(121) } }),
    )
    expect(error).toMatchObject({ code: 'VALIDATION', reason: 'line-too-long' })
    expect(w.persona.versions()).toHaveLength(1)
    expect(rowsOf(w.audit, 'persona.change')).toHaveLength(1)
  })

  test('an empty patch is refused', async () => {
    const w = prefrontalWorld()
    w.service.seed()
    const error = await refusal(() => w.service.edit(OWNER, {}))
    expect(error).toMatchObject({ code: 'VALIDATION', reason: 'empty-patch' })
    expect(w.persona.versions()).toHaveLength(1)
  })

  test('a member cannot change the persona: FORBIDDEN not-owner, nothing written', async () => {
    const w = prefrontalWorld()
    w.service.seed()
    const ana = as('ana')
    expect(await refusal(() => w.service.setTemplate(ana, 'friend'))).toMatchObject({
      code: 'FORBIDDEN',
      reason: 'not-owner',
    })
    expect(await refusal(() => w.service.edit(ana, PATCH_TONE))).toMatchObject({
      reason: 'not-owner',
    })
    expect(await refusal(() => w.service.restore(ana, 1))).toMatchObject({ reason: 'not-owner' })
    expect(w.persona.versions()).toHaveLength(1)
    expect(rowsOf(w.audit, 'persona.change', 'persona.restore')).toHaveLength(1)
  })

  test('a call without step-up is FORBIDDEN step-up-required and changes nothing', async () => {
    const w = prefrontalWorld()
    w.service.seed()
    const noStep = as('boss', false)
    expect(await refusal(() => w.service.setTemplate(noStep, 'butler'))).toMatchObject({
      code: 'FORBIDDEN',
      reason: 'step-up-required',
    })
    expect(await refusal(() => w.service.edit(noStep, PATCH_TONE))).toMatchObject({
      reason: 'step-up-required',
    })
    expect(w.service.get()?.version).toBe(1)
    expect(w.persona.versions()).toHaveLength(1)
  })
})

describe('restore', () => {
  test('restoring an old version writes a new one with its body and keeps the history', async () => {
    const w = prefrontalWorld()
    w.service.seed('professional')
    await w.service.edit(OWNER, PATCH_TONE)
    await w.service.setTemplate(OWNER, 'friend')
    const version = await w.service.restore(OWNER, 1)
    expect(version).toBe(4)
    const view = w.service.get()
    expect(view).toMatchObject({ version: 4, templateId: 'professional' })
    expect(view?.body).toEqual(templateToBody('professional'))
    expect(w.persona.version(1)?.body).toEqual(templateToBody('professional'))
    const row = rowsOf(w.audit, 'persona.restore').at(-1)
    expect(row).toMatchObject({
      actor: 'boss',
      detail: { version: 4, reason: 'restore', members: ['boss', 'ana', 'bob'], restored: 1 },
    })
    expect(w.persona.versions()).toHaveLength(4)
  })

  test('each transition writes exactly one version and one audit row', async () => {
    const w = prefrontalWorld()
    w.service.seed()
    const steps = [
      () => w.service.setTemplate(OWNER, 'butler'),
      () => w.service.edit(OWNER, PATCH_TONE),
      () => w.service.restore(OWNER, 2),
    ]
    for (const [index, step] of steps.entries()) {
      const versionsBefore = w.persona.versions().length
      const rowsBefore = rowsOf(w.audit, 'persona.change', 'persona.restore').length
      await step()
      expect(w.persona.versions()).toHaveLength(versionsBefore + 1)
      expect(rowsOf(w.audit, 'persona.change', 'persona.restore')).toHaveLength(rowsBefore + 1)
      expect(w.activity.filter((a) => a.type === PERSONA_CHANGED)).toHaveLength(index + 2)
    }
  })

  test('restoring an unknown version is NOT_FOUND and writes nothing', async () => {
    const w = prefrontalWorld()
    w.service.seed()
    expect(await refusal(() => w.service.restore(OWNER, 99))).toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(w.persona.versions()).toHaveLength(1)
    expect(rowsOf(w.audit, 'persona.restore')).toHaveLength(0)
  })
})

describe('history', () => {
  test('the owner reads the history newest first; a member is refused', async () => {
    const w = prefrontalWorld()
    w.service.seed()
    await w.service.setTemplate(OWNER, 'friend')
    const history = await w.service.history(OWNER)
    expect(history.map((v) => v.version)).toEqual([2, 1])
    expect(await refusal(() => w.service.history(as('ana')))).toMatchObject({
      reason: 'not-owner',
    })
  })
})
