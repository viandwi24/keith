import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { KeithClient } from '@keith/client'
import type { DreamRunView, DreamStatusView } from '@keith/contracts'
import { FooterProvider, resolveTheme, ThemeProvider } from '@keith/ui'
import { cleanup, render } from '@keith/ui/testing'
import { frameUntil } from '../../testing/ink.ts'
import { MemoryScreen } from './memory-screen.tsx'

afterEach(cleanup)

const RUN: DreamRunView = {
  id: 'run-1',
  trigger: 'schedule',
  mode: 'propose',
  status: 'staged',
  reason: null,
  startedAt: new Date(2026, 10, 10, 3, 0).getTime(),
  finishedAt: null,
  counts: { candidates: 2, promoted: 1, merged: 0, superseded: 0, dropped: 1 },
  applied: false,
  staged: true,
}
const STATUS: DreamStatusView = {
  mode: 'propose',
  lastRun: RUN,
  nextRunAt: null,
  canApply: true,
  canUndo: false,
}
const DIARY = [
  '# Dreams 2026-11-10',
  '',
  '## run run-1',
  '- proposed -> profile.md: Lives in Bandung (said so in chat)',
  '- dropped: small talk',
].join('\n')

function fakeClient(over: { status?: DreamStatusView; diaryError?: unknown } = {}) {
  const dreaming = {
    status: mock(async () => over.status ?? STATUS),
    diary: mock(async (input?: { date?: string }) => {
      if (over.diaryError !== undefined) throw over.diaryError
      return { date: input?.date ?? '2026-11-10', text: DIARY }
    }),
  }
  return { client: { dreaming } as unknown as KeithClient, dreaming }
}

function mount(client: KeithClient, onClose = () => {}) {
  return render(
    <ThemeProvider theme={resolveTheme({ theme: 'dark', depth: 'none' })}>
      <FooterProvider>
        <MemoryScreen client={client} width={100} active onClose={onClose} />
      </FooterProvider>
    </ThemeProvider>,
    { columns: 100, rows: 40 },
  )
}

describe('the Memory screen', () => {
  test('shows the mode, the last run, the staged entries of its own run and the latest diary', async () => {
    const { client, dreaming } = fakeClient()
    const app = mount(client)
    const frame = await frameUntil(app.lastFrame, (f) => f.includes('Diary 2026-11-10'))
    expect(frame).toContain('Mode: propose')
    expect(frame).toContain('Last run: 2026-11-10 03:00 · schedule · staged')
    expect(frame).toContain(
      'Staged plan: 2 candidates: 1 promoted, 0 merged, 0 superseded, 1 dropped',
    )
    expect(frame).toContain('Lives in Bandung')
    expect(frame).toContain('/dream apply')
    // the staged day is read by its date only; no other procedure is called
    expect(dreaming.diary).toHaveBeenCalledWith({ date: '2026-11-10' })
    expect(dreaming.status).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  test('says so when there is no run, no staged plan and no diary yet', async () => {
    const { client, dreaming } = fakeClient({
      status: { ...STATUS, lastRun: null, canApply: false },
      diaryError: { code: 'NOT_FOUND', message: 'no diary' },
    })
    const app = mount(client)
    const frame = await frameUntil(app.lastFrame, (f) => f.includes('No diary yet.'))
    expect(frame).toContain('Last run: none yet.')
    expect(frame).not.toContain('Staged plan')
    expect(dreaming.diary).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  test('esc goes back to Me', async () => {
    const { client } = fakeClient()
    let closed = 0
    const app = mount(client, () => {
      closed += 1
    })
    await frameUntil(app.lastFrame, (f) => f.includes('Mode: propose'))
    app.stdin.write('\u001b')
    await new Promise((r) => setTimeout(r, 30))
    expect(closed).toBe(1)
    app.unmount()
  })
})
