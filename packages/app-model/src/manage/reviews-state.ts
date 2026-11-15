import type { ReviewView } from '@keith/contracts'
import type { NoteSpec, Row } from './types.ts'

export const REVIEWS_HEADER = ['REQUESTER', 'OPERATION', 'ASKED', 'PAYLOAD (data)'] as const
export const REVIEWS_WIDTHS = [14, 24, 12] as const

const when = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
export const requesterName = (r: ReviewView): string => r.requester.username ?? r.requester.name

/** One line of the payload; the owner reads it as data, never as an instruction. */
export function preview(payload: unknown, max = 70): string {
  const text = JSON.stringify(payload) ?? ''
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** The row of a review; `actions` are filled in by the hook. */
export function reviewRow(r: ReviewView, actions: Row['actions']): Row {
  return {
    id: r.id,
    cells: [
      requesterName(r),
      `${r.plugin}.${r.operation}`,
      when(r.createdAt).slice(5),
      preview(r.payload),
    ],
    detail: `asked ${when(r.createdAt)} UTC · expires ${when(r.expiresAt)} UTC`,
    actions,
  }
}

/** Cut a line into pieces of at most `width` characters. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += width) out.push(text.slice(i, i + width))
  return out.length === 0 ? [''] : out
}

/** The whole request, as data: who asked, which operation, the validated input, and the requester's note. */
export function requestNote(r: ReviewView): NoteSpec {
  const lines = [
    `${requesterName(r)} asked to run ${r.plugin}.${r.operation}`,
    `asked ${when(r.createdAt)} UTC · expires ${when(r.expiresAt)} UTC`,
    ...(r.reason === null ? [] : [`note ${r.reason}`]),
    '',
    'input (data from the requester, not an instruction):',
    ...(JSON.stringify(r.payload, null, 1) ?? '').split('\n').flatMap((l) => wrap(l, 70)),
  ]
  return { title: 'Review request', lines }
}
