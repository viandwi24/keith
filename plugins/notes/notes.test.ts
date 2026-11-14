import { describe, expect, test } from 'bun:test'
import { isReviewTicket } from '@keith/host'
import {
  CASE_ACTORS,
  type CaseActorName,
  leakCheck,
  type MemoryHost,
  memoryHost,
  SHARING_CASES,
} from '@keith/host/testing'
import notes from './plugin.ts'

/** The people of the P15 cases, plus a guest. `olga` owns the note; `boss` is the instance owner. */
const PEOPLE: Record<string, string> = {
  owner: 'olga',
  a: 'mia',
  b: 'ben',
  c: 'cai',
  duta: 'duta',
  amel: 'amel',
  outsider: 'oscar',
  boss: 'boss',
}
const GUEST = 'g1'

function setup() {
  const host = memoryHost({ plugins: [notes] })
  for (const id of ['olga', 'mia', 'ben', 'cai', 'duta', 'amel', 'oscar']) host.add(id)
  host.add('boss', 'owner')
  host.addGuest(GUEST)
  for (const [group, members] of Object.entries({ A: ['mia'], B: ['ben'], C: ['cai'] })) {
    host.acl.createGroup({ id: group, name: group.toLowerCase().repeat(2), createdBy: 'boss' })
    for (const m of members) host.acl.addMember(group, m, 'boss')
  }
  return host
}

const call = (host: MemoryHost, op: string, input: unknown, who: string, elevated = false) =>
  host.call('notes', op, input, who, { elevated })
const fails = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (error) {
    const e = error as { code?: string; message: string }
    return { code: e.code, message: e.message }
  }
  throw new Error('expected a refusal')
}
const mk = async (
  host: MemoryHost,
  who: string,
  title = 'Tax plan',
  body = 'offshore marmalade fund',
) => {
  host.clock.advance(5_000) // stay under the create rate limit
  return ((await call(host, 'create', { title, body }, who)) as { id: string }).id
}
const titles = async (host: MemoryHost, who: string) =>
  ((await call(host, 'list', {}, who)) as { notes: { title: string }[] }).notes.map((n) => n.title)

describe('notes: basics', () => {
  test('a note is private by default: mode 0600, owner only, nobody else lists or reads it', async () => {
    const host = setup()
    const id = await mk(host, 'olga')
    const res = host.acl.getResource('note', id)
    expect(res?.mode).toBe(0o600)
    expect(res?.ownerId).toBe('olga')
    expect(await titles(host, 'olga')).toEqual(['Tax plan'])
    expect(await titles(host, 'oscar')).toEqual([])
    expect((await fails(call(host, 'get', { id }, 'oscar'))).code).toBe('NOT_FOUND')
  })

  test('get, update, append, list, search keep the full text index in step', async () => {
    const host = setup()
    const id = await mk(host, 'olga')
    const got = (await call(host, 'get', { id }, 'olga')) as Record<string, unknown>
    expect(got).toMatchObject({ title: 'Tax plan', by: 'you', mine: true, canEdit: true })
    await call(host, 'update', { id, body: 'a kumquat budget' }, 'olga')
    await call(host, 'append', { id, text: 'second line' }, 'olga')
    expect(((await call(host, 'get', { id }, 'olga')) as { body: string }).body).toBe(
      'a kumquat budget\nsecond line',
    )
    const search = (q: string) =>
      call(host, 'search', { query: q }, 'olga') as Promise<{
        results: { id: string; excerpt: string }[]
      }>
    expect((await search('marmalade')).results).toEqual([])
    const hit = (await search('kumquat')).results
    expect(hit.map((r) => r.id)).toEqual([id])
    expect(hit[0]?.excerpt).toContain('kumquat')
    expect(Object.keys(hit[0] ?? {}).sort()).toEqual(
      ['by', 'excerpt', 'id', 'mine', 'title', 'updatedAt'].sort(),
    ) // no score, no rank
    await call(host, 'delete', { id }, 'olga')
    expect((await search('kumquat')).results).toEqual([])
    expect(host.acl.getResource('note', id)).toBeUndefined()
    expect(await titles(host, 'olga')).toEqual([])
  })

  test('operators in a query are plain words (no FTS syntax error, no injection)', async () => {
    const host = setup()
    await mk(host, 'olga', 'Plan', 'apples AND oranges')
    const r = (await call(host, 'search', { query: 'apples" oranges *' }, 'olga')) as {
      results: unknown[]
    }
    expect(r.results.length).toBe(1)
    expect(
      ((await call(host, 'search', { query: '"""' }, 'olga')) as { results: unknown[] }).results,
    ).toEqual([])
  })

  test('update needs a title or a body; sizes are capped', async () => {
    const host = setup()
    const id = await mk(host, 'olga')
    expect((await fails(call(host, 'update', { id }, 'olga'))).code).toBe('INVALID_INPUT')
    expect(
      (await fails(call(host, 'create', { title: 'x', body: 'y'.repeat(20_001) }, 'olga'))).code,
    ).toBe('INVALID_INPUT')
  })

  test('a suspended person is refused; the default role holds notes.use', async () => {
    const host = setup()
    await mk(host, 'olga')
    host.suspend('olga')
    expect((await fails(call(host, 'list', {}, 'olga'))).code).toBe('NOT_FOUND')
    host.restore('olga')
    expect(await titles(host, 'olga')).toEqual(['Tax plan'])
  })

  test('the operations Notes offers the model, and the tool names', () => {
    const names = notes.operations.filter((o) => o.expose.ai).map((o) => o.toolName)
    expect(names.sort()).toEqual(
      [
        'notes_append',
        'notes_create',
        'notes_delete',
        'notes_get',
        'notes_list',
        'notes_search',
        'notes_share',
        'notes_shares',
        'notes_unshare',
        'notes_update',
      ].sort(),
    )
    expect(notes.operation('delete')?.risk).toBe('dangerous')
    expect(notes.operation('share')?.risk).toBe('dangerous')
  })
})

describe('notes: the six sharing goals through the operations', () => {
  /** Applies a P15 case through the plugin's own share operation, as the note owner. */
  async function apply(host: MemoryHost, id: string, name: string) {
    const sh = (target: string, extra: object = {}, elevated = false) =>
      call(host, 'share', { id, target, ...extra }, 'olga', elevated)
    switch (name) {
      case '1 private':
        return
      case '2 public read':
        return void (await sh('@public', {}, true))
      case '3 users, no guests':
        return void (await sh('@users', {}, true))
      case '4 groups A and B, not C':
        await sh('group:aa')
        return void (await sh('group:bb'))
      case '4b a broad share minus group C':
        await sh('@users', {}, true)
        return void (await sh('group:cc', { deny: true }))
      case '5 Duta and Amel':
        await sh('user:duta')
        return void (await sh('user:amel'))
      case '6 Duta only':
        return void (await sh('user:duta'))
      default:
        throw new Error(name)
    }
  }

  for (const c of SHARING_CASES) {
    test(`case ${c.name}: exactly its readers get, list and find the note`, async () => {
      const host = setup()
      const id = await mk(host, 'olga')
      await apply(host, id, c.name)
      const rules = new Set<CaseActorName>(c.readers)
      for (const name of Object.keys(PEOPLE) as CaseActorName[]) {
        if (name === 'guest') continue
        const who = PEOPLE[name] as string
        // the instance owner always reads (root): by the rules or as root access
        const expected = rules.has(name) || name === 'boss'
        const get = call(host, 'get', { id }, who)
        if (expected) {
          expect(((await get) as { title: string }).title).toBe('Tax plan')
          expect(await titles(host, who)).toEqual(['Tax plan'])
          expect(
            (
              (await call(host, 'search', { query: 'marmalade' }, who)) as {
                results: unknown[]
              }
            ).results.length,
          ).toBe(1)
        } else {
          expect((await fails(get)).code).toBe('NOT_FOUND')
          expect(await titles(host, who)).toEqual([])
          expect(
            (
              (await call(host, 'search', { query: 'marmalade' }, who)) as {
                results: unknown[]
              }
            ).results,
          ).toEqual([])
        }
      }
      // the guest reaches only the public operations, and only a public note
      const guestSees = rules.has('guest')
      const pub = call(host, 'public_get', { id }, GUEST)
      if (guestSees) expect(((await pub) as { title: string }).title).toBe('Tax plan')
      else expect((await fails(pub)).code).toBe('NOT_FOUND')
      expect(((await call(host, 'public_list', {}, GUEST)) as { total: number }).total).toBe(
        guestSees ? 1 : 0,
      )
      expect((await fails(call(host, 'get', { id }, GUEST))).code).toBe('NOT_FOUND') // notes_get is not public
      // the instance owner's root read is audited when the rules alone would not give it
      const rootOnly = !rules.has('boss')
      const rows = host.audit.rows.filter((r) => r.kind === 'acl.owner-access')
      expect(rows.length > 0).toBe(rootOnly)
    })
  }

  test('unshare takes the access back; a widened share needs a confirmed call', async () => {
    const host = setup()
    const id = await mk(host, 'olga')
    await call(host, 'share', { id, target: 'user:duta' }, 'olga')
    expect(await titles(host, 'duta')).toEqual(['Tax plan'])
    const view = (await call(host, 'unshare', { id, target: 'user:duta' }, 'olga')) as {
      entries: unknown[]
    }
    expect(view.entries).toEqual([])
    expect(await titles(host, 'duta')).toEqual([])
    // a chat turn is never elevated: @public is refused and nothing changes
    const refused = await fails(call(host, 'share', { id, target: '@public' }, 'olga'))
    expect(refused.code).toBe('FORBIDDEN')
    expect(host.acl.getResource('note', id)?.entries).toEqual([])
    expect(((await call(host, 'public_list', {}, GUEST)) as { total: number }).total).toBe(0)
  })

  test('an edit grant lets Duta change the note but not delete it; a read grant lets nobody change it', async () => {
    const host = setup()
    const id = await mk(host, 'olga')
    await call(host, 'share', { id, target: 'user:duta', access: 'edit' }, 'olga')
    await call(host, 'share', { id, target: 'user:amel' }, 'olga')
    await call(host, 'append', { id, text: 'from duta' }, 'duta')
    const read = (await call(host, 'get', { id }, 'duta')) as {
      body: string
      canEdit: boolean
      by: string
    }
    expect(read.body).toContain('from duta')
    expect(read.canEdit).toBe(true)
    expect(read.by).toBe('olga')
    // a reader learns they cannot write; a stranger learns nothing
    expect((await fails(call(host, 'update', { id, title: 'x' }, 'amel'))).code).toBe('FORBIDDEN')
    expect((await fails(call(host, 'update', { id, title: 'x' }, 'oscar'))).code).toBe('NOT_FOUND')
    // delete is the owner's alone
    expect((await fails(call(host, 'delete', { id }, 'duta'))).code).toBe('FORBIDDEN')
    // only the owner changes who may read; a reader may not look at the shares either
    expect((await fails(call(host, 'share', { id, target: 'user:oscar' }, 'duta'))).code).toBe(
      'FORBIDDEN',
    )
    expect((await fails(call(host, 'shares', { id }, 'amel'))).code).toBe('FORBIDDEN')
    expect(
      ((await call(host, 'shares', { id }, 'olga')) as { entries: unknown[] }).entries.length,
    ).toBe(2)
    // the instance owner reads (root) but cannot write another person's note
    expect((await fails(call(host, 'update', { id, title: 'x' }, 'boss'))).code).toBe('FORBIDDEN')
  })

  test("search filters before the limit: other people's better matches never push your own note out", async () => {
    const host = setup()
    for (let i = 0; i < 40; i++)
      await mk(host, 'olga', `Jam ${i}`, 'marmalade marmalade marmalade marmalade marmalade')
    const mine = await mk(host, 'oscar', 'My jam', 'one marmalade')
    const r = (await call(host, 'search', { query: 'marmalade', limit: 5 }, 'oscar')) as {
      results: { id: string }[]
    }
    expect(r.results.map((x) => x.id)).toEqual([mine])
    const list = (await call(host, 'list', { limit: 5 }, 'oscar')) as { total: number }
    expect(list.total).toBe(1)
  })

  test('removing a person from a group removes what the group gave, at once', async () => {
    const host = setup()
    const id = await mk(host, 'olga')
    await call(host, 'share', { id, target: 'group:aa' }, 'olga')
    expect(await titles(host, 'mia')).toEqual(['Tax plan'])
    host.acl.removeMember('A', 'mia')
    expect(await titles(host, 'mia')).toEqual([])
    expect((await fails(call(host, 'get', { id }, 'mia'))).code).toBe('NOT_FOUND')
  })
})

describe('notes: guests', () => {
  test("a guest sees only the two public operations in every catalog; both are marked public, offered to a guest's model and hidden from a person's", async () => {
    const host = setup()
    const facts = host.directory.resolve(GUEST)
    const visible = host.guard.catalog([notes], facts as never, 'http').map((o) => o.name)
    expect(visible.sort()).toEqual(['public_get', 'public_list'])
    // the AI surface: a guest's model is offered exactly these two, a person's model neither
    const guestAi = host.guard.catalog([notes], facts as never, 'ai').map((o) => o.toolName)
    expect(guestAi.sort()).toEqual(['notes_public_get', 'notes_public_list'])
    await mk(host, 'olga')
    const personAi = host.guard
      .catalog([notes], (await host.directory.resolve('olga')) as never, 'ai')
      .map((o) => o.toolName)
    expect(personAi).not.toContain('notes_public_get')
    expect(personAi).not.toContain('notes_public_list')
    for (const name of visible) {
      const op = notes.operation(name)
      expect(op?.audience).toBe('public')
      expect(op?.expose.ai).toBe(false)
      expect(op?.expose.guest).toBe(true)
    }
    // every other operation is a plain user operation, never offered to a guest
    for (const op of notes.operations.filter((o) => !visible.includes(o.name))) {
      expect(op.audience).toBe('user')
      expect(op.expose.guest).toBe(false)
    }
  })

  test('a signed-in person calling public_list gets only what the public may read, not their own private notes', async () => {
    const host = setup()
    await mk(host, 'olga')
    const pubId = await mk(host, 'olga', 'Open', 'for all')
    await call(host, 'share', { id: pubId, target: '@public' }, 'olga', true)
    const r = (await call(host, 'public_list', {}, 'olga')) as { notes: { title: string }[] }
    expect(r.notes.map((n) => n.title)).toEqual(['Open'])
    expect(
      (await fails(call(host, 'public_get', { id: await mk(host, 'olga', 'Mine', 'x') }, 'olga')))
        .code,
    ).toBe('NOT_FOUND')
  })
})

describe('notes: the leak kit', () => {
  test('owner, outsider, group member and guest learn nothing of a private note (list, search, count, get, update, delete)', async () => {
    const host = setup()
    const who = (a: { kind: string; id: string }) => (a.kind === 'guest' ? GUEST : a.id)
    const actors = {
      owner: CASE_ACTORS.owner,
      outsider: CASE_ACTORS.outsider,
      groupMember: CASE_ACTORS.a, // a member of group A, which has no entry on the note
      guest: CASE_ACTORS.guest,
    }
    const run = (a: { kind: string; id: string }, op: string, input: unknown) =>
      call(host, op, input, who(a))
    const report = await leakCheck({
      actors,
      term: 'marmalade',
      operations: {
        list: async (a) => ((await run(a, 'list', {})) as { notes: unknown[] }).notes,
        count: async (a) => ((await run(a, 'list', {})) as { total: number }).total,
        search: async (a, term) => (await run(a, 'search', { query: term })) as unknown,
        get: (a, id) => run(a, 'get', { id }),
        update: (a, id) => run(a, 'update', { id, body: 'edited' }),
        delete: (a, id) => run(a, 'delete', { id }),
      },
      async seed() {
        return {
          id: await mk(host, 'olga'),
          missingId: crypto.randomUUID(),
          secrets: ['Tax plan', 'offshore marmalade fund'],
        }
      },
    })
    expect(report.problems).toEqual([])
    expect(report.ok).toBe(true)
  })

  test('the review helper is not involved: no operation of Notes returns a review ticket', async () => {
    const host = setup()
    const id = await mk(host, 'olga')
    expect(isReviewTicket(await call(host, 'get', { id }, 'olga'))).toBe(false)
  })
})
