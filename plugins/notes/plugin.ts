import { defineKeithPlugin } from '@keith/host'
import { get, list, publicGet, publicList, search } from './operations/read.ts'
import { share, sharesOf, unshare } from './operations/share.ts'
import { append, create, remove, update } from './operations/write.ts'

/**
 * Notes: private by default, shareable per the ACL (docs/specs/plugins/notes.md). The content lives in
 * `plg_notes_*` (with an FTS5 index); who may read or write a note lives in the ACL (kind `note`, a leaf, mode 0600).
 */
export default defineKeithPlugin({
  id: 'notes',
  version: '1.0.0',
  apiVersion: 1,
  title: 'Notes',
  description: 'Private notes you can share with people, groups, everyone or the public.',
  permissions: [
    { id: 'notes.use', description: 'Write, read and share notes.', roles: ['member'] },
  ],
  resources: { note: { class: 'leaf' } },
  storage: { migrations: `${import.meta.dir}/migrations` },
  tui: {
    menu: [{ id: 'browse', label: 'Notes', view: 'browse', permission: 'notes.use' }],
    views: { browse: () => import('./tui/notes-view.tsx') },
  },
  operations: [
    create,
    get,
    update,
    append,
    remove,
    list,
    search,
    share,
    unshare,
    sharesOf,
    publicGet,
    publicList,
  ],
})
