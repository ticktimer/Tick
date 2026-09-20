// Tick — Drizzle schema (PostgreSQL). See handoff README "Entities" + Rules 1–4.
// Entries store only the deepest ref (ref_type/ref_id); chain + rates resolve at read time.
import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid
} from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  defaultRate: numeric('default_rate', { precision: 10, scale: 2, mode: 'number' }),
  theme: jsonb('theme'),
  /** Bumped on password reset/change; sessions carrying an older value are revoked (see requireAuth). */
  sessionVersion: integer('session_version').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
})

export const orgs = pgTable('orgs', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
})

export const orgMembers = pgTable(
  'org_members',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    rate: numeric('rate', { precision: 10, scale: 2, mode: 'number' })
  },
  t => [
    primaryKey({ columns: [t.orgId, t.userId] }),
    check('org_members_role_check', sql`${t.role} in ('owner', 'admin', 'member')`)
  ]
)

/**
 * One cascade delete, so undo needs nothing but this row's id (Tick#11).
 *
 * The rows it trashed carry `delete_batch_id`; what it *detached* cannot be
 * found that way (those rows are alive and their old parent is gone), so the
 * relink snapshot — RelinkSnapshot in server/utils/cascade.ts — is stored here.
 * Purged with the rest of the trash after 30 days.
 */
export const deleteBatches = pgTable(
  'delete_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    relinked: jsonb('relinked').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  t => [index('delete_batches_org_id_idx').on(t.orgId)]
)

export const clients = pgTable(
  'clients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    rate: numeric('rate', { precision: 10, scale: 2, mode: 'number' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    /** The cascade that trashed this row (deleteBatches.id) — undo finds it by this. */
    deleteBatchId: uuid('delete_batch_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  t => [
    index('clients_org_id_idx').on(t.orgId),
    index('clients_delete_batch_idx')
      .on(t.deleteBatchId)
      .where(sql`${t.deleteBatchId} is not null`)
  ]
)

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    clientId: uuid('client_id').references(() => clients.id, { onDelete: 'set null' }),
    rate: numeric('rate', { precision: 10, scale: 2, mode: 'number' }),
    billableDefault: boolean('billable_default').notNull().default(true),
    estimateMinutes: integer('estimate_minutes'),
    visibility: text('visibility').notNull().default('private'),
    archived: boolean('archived').notNull().default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    /** The cascade that trashed this row (deleteBatches.id). */
    deleteBatchId: uuid('delete_batch_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  t => [
    index('projects_org_id_idx').on(t.orgId),
    index('projects_client_id_idx').on(t.clientId),
    index('projects_delete_batch_idx')
      .on(t.deleteBatchId)
      .where(sql`${t.deleteBatchId} is not null`),
    check('projects_visibility_check', sql`${t.visibility} in ('private', 'public')`)
  ]
)

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    rate: numeric('rate', { precision: 10, scale: 2, mode: 'number' }),
    estimateMinutes: integer('estimate_minutes'),
    done: boolean('done').notNull().default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    /** The cascade that trashed this row (deleteBatches.id). */
    deleteBatchId: uuid('delete_batch_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  t => [
    index('tasks_org_id_idx').on(t.orgId),
    index('tasks_project_id_idx').on(t.projectId),
    index('tasks_delete_batch_idx')
      .on(t.deleteBatchId)
      .where(sql`${t.deleteBatchId} is not null`)
  ]
)

export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  t => [unique('tags_org_id_name_unique').on(t.orgId, t.name)]
)

export const timeEntries = pgTable(
  'time_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull().default(''),
    /** Deepest ref only (Rule 1): 'client' | 'project' | 'task' | null */
    refType: text('ref_type'),
    refId: uuid('ref_id'),
    billable: boolean('billable').notNull().default(true),
    rateOverride: numeric('rate_override', { precision: 10, scale: 2, mode: 'number' }),
    start: timestamp('start', { withTimezone: true }).notNull(),
    end: timestamp('end', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    /** The cascade that trashed this row (deleteBatches.id). */
    deleteBatchId: uuid('delete_batch_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  t => [
    index('time_entries_user_start_idx').on(t.userId, t.start),
    // Undo: every row one cascade trashed, however many that is (Tick#11).
    // Partial, so it holds only rows currently in the trash from a cascade.
    index('time_entries_delete_batch_idx')
      .on(t.deleteBatchId)
      .where(sql`${t.deleteBatchId} is not null`),
    index('time_entries_org_id_idx').on(t.orgId),
    index('time_entries_ref_id_idx').on(t.refId),
    // Org-wide date ranges over live, ended entries (reports, CSV/PDF export,
    // cascade subtree scans). Partial: trashed rows and the timer never match.
    index('time_entries_org_start_live_idx')
      .on(t.orgId, t.start)
      .where(sql`${t.deletedAt} is null and ${t.end} is not null`),
    // Trash listing + 30-day purge (GET /api/trash runs both every visit).
    // Partial: holds only trashed rows, so it stays tiny.
    index('time_entries_org_trash_idx')
      .on(t.orgId, t.deletedAt)
      .where(sql`${t.deletedAt} is not null`),
    // Timer = row with end IS NULL. A user may run several at once, up to
    // MAX_RUNNING_TIMERS (Tick#37) — a cap the start route holds inside a
    // per-user advisory lock, not an invariant the database can express, so
    // this is a plain lookup index where a partial UNIQUE index used to sit.
    // Its predicate is exactly the one GET /api/timers and the cap count read,
    // and leading with (user_id, start) also serves the list's `start ASC`.
    index('time_entries_user_running_idx')
      .on(t.userId, t.start)
      .where(sql`${t.end} is null and ${t.deletedAt} is null`),
    check('time_entries_ref_type_check', sql`${t.refType} in ('client', 'project', 'task')`)
  ]
)

export const invites = pgTable(
  'invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role').notNull().default('member'),
    token: text('token').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  t => [
    index('invites_org_id_idx').on(t.orgId),
    check('invites_role_check', sql`${t.role} in ('owner', 'admin', 'member')`)
  ]
)

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  t => [index('password_reset_tokens_user_id_idx').on(t.userId)]
)

export const entryTags = pgTable(
  'entry_tags',
  {
    entryId: uuid('entry_id')
      .notNull()
      .references(() => timeEntries.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' })
  },
  t => [
    primaryKey({ columns: [t.entryId, t.tagId] }),
    // The PK leads with entry_id; lookups by tag (tag stats for one tag, the
    // ON DELETE CASCADE when a trashed tag is purged) need their own index.
    index('entry_tags_tag_id_idx').on(t.tagId)
  ]
)
