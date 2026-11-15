import { defineOperation, type KeithCtx } from '@keith/host'
import { z } from '@keith/host/schema'
import { KIND } from '../store.ts'

const id = z.string().min(1).max(64)
const target = z
  .string()
  .min(2)
  .max(100)
  .describe(
    'user:<name>, group:<name>, @users (every active person) or @public (everyone, guests too)',
  )

const Entry = z.object({
  who: z.string(),
  access: z.enum(['read', 'edit']),
  effect: z.enum(['allow', 'deny']),
})
const Shares = z.object({
  /** Mode of the note as `rw-r-----`. */
  mode: z.string(),
  entries: z.array(Entry),
})

type View = Awaited<ReturnType<KeithCtx['access']['show']>>
const shares = (view: View): z.infer<typeof Shares> => ({
  mode: view.modeText,
  entries: view.entries.map((e) => ({
    who: e.label,
    access: (e.bits & 2) !== 0 ? 'edit' : 'read',
    effect: e.effect,
  })),
})

export const share = defineOperation({
  name: 'share',
  // the person's own data: what it returns is not outside text (ADR-0036 §3)
  source: 'trusted',
  description:
    'Let someone read (or edit) one of your notes: target user:<name>, group:<name>, @users or @public. Or use deny=true to shut a person or group out. Only the note owner can. Widening to @users or @public is refused here (FORBIDDEN): a tool approval never confirms a widening and a chat turn is never elevated. The owner makes that change at the TUI or with keith-core acl share.',
  input: z.object({
    id,
    target,
    access: z.enum(['read', 'edit']).default('read'),
    deny: z.boolean().default(false),
  }),
  output: Shares,
  permission: { capability: 'notes.use', resource: { kind: KIND, bits: 4, id: (i) => i.id } },
  risk: 'dangerous',
  rateLimit: { max: 20, windowMs: 60_000 },
  async run(input, k) {
    const view = await k.access.share({
      kind: KIND,
      id: input.id,
      target: input.target,
      // an edit grant includes reading; a deny shuts every bit
      bits: input.deny || input.access === 'edit' ? 6 : 4,
      effect: input.deny ? 'deny' : 'allow',
    })
    return shares(view)
  },
})

export const unshare = defineOperation({
  name: 'unshare',
  // the person's own data: what it returns is not outside text (ADR-0036 §3)
  source: 'trusted',
  description:
    'Take back what you shared on a note: remove the entry for a user, group, @users or @public (deny=true removes a deny entry). Only the note owner can.',
  input: z.object({ id, target, deny: z.boolean().default(false) }),
  output: Shares,
  permission: { capability: 'notes.use', resource: { kind: KIND, bits: 4, id: (i) => i.id } },
  rateLimit: { max: 20, windowMs: 60_000 },
  async run(input, k) {
    return shares(
      await k.access.unshare({
        kind: KIND,
        id: input.id,
        target: input.target,
        effect: input.deny ? 'deny' : 'allow',
      }),
    )
  },
})

export const sharesOf = defineOperation({
  name: 'shares',
  // the person's own data: what it returns is not outside text (ADR-0036 §3)
  source: 'trusted',
  description: 'Show who a note is shared with (only its owner can look).',
  input: z.object({ id }),
  output: Shares,
  permission: { capability: 'notes.use', resource: { kind: KIND, bits: 4, id: (i) => i.id } },
  risk: 'read',
  async run(input, k) {
    return shares(await k.access.show(KIND, input.id))
  },
})
