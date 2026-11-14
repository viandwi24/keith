import { defineKeithPlugin } from '@keith/host'
import { z } from '@keith/host/schema'
import { onSchedule } from './fire.ts'
import { create } from './operations/create.ts'
import { cancel, get, list, update } from './operations/manage.ts'

/**
 * Reminders (docs/specs/plugins/reminders.md). The owner sets reminders for anyone; a person sets them for themselves;
 * a person's reminder for someone else waits for the owner's approval. The creator pays for the turn that fires it.
 */
export default defineKeithPlugin({
  id: 'reminders',
  version: '1.0.0',
  apiVersion: 1,
  title: 'Reminders',
  description: "Reminders that wake the recipient's chat at the right time.",
  permissions: [
    { id: 'reminders.use', description: 'Set and manage reminders.', roles: ['member'] },
  ],
  resources: { reminder: { class: 'action' } },
  storage: { migrations: `${import.meta.dir}/migrations` },
  tui: {
    menu: [{ id: 'list', label: 'Reminders', view: 'list', permission: 'reminders.use' }],
    views: { list: () => import('./tui/reminders-view.tsx') },
  },
  operations: [create, list, get, cancel, update],
  events: { cancelled_by_owner: z.object({ reminder: z.string().max(64) }) },
  onSchedule,
})
