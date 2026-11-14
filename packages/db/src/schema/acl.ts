// ACL tables (P15, docs/specs/acl.md, docs/specs/db.md).
import {
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

// --- ACL (P15, docs/specs/acl.md) ----------------------------------------------------------------

/** Groups of people, created and managed by the owner. Flat: a group has people, never groups. */
export const aclGroups = sqliteTable(
  'groups',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('groups_name').on(t.name)],
)

/**
 * Members of a group. `person_id` has no foreign key on purpose: removing a person must not be
 * blocked by their memberships (the service removes them), and a stale row grants nothing because a
 * check also needs the person to be active.
 */
export const aclGroupMembers = sqliteTable(
  'group_members',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => aclGroups.id, { onDelete: 'cascade' }),
    personId: text('person_id').notNull(),
    addedBy: text('added_by').notNull(),
    addedAt: integer('added_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.personId] }),
    index('group_members_person').on(t.personId),
  ],
)

/**
 * The access data of every shareable thing; the content stays in the plugin's own table. `mode`
 * holds nine bits (owner, team, public). `owner_id` and `group_id` carry no foreign key: see
 * `aclGroupMembers`; a group in use is refused at delete by the store.
 */
export const aclResources = sqliteTable(
  'resources',
  {
    kind: text('kind').notNull(),
    id: text('id').notNull(),
    ownerId: text('owner_id').notNull(),
    groupId: text('group_id'),
    mode: integer('mode').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.kind, t.id] }),
    index('resources_owner_kind').on(t.ownerId, t.kind),
    index('resources_group').on(t.groupId),
  ],
)

/**
 * Extra entries of a resource. `subject_kind` is `user | group | users | public`; `subject_id` is ''
 * for the last two. One row per (subject, effect). Deleting a resource deletes its entries.
 */
export const aclEntries = sqliteTable(
  'resource_acl',
  {
    kind: text('kind').notNull(),
    id: text('id').notNull(),
    subjectKind: text('subject_kind').notNull(),
    subjectId: text('subject_id').notNull().default(''),
    bits: integer('bits').notNull(),
    effect: text('effect').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.kind, t.id, t.subjectKind, t.subjectId, t.effect] }),
    foreignKey({
      columns: [t.kind, t.id],
      foreignColumns: [aclResources.kind, aclResources.id],
    }).onDelete('cascade'),
    index('resource_acl_subject').on(t.subjectKind, t.subjectId),
  ],
)
