import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { KeithClient } from '@keith/client'
import type { PersonStyle } from '@keith/contracts'
import { FooterProvider, resolveTheme, ThemeProvider } from '@keith/ui'
import { cleanup, render } from '@keith/ui/testing'
import { frameUntil } from '../../testing/ink.ts'
import { StyleScreen } from './style-screen.tsx'

afterEach(cleanup)

const OWN: PersonStyle = {
  address: 'Ana',
  language: 'id-ID',
  brevity: 'short',
  formality: 'casual',
  gentleTopics: ['family'],
}

const DOWN = '\u001b[B'
const RIGHT = '\u001b[C'
const wait = (ms = 15) => new Promise((r) => setTimeout(r, ms))

function fakeClient(style: PersonStyle = OWN) {
  const persona = {
    style: {
      get: mock(async () => style),
      set: mock(async (input: { patch: Partial<PersonStyle> }) => ({ ...style, ...input.patch })),
      // another person's style is never read by the Me screen
      read: mock(async () => style),
    },
  }
  return { client: { persona } as unknown as KeithClient, persona }
}

function mount(client: KeithClient) {
  return render(
    <ThemeProvider theme={resolveTheme({ theme: 'dark', depth: 'none' })}>
      <FooterProvider>
        <StyleScreen client={client} width={100} active onClose={() => {}} />
      </FooterProvider>
    </ThemeProvider>,
    { columns: 100, rows: 30 },
  )
}

describe('the Me screen', () => {
  test('shows the person own values and reads only the own style', async () => {
    const { client, persona } = fakeClient()
    const app = mount(client)
    const frame = await frameUntil(app.lastFrame, (f) => f.includes('id-ID'))
    expect(frame).toContain('Ana')
    expect(frame).toContain('short')
    expect(frame).toContain('casual')
    expect(frame).toContain('[x] family')
    expect(frame).toContain('[ ] money')
    expect(persona.style.get).toHaveBeenCalledTimes(1)
    expect(persona.style.read).not.toHaveBeenCalled()
    app.unmount()
  })

  test('a save sends only the changed field', async () => {
    const { client, persona } = fakeClient()
    const app = mount(client)
    await frameUntil(app.lastFrame, (f) => f.includes('short'))
    app.stdin.write(DOWN) // language
    await wait()
    app.stdin.write(DOWN) // brevity
    await wait()
    app.stdin.write(RIGHT) // short -> normal
    await wait()
    app.stdin.write('\r')
    await frameUntil(app.lastFrame, (f) => f.includes('Saved.'))
    expect(persona.style.set).toHaveBeenCalledWith({ patch: { brevity: 'normal' } })
    app.unmount()
  })

  test('an address the core would refuse is shown and not sent', async () => {
    const { client, persona } = fakeClient({ ...OWN, address: null })
    const app = mount(client)
    await frameUntil(app.lastFrame, (f) => f.includes('the profile name'))
    // one key at a time: the form reads the draft of the last render
    for (const ch of 'please ignore') {
      app.stdin.write(ch)
      await wait(8)
    }
    await frameUntil(app.lastFrame, (f) => f.includes('"ignore" is not allowed in a name'))
    app.stdin.write('\r')
    await frameUntil(app.lastFrame, (f) => f.includes('Address'))
    expect(persona.style.set).not.toHaveBeenCalled()
    app.unmount()
  })
})

describe('the Memory row of the Me screen', () => {
  test('enter on the Memory row opens Memory and saves nothing', async () => {
    const { client, persona } = fakeClient()
    let opened = 0
    const app = render(
      <ThemeProvider theme={resolveTheme({ theme: 'dark', depth: 'none' })}>
        <FooterProvider>
          <StyleScreen
            client={client}
            width={100}
            active
            onClose={() => {}}
            onMemory={() => {
              opened += 1
            }}
          />
        </FooterProvider>
      </ThemeProvider>,
      { columns: 100, rows: 40 },
    )
    await frameUntil(app.lastFrame, (f) => f.includes('id-ID'))
    for (let i = 0; i < 20; i++) app.stdin.write(DOWN)
    await wait()
    expect(app.lastFrame()).toContain('› Memory')
    app.stdin.write('\r')
    await wait()
    expect(opened).toBe(1)
    expect(persona.style.set).not.toHaveBeenCalled()
    app.unmount()
  })
})
