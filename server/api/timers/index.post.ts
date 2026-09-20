// POST /api/timers — insert a running entry. Stops nothing: a user may run up
// to MAX_RUNNING_TIMERS of them at once (Tick#37). At the cap → 409.
import { z } from 'zod'
import { MAX_RUNNING_TIMERS } from '#shared/utils/timers'

// Monotonic start marks (entry id → performance.now()). The WSL wall clock —
// which Postgres' now() also follows — can step backwards; performance.now()
// cannot. [id]/stop.post.ts reads these to measure true elapsed time. Kept on
// globalThis so dev HMR reloads don't drop marks for a running timer.
// Keyed by entry id, so N concurrent timers each carry their own mark.
const monoStarts: Map<string, number> =
  ((globalThis as Record<string, unknown> & { __tickTimerMonoStarts?: Map<string, number> })
    .__tickTimerMonoStarts ??= new Map())

const bodySchema = z
  .object({
    name: z.string().trim().max(500).default(''),
    refType: z.enum(['client', 'project', 'task']).nullish(),
    refId: z.uuid().nullish(),
    billable: z.boolean().optional()
  })
  .refine(b => (b.refType != null) === (b.refId != null), {
    message: 'refType and refId go together'
  })

export default defineEventHandler(async (event): Promise<TimerState> => {
  const user = await requireAuth(event)
  const body = await readSanitizedBody(event, bodySchema)
  const db = useDrizzle()
  const ctx = await loadRateContext(db, user.orgId)

  const chain = walkChain(body.refType, body.refId, ctx)
  if (body.refType && body.refId && !chain) {
    throw createError({ statusCode: 400, message: `Unknown ${body.refType}` })
  }

  // billable defaults from project.billable_default when resolvable, else true (Rule 2).
  const billable = body.billable ?? (chain ? chain.billableDefault : true)

  // Count and insert as ONE critical section per user. The partial unique index
  // used to make a double start impossible; a cap is not an invariant the
  // schema can express, so parallel starts would otherwise each read "9
  // running" and all insert. pg_advisory_xact_lock serialises this user's
  // starts and is released by COMMIT/ROLLBACK — nothing to unlock by hand.
  // hashtext() folds the uuid into the int8 the lock space wants; a collision
  // between two users costs them a moment of waiting, never a wrong count.
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${user.id}::text)::bigint)`)
    // Per user, not per org — the cap this replaces (the old unique index) was
    // keyed on user_id alone, and MAX_RUNNING_TIMERS counts a person's timers.
    const [counted] = await tx
      .select({ running: sql<number>`count(*)::int` })
      .from(schema.timeEntries)
      .where(
        and(
          eq(schema.timeEntries.userId, user.id),
          isNull(schema.timeEntries.end),
          isNull(schema.timeEntries.deletedAt)
        )
      )
    if ((counted?.running ?? 0) >= MAX_RUNNING_TIMERS) return null
    const [created] = await tx
      .insert(schema.timeEntries)
      .values({
        orgId: user.orgId,
        userId: user.id,
        name: body.name,
        refType: body.refType ?? null,
        refId: body.refId ?? null,
        billable,
        // DB clock, not JS Date: the host wall clock (WSL) can step backwards;
        // pairing with stop's SQL-side math keeps durations non-negative.
        start: sql`now()`
      })
      .returning()
    return created!
  })

  if (!row) {
    throw createError({
      statusCode: 409,
      message: `Timer limit reached (${MAX_RUNNING_TIMERS} running).`
    })
  }

  monoStarts.set(row.id, performance.now())
  return toTimerState(row, ctx)
})
