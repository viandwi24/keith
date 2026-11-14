import { describe, expect, mock, test } from 'bun:test'
import type { PersonaApi } from '@keith/client'
import type { PersonaView } from '@keith/contracts'
import {
  PERSONA_USAGE,
  type PersonaCommandEnv,
  parsePersonaCommand,
  runPersonaCommand,
} from './commands.ts'

const VIEW: PersonaView = {
  version: 3,
  templateId: 'professional',
  body: {
    tone: 't',
    attitude: 'a',
    humour: 'dry',
    addressing: 'd',
    caresAbout: 'c',
    lines: { answerFailed: 'failed', guestUnavailable: 'unavailable' },
  },
  updatedAt: 1,
}

const flush = () => new Promise((r) => setTimeout(r, 0))

function envOf(over: Partial<PersonaCommandEnv> & { get?: () => Promise<PersonaView> } = {}) {
  const persona = {
    get: mock(over.get ?? (async () => VIEW)),
    setTemplate: mock(async () => ({ ...VIEW, templateId: 'friend' as const, version: 4 })),
  }
  const env = {
    isMember: false,
    persona: persona as unknown as PersonaApi,
    guard: mock(<T>(act: () => Promise<T>) => act()) as unknown as PersonaCommandEnv['guard'],
    say: mock(() => {}),
    toast: mock(() => {}),
    openStyle: mock(() => {}),
    openEdit: mock(() => {}),
    ...over,
  } satisfies PersonaCommandEnv
  return { env, persona }
}

describe('parsePersonaCommand', () => {
  test('nothing after the word shows the persona; style and edit are their own forms', () => {
    expect(parsePersonaCommand('')).toEqual({ kind: 'show' })
    expect(parsePersonaCommand('  style ')).toEqual({ kind: 'style' })
    expect(parsePersonaCommand('edit')).toEqual({ kind: 'edit' })
  })

  test('template takes one built-in id', () => {
    expect(parsePersonaCommand('template friend')).toEqual({
      kind: 'template',
      templateId: 'friend',
    })
  })

  test('a template id that is not built in, or a missing one, is a usage line', () => {
    for (const args of ['template', 'template custom', 'template friend extra', 'template Friend'])
      expect(parsePersonaCommand(args).kind).toBe('usage')
    expect(parsePersonaCommand('nope')).toEqual({ kind: 'usage', text: PERSONA_USAGE })
    expect(parsePersonaCommand('style now')).toEqual({ kind: 'usage', text: PERSONA_USAGE })
  })
})

describe('runPersonaCommand', () => {
  test('/persona says the template and the version to anyone', async () => {
    const { env, persona } = envOf({ isMember: true })
    runPersonaCommand({ kind: 'show' }, env)
    await flush()
    expect(persona.get).toHaveBeenCalledTimes(1)
    expect(env.say).toHaveBeenCalledWith('info', ['Persona: professional · version 3'])
  })

  test('/persona style opens the Me screen; a member is never sent to Manage', () => {
    const { env } = envOf({ isMember: true })
    runPersonaCommand({ kind: 'style' }, env)
    expect(env.openStyle).toHaveBeenCalledTimes(1)
    expect(env.openEdit).not.toHaveBeenCalled()
  })

  test('/persona edit opens the Persona section for the owner, and tells a member to ask', () => {
    const owner = envOf()
    runPersonaCommand({ kind: 'edit' }, owner.env)
    expect(owner.env.openEdit).toHaveBeenCalledTimes(1)

    const member = envOf({ isMember: true })
    runPersonaCommand({ kind: 'edit' }, member.env)
    expect(member.env.openEdit).not.toHaveBeenCalled()
    expect(member.env.say).toHaveBeenCalledWith('info', ['Only the owner edits the persona.'])
  })

  test('/persona template runs through the guard and says the new template and version', async () => {
    const { env, persona } = envOf()
    runPersonaCommand({ kind: 'template', templateId: 'friend' }, env)
    await flush()
    expect(env.guard).toHaveBeenCalledTimes(1)
    expect(persona.setTemplate).toHaveBeenCalledWith({ templateId: 'friend' })
    expect(env.toast).toHaveBeenCalledWith('Persona: friend · version 4.', 'success')
  })

  test('a member template change is refused with the core message, as an error toast', async () => {
    const refusal = new Error('only the owner can change the persona')
    const { env, persona } = envOf({ isMember: true })
    persona.setTemplate = mock(async () => {
      throw refusal
    }) as never
    runPersonaCommand({ kind: 'template', templateId: 'friend' }, env)
    await flush()
    expect(env.toast).toHaveBeenCalledWith('only the owner can change the persona', 'error')
  })

  test('a usage command says its line and calls nothing', () => {
    const { env, persona } = envOf()
    runPersonaCommand({ kind: 'usage', text: PERSONA_USAGE }, env)
    expect(env.say).toHaveBeenCalledWith('info', [PERSONA_USAGE])
    expect(persona.get).not.toHaveBeenCalled()
  })
})
