// PATCH /api/entries/:id — partial edit of an ended entry (a running timer
// is edited via PATCH /api/timers/:id). Keeps start < end true after the merge.
import { z } from 'zod'

const isoDate = z
  .string()
  .transform(s => new Date(s))
  .refine(d => Number.isFinite(d.getTime()), { message: 'Invalid date' })

const bodySchema = z
  .object({
    name: z.string().trim().max(500).optional(),
    refType: z.enum(['client', 'project', 'task']).nullish(),
    refId: z.uuid().nullish(),
    billable: z.boolean().optional(),
    rateOverride: z.number().nonnegative().nullish(),
    start: isoDate.optional(),
    end: isoDate.optional(),
    tags: z.array(z.string()).max(50).optional()
  })
  .refine(b => !(typeof b.refId === 'string' && b.refType == null), {
    message: 'refType is required with refId'
  })

export default defineEventHandler(async (event): Promise<EntryDto> => {
  const user = await requireAuth(event)
  const id = uuidRouterParam(event, 'id')
  const body = await readSanitizedBody(event, bodySchema)
  const db = useDrizzle()

  const [existing] = await db
    .select()
    .from(schema.timeEntries)
    .where(
      and(
        eq(schema.timeEntries.id, id),
        eq(schema.timeEntries.orgId, user.orgId),
        eq(schema.timeEntries.userId, user.id),
        isNull(schema.timeEntries.deletedAt),
        isNotNull(schema.timeEntries.end)
      )
    )
    .limit(1)
  if (!existing) throw createError({ statusCode: 404, message: 'Entry not found' })

  const ctx = await loadRateContext(db, user.orgId)
  const patch: Partial<typeof schema.timeEntries.$inferInsert> = {}

  if (body.name !== undefined) patch.name = body.name
  if (body.billable !== undefined) patch.billable = body.billable
  if (body.rateOverride !== undefined) patch.rateOverride = body.rateOverride
  if (body.refId === null || body.refType === null) {
    patch.refType = null
    patch.refId = null
  } else if (typeof body.refId === 'string') {
    if (!walkChain(body.refType, body.refId, ctx)) {
      throw createError({ statusCode: 400, message: `Unknown ${body.refType}` })
    }
    patch.refType = body.refType!
    patch.refId = body.refId
  }
  if (body.start !== undefined) patch.start = body.start
  if (body.end !== undefined) patch.end = body.end

  const nextStart = body.start ?? existing.start
  const nextEnd = body.end ?? existing.end!
  if (nextStart.getTime() >= nextEnd.getTime()) {
    throw createError({ statusCode: 400, message: 'start must be before end' })
  }

  const [row] = Object.keys(patch).length
    ? await db
        .update(schema.timeEntries)
        .set(patch)
        .where(eq(schema.timeEntries.id, id))
        .returning()
    : [existing]

  let tagNames: string[]
  if (body.tags !== undefined) {
    const tagRows = await ensureTags(db, user.orgId, body.tags)
    await setEntryTags(db, id, tagRows.map(t => t.id))
    tagNames = tagRows.map(t => t.name).sort()
  } else {
    tagNames = (await fetchTagsForEntries(db, [id])).get(id) ?? []
  }
  return toEntryDto(row!, ctx, tagNames)
})
