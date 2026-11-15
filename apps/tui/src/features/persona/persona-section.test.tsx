import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  clipText,
  draftOfValues,
  editFieldsOf,
  personaRowsOf,
  stampOf,
} from '@keith/app-model/manage'
import { KEITH_STEP_UP_REQUIRED, type KeithClient } from '@keith/client'
import type { PersonaBody, PersonaVersion, PersonaView, Whoami } from '@keith/contracts'
import { FooterProvider, resolveTheme, ThemeProvider } from '@keith/ui'
import { cleanup, render } from '@keith/ui/testing'
import { frameUntil } from '../../testing/ink.ts'
import { SECTIONS, visibleSections } from '../manage/index.ts'
import type { ManageEnv } from '../manage/manage-types.ts'
import { SectionHost } from '../manage/section-host.tsx'
import { StepUpDialog, useStepUp } from '../stepup/index.ts'

afterEach(cleanup)

const BODY: PersonaBody = {
  tone: 'Calm and exact.',
  attitude: 'Helpful.',
  humour: 'dry',
  addressing: 'Use the name the person set.',
  caresAbout: 'The owner time.',
  lines: { answerFailed: 'I could not finish that.', guestUnavailable: 'Guests are off.' },
}

const VIEW: PersonaView = {
  version: 3,
  templateId: 'professional',
  body: BODY,
  updatedAt: Date.UTC(2026, 10, 11, 9, 41),
}

const HISTORY: PersonaVersion[] = [
  {
    version: 1,
    templateId: 'butler',
    body: BODY,
    reason: 'template',
    changedBy: 'ana',
    changedAt: Date.UTC(2026, 10, 1, 8, 0),
    note: null,
  },
  {
    version: 3,
    templateId: 'professional',
    body: BODY,
    reason: 'template',
    changedBy: 'ana',
    changedAt: Date.UTC(2026, 10, 11, 9, 41),
    note: null,
  },
]

const OWNER_CAPS = new Set(['settings.manage', 'audit.read', 'chat'])
const MEMBER_CAPS = new Set(['chat', 'nodes.read', 'budget.read', 'audit.mine'])

const stepUpRequired = () =>
  Object.assign(new Error('confirm with your PIN or password first (step-up)'), {
    code: KEITH_STEP_UP_REQUIRED,
  })

describe('the section list', () => {
  test('the owner sees Persona in the list; a member does not', () => {
    const owner = visibleSections(SECTIONS, OWNER_CAPS).map((s) => s.id)
    const member = visibleSections(SECTIONS, MEMBER_CAPS).map((s) => s.id)
    expect(owner).toContain('persona')
    expect(member).not.toContain('persona')
  })
})

describe('the section rows and actions', () => {
  test('history rows: every version but the current one can be restored', () => {
    const rows = personaRowsOf(HISTORY, 3, (v) => [
      { id: `restore-${v}`, label: `Restore ${v}`, run: async () => undefined },
    ])
    expect(rows.map((r) => r.id)).toEqual(['v3', 'v1'])
    expect(rows[0]?.cells[0]).toBe('3 (current)')
    expect(rows[0]?.actions).toEqual([])
    expect(rows[1]?.actions.map((a) => a.id)).toEqual(['restore-1'])
    expect(rows[1]?.cells[2]).toBe('2026-11-01 08:00')
  })

  test('the edit form starts from the saved text; humour is one of its words', () => {
    const fields = editFieldsOf(BODY)
    expect(fields.find((f) => f.id === 'tone')?.initial).toBe('Calm and exact.')
    expect(fields.find((f) => f.id === 'humour')?.options).toEqual(['none', 'dry', 'warm'])
    expect(fields.find((f) => f.id === 'answerFailed')?.initial).toBe('I could not finish that.')
  })

  test('the values of the form read back as the draft, a missing value keeps the saved one', () => {
    const draft = draftOfValues(BODY, { tone: 'Warmer.', humour: 'warm' })
    expect(draft.tone).toBe('Warmer.')
    expect(draft.humour).toBe('warm')
    expect(draft.attitude).toBe('Helpful.')
  })

  test('a long line is cut to one row; a version stamp is UTC to the minute', () => {
    expect(clipText('abcdef', 4)).toBe('abc…')
    expect(clipText('abc', 4)).toBe('abc')
    expect(stampOf(Date.UTC(2026, 10, 11, 9, 41, 59))).toBe('2026-11-11 09:41')
  })
})

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function fakeClient() {
  let elevated = false
  const calls = { setTemplate: [] as unknown[], stepUp: [] as unknown[] }
  const client = {
    persona: {
      get: mock(async () => VIEW),
      history: mock(async () => HISTORY),
      setTemplate: mock(async (input: { templateId: string }) => {
        calls.setTemplate.push(input)
        if (!elevated) throw stepUpRequired()
        return { ...VIEW, templateId: input.templateId, version: 4 }
      }),
      edit: mock(async () => VIEW),
      restore: mock(async () => VIEW),
    },
    stepUp: mock(async (body: unknown) => {
      calls.stepUp.push(body)
      elevated = true
      return { elevatedUntil: Date.now() + 600_000 }
    }),
    feed: () => ({
      subscribeEvents: () => () => {},
      subscribeResync: () => () => {},
    }),
  }
  return { client: client as unknown as KeithClient, calls }
}

function Harness({ client }: { client: KeithClient }) {
  const stepUp = useStepUp(client)
  const section = SECTIONS.find((s) => s.id === 'persona')
  if (section === undefined) throw new Error('no Persona section')
  const env: ManageEnv = {
    client,
    guard: stepUp.guard,
    me: { role: 'owner', capabilities: [...OWNER_CAPS] } as unknown as Whoami,
    caps: OWNER_CAPS,
    nodes: {} as ManageEnv['nodes'],
  }
  return (
    <ThemeProvider theme={resolveTheme({ theme: 'dark', depth: 'none' })}>
      <FooterProvider>
        <SectionHost
          section={section}
          env={env}
          width={100}
          height={26}
          focus
          active
          wide={false}
          onLegend={() => {}}
          onNav={() => {}}
          onClose={() => {}}
        />
        {stepUp.prompt !== undefined && <StepUpDialog stepUp={stepUp} width={80} />}
      </FooterProvider>
    </ThemeProvider>
  )
}

describe('the owner save in Manage', () => {
  test('a template change the core refuses for a step-up opens the PIN prompt first, then runs', async () => {
    const { client, calls } = fakeClient()
    const app = render(<Harness client={client} />, { columns: 100, rows: 30 })
    await frameUntil(app.lastFrame, (f) => f.includes('professional · version 3'))

    app.stdin.write('n') // the first action: Choose template
    await frameUntil(app.lastFrame, (f) => f.includes('Template'))
    // professional -> butler -> friend (the choice cycles with the right arrow)
    app.stdin.write('\u001b[C')
    await wait(10)
    app.stdin.write('\u001b[C')
    await wait(10)
    app.stdin.write('\r') // submit the form: the save runs through the guard

    const prompted = await frameUntil(app.lastFrame, (f) => f.includes("Confirm it's you"))
    expect(prompted).toContain('Confirm it')
    // the refusal changed nothing and no PIN has been sent yet
    expect(calls.setTemplate.length).toBe(1)
    expect(calls.stepUp.length).toBe(0)

    for (const ch of '1234') app.stdin.write(ch)
    await wait(10)
    app.stdin.write('\r')

    await frameUntil(app.lastFrame, (f) => f.includes('Persona is now friend'))
    expect(calls.stepUp).toEqual([{ pin: '1234' }])
    expect(calls.setTemplate.length).toBe(2)
    app.unmount()
  })
})
