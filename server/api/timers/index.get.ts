// GET /api/timers — every running entry (end IS NULL) for the caller, as
// TimerState[]. Ordered `start ASC, id ASC` so a row never jumps in the running
// list when another timer starts, and `[]` — never 204 — when nothing runs.
// The WHERE matches time_entries_user_running_idx exactly.
export default defineEventHandler(async (event): Promise<TimerState[]> => {
  const user = await requireAuth(event)
  const db = useDrizzle()
  const rows = await db
    .select()
    .from(schema.timeEntries)
    .where(
      and(
        eq(schema.timeEntries.orgId, user.orgId),
        eq(schema.timeEntries.userId, user.id),
        isNull(schema.timeEntries.end),
        isNull(schema.timeEntries.deletedAt)
      )
    )
    .orderBy(asc(schema.timeEntries.start), asc(schema.timeEntries.id))
  if (!rows.length) return []
  const ctx = await loadRateContext(db, user.orgId)
  return rows.map(row => toTimerState(row, ctx))
})
