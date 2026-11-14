import { describe, expect, test } from 'bun:test'
import { parsePluginEvent } from '@keith/contracts'
import { migrateDatabase, openDatabase, sqliteActivityStore } from '@keith/db'
import type { Principal } from '../auth/index.ts'
import { activityFilter } from '../thalamus/index.ts'
import { createPluginFeed } from './feed.ts'

describe('the plugin feed', () => {
  test('one record per recipient; each person reads only their own; public reaches everyone', async () => {
    const sqlite = openDatabase(':memory:')
    migrateDatabase(sqlite)
    const store = sqliteActivityStore(sqlite)
    const feed = createPluginFeed({ store })
    feed.events.publish({ plugin: 'notes', name: 'shared', data: { id: 'n1' }, to: ['ana', 'ben'] })
    feed.events.publish({ plugin: 'notes', name: 'news', data: {}, to: 'public' })
    feed.notices.notify({ plugin: 'notes', to: 'ana', text: 'saved' })
    await new Promise((r) => setTimeout(r, 20))
    const all = await store.read({ after: 0, limit: 50 })
    expect(all.length).toBe(4)
    const read = (p: Principal) =>
      all.filter(activityFilter(p)).flatMap((r) => parsePluginEvent(r) ?? [])
    const ana = read({ personId: 'ana', role: 'member' })
    expect(ana.map((e) => [e.event, e.to])).toEqual([
      ['shared', 'ana'],
      ['news', '*'],
      ['notice', 'ana'],
    ])
    expect(ana[2]?.data).toEqual({ text: 'saved' })
    expect(read({ personId: 'ben', role: 'member' }).map((e) => e.event)).toEqual([
      'shared',
      'news',
    ])
    expect(read({ personId: 'cy', role: 'member' }).map((e) => e.event)).toEqual(['news'])
    // the owner reads no one else's events
    expect(read({ personId: 'owner', role: 'owner' }).map((e) => e.event)).toEqual(['news'])
    // a record never lists another recipient
    expect(JSON.stringify(all[0]?.payload)).not.toContain('ben')
    sqlite.close()
  })

  test('a failed write is logged and never thrown', async () => {
    const warnings: string[] = []
    const feed = createPluginFeed({
      store: { append: () => Promise.reject(new Error('disk full')) } as never,
      warn: (m) => warnings.push(m),
    })
    feed.events.publish({ plugin: 'notes', name: 'x', data: {}, to: ['ana'] })
    await new Promise((r) => setTimeout(r, 10))
    expect(warnings).toEqual(['plugins: notes: could not publish x: disk full'])
  })
})
