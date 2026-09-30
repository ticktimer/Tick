// GET /api/entries?from=ISO&to=ISO — the session user's entries in range,
// newest first. Excludes the running timer and trashed rows. By default an
// entry is in range when it STARTS inside it (the Time page's day groups);
// `overlap=1` also returns entries that started earlier but end inside it,
// which is how the calendar gets the tail of an entry that ran past midnight.
import { z } from 'zod'

const isoDate = z
  .string()
  .transform(s => new Date(s))
  .refine(d => Number.isFinite(d.getTime()), { message: 'Invalid date' })

const querySchema = z.object({
  from: isoDate,
  to: isoDate,
  overlap: z.enum(['1', 'true']).optional()
})

export default defineEventHandler(async (event): Promise<EntryDto[]> => {
  const user = await requireAuth(event)
  const { from, to, overlap } = getSanitizedQuery(event, querySchema)
  const db = useDrizzle()

  const e = schema.timeEntries
  // Only the columns toEntryDto reads; the rate context loads in parallel.
  const rowsQ = db
    .select({
      id: e.id,
      userId: e.userId,
      name: e.name,
      refType: e.refType,
      refId: e.refId,
      billable: e.billable,
      rateOverride: e.rateOverride,
      start: e.start,
      end: e.end
    })
    .from(schema.timeEntries)
    .where(
      and(
        eq(schema.timeEntries.orgId, user.orgId),
        eq(schema.timeEntries.userId, user.id),
        isNull(schema.timeEntries.deletedAt),
        isNotNull(schema.timeEntries.end),
        overlap
          ? and(lt(schema.timeEntries.start, to), gt(schema.timeEntries.end, from))
          : and(gte(schema.timeEntries.start, from), lte(schema.timeEntries.start, to))
      )
    )
    .orderBy(desc(schema.timeEntries.start))

  const [rows, ctx] = await Promise.all([rowsQ, loadRateContext(db, user.orgId)])
  const tags = await fetchTagsForEntries(db, rows.map(r => r.id))
  return rows.map(r => toEntryDto(r, ctx, tags.get(r.id) ?? []))
})
