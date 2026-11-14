// The persona and the per-person style of the prefrontal region (docs/specs/prefrontal.md, "Data model", ADR-0029 §2 and §3,
// P33.2.1). The persona is one global row with its history; the style is one row per person who set something. Person
// ids are plain text or a foreign key to `people` as in identity.ts; a removed person's style follows the removal registry
// (ADR-0027 §26), so the foreign key has no cascade.
import { sql } from 'drizzle-orm'
import { check, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { people } from './identity.ts'

/**
 * The current persona: one row, `id` is always `keith`. `version` moves by one with every write, and the write also adds a
 * `persona_versions` row in the same transaction. `body` is JSON of `PersonaBodySchema` (contracts), validated on read.
 */
export const persona = sqliteTable(
  'persona',
  {
    id: text('id').primaryKey(),
    version: integer('version').notNull(),
    /** A built-in template id, or `custom` after an owner edit. */
    templateId: text('template_id').notNull(),
    body: text('body').notNull(),
    updatedAt: integer('updated_at').notNull(),
    /** The person who wrote the row (a person id, no foreign key). */
    updatedBy: text('updated_by').notNull(),
  },
  (t) => [
    check('persona_singleton', sql`${t.id} = 'keith'`),
    check(
      'persona_template_known',
      sql`${t.templateId} IN ('butler', 'friend', 'professional', 'custom')`,
    ),
  ],
)

/**
 * The history of the persona: every version written, never pruned (owner history). `version` is unique, so two writes that
 * name the same version are refused by the database. `reason` is `template`, `edit` or `restore`; a restore writes a new
 * version and keeps the old one. `note` is at most 200 characters.
 */
export const personaVersions = sqliteTable(
  'persona_versions',
  {
    id: text('id').primaryKey(),
    version: integer('version').notNull(),
    templateId: text('template_id').notNull(),
    body: text('body').notNull(),
    reason: text('reason').notNull(),
    changedBy: text('changed_by').notNull(),
    changedAt: integer('changed_at').notNull(),
    note: text('note'),
  },
  (t) => [
    uniqueIndex('persona_versions_version').on(t.version),
    check(
      'persona_versions_template_known',
      sql`${t.templateId} IN ('butler', 'friend', 'professional', 'custom')`,
    ),
    check('persona_versions_reason_known', sql`${t.reason} IN ('template', 'edit', 'restore')`),
  ],
)

/**
 * The style one person set for Keith's replies. An absent row means every default (`PersonStyleSchema` defaults). `address`
 * is null for "the name in the profile"; `gentle_topics` is JSON of at most 5 values from the closed list. The enums are
 * CHECKs; `language` holds `auto` or a tag from the fixed list. Removed with the person by the removal registry (P33.2.5).
 */
export const personStyle = sqliteTable(
  'person_style',
  {
    personId: text('person_id')
      .primaryKey()
      .references(() => people.id),
    address: text('address'),
    language: text('language').notNull().default('auto'),
    brevity: text('brevity').notNull().default('normal'),
    formality: text('formality').notNull().default('neutral'),
    gentleTopics: text('gentle_topics').notNull().default('[]'),
    updatedAt: integer('updated_at').notNull(),
    /** The person who wrote the row: the person themself, or the owner through the audited path. */
    updatedBy: text('updated_by').notNull(),
  },
  (t) => [
    check(
      'person_style_language_known',
      sql`${t.language} IN ('auto', 'en-US', 'id-ID', 'es-ES', 'fr-FR', 'de-DE', 'pt-BR', 'nl-NL', 'ja-JP', 'ko-KR', 'zh-CN', 'ar', 'hi-IN')`,
    ),
    check('person_style_brevity_known', sql`${t.brevity} IN ('short', 'normal', 'full')`),
    check('person_style_formality_known', sql`${t.formality} IN ('casual', 'neutral', 'formal')`),
    check(
      'person_style_address_length',
      sql`${t.address} IS NULL OR (length(${t.address}) BETWEEN 1 AND 40)`,
    ),
  ],
)
