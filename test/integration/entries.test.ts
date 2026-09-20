/**
 * Entry CRUD + bulk contracts (docs/content/4.reference/2.api.md §Entries).
 * All timestamps are fixed local datetimes in a dedicated day, so nothing here
 * depends on the wall clock.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  closeTestDb,
  registerAccount,
  schema,
  testDb,
  type ApiClient,
  type TestAccount
} from '../helpers/server'

const at = (h: number, m = 0) => new Date(2026, 1, 10, h, m, 0, 0).toISOString()
const FROM = new Date(2026, 1, 10, 0, 0, 0, 0).toISOString()
const TO = new Date(2026, 1, 11, 0, 0, 0, 0).toISOString()
const OTHER_DAY = new Date(2026, 1, 12, 9, 0, 0, 0).toISOString()
const OTHER_DAY_END = new Date(2026, 1, 12, 10, 0, 0, 0).toISOString()
const UNKNOWN_UUID = '00000000-0000-4000-8000-000000000000'

let acct: TestAccount
let api: ApiClient
let client: any
let project: any
let task: any

beforeAll(async () => {
  acct = await registerAccount()
  api = acct.client
  client = (await api.post('/api/clients', { name: 'Entries Client', rate: 100 })).body
  project = (
    await api.post('/api/projects', { name: 'Entries Project', clientId: client.id, rate: 120 })
  ).body
  task = (await api.post('/api/tasks', { name: 'Entries Task', projectId: project.id })).body
}, 60_000)

afterAll(async () => {
  await closeTestDb()
})

/** Wipes this user's entries so each test starts from a known, empty range. */
beforeEach(async () => {
  await testDb()
    .delete(schema.timeEntries)
    .where(eq(schema.timeEntries.userId, acct.user.id))
})

async function create(body: Record<string, unknown>) {
  const res = await api.post('/api/entries', body)
  expect(res.status).toBe(200)
  return res.body
}

async function listRange() {
  const res = await api.get(`/api/entries?from=${FROM}&to=${TO}`)
  expect(res.status).toBe(200)
  return res.body as any[]
}

describe('POST /api/entries', () => {
  it('creates a manual entry with the resolved chain, rate, amount and tags', async () => {
    const res = await api.post('/api/entries', {
      name: 'Intake form validation',
      refType: 'task',
      refId: task.id,
      start: at(13),
      end: at(14, 45),
      tags: ['Design', '#meeting', 'design']
    })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      name: 'Intake form validation',
      billable: true,
      resolvedRate: 120,
      rateOverridden: false,
      durationSec: 6300,
      amount: 210, // 1.75h × $120
      tags: ['design', 'meeting'] // lowercased, '#' stripped, deduped, sorted
    })
    expect(res.body.ref).toMatchObject({
      refType: 'task',
      refId: task.id,
      taskName: 'Entries Task',
      projectName: 'Entries Project',
      clientName: 'Entries Client'
    })
    expect(res.body.start).toBe(at(13))
    expect(res.body.end).toBe(at(14, 45))
  })

  it('400s when start is not before end, and when a ref is half-specified', async () => {
    const backwards = await api.post('/api/entries', {
      name: 'backwards',
      start: at(14),
      end: at(13)
    })
    expect(backwards.status).toBe(400)
    expect(backwards.body.statusMessage).toBe('Invalid input')

    const halfRef = await api.post('/api/entries', {
      name: 'half ref',
      refType: 'task',
      start: at(9),
      end: at(10)
    })
    expect(halfRef.status).toBe(400)
  })

  it('400s a ref that does not resolve in this org catalog', async () => {
    const res = await api.post('/api/entries', {
      name: 'ghost ref',
      refType: 'project',
      refId: UNKNOWN_UUID,
      start: at(9),
      end: at(10)
    })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/unknown project/i)
  })
})

describe('GET /api/entries', () => {
  it('returns the range newest-first and excludes running + trashed rows', async () => {
    const early = await create({ name: 'early', start: at(8), end: at(9) })
    const late = await create({ name: 'late', start: at(16), end: at(17) })
    const trashed = await create({ name: 'trashed', start: at(12), end: at(13) })
    await create({ name: 'other day', start: OTHER_DAY, end: OTHER_DAY_END })
    await api.del(`/api/entries/${trashed.id}`)

    const running = await api.post('/api/timers', { name: 'running now' })
    expect(running.status).toBe(200)
    try {
      const rows = await listRange()
      expect(rows.map(r => r.id)).toEqual([late.id, early.id]) // desc by start
      expect(rows.map(r => r.name)).not.toContain('trashed')
      expect(rows.map(r => r.name)).not.toContain('running now')
      expect(rows.map(r => r.name)).not.toContain('other day')
    } finally {
      await api.post(`/api/timers/${running.body.entryId}/stop`)
    }
  })

  it('400s a missing or unparseable range', async () => {
    expect((await api.get('/api/entries')).status).toBe(400)
    const bad = await api.get('/api/entries?from=nonsense&to=alsonot')
    expect(bad.status).toBe(400)
    expect(bad.body.statusMessage).toBe('Invalid input')
  })
})

describe('PATCH /api/entries/:id', () => {
  it('applies partial edits and re-resolves rate + amount', async () => {
    const entry = await create({
      name: 'before',
      refType: 'task',
      refId: task.id,
      start: at(9),
      end: at(11)
    })
    expect(entry.amount).toBe(240) // 2h × $120

    const renamed = await api.patch(`/api/entries/${entry.id}`, { name: 'after' })
    expect(renamed.status).toBe(200)
    expect(renamed.body.name).toBe('after')

    const overridden = await api.patch(`/api/entries/${entry.id}`, { rateOverride: 250 })
    expect(overridden.body).toMatchObject({
      resolvedRate: 250,
      rateOverridden: true,
      amount: 500
    })

    const cleared = await api.patch(`/api/entries/${entry.id}`, { rateOverride: null })
    expect(cleared.body).toMatchObject({
      resolvedRate: 120,
      rateOverridden: false,
      amount: 240
    })

    const nonBillable = await api.patch(`/api/entries/${entry.id}`, { billable: false })
    expect(nonBillable.body.billable).toBe(false)
    expect(nonBillable.body.amount).toBeNull()

    const detached = await api.patch(`/api/entries/${entry.id}`, { refType: null, refId: null })
    expect(detached.body.ref).toBeNull()

    const retagged = await api.patch(`/api/entries/${entry.id}`, { tags: ['dev'] })
    expect(retagged.body.tags).toEqual(['dev'])
    const untagged = await api.patch(`/api/entries/${entry.id}`, { tags: [] })
    expect(untagged.body.tags).toEqual([])

    const moved = await api.patch(`/api/entries/${entry.id}`, { start: at(9), end: at(9, 30) })
    expect(moved.body.durationSec).toBe(1800)
  })

  it('400s when the merged range would be inverted', async () => {
    const entry = await create({ name: 'ranged', start: at(9), end: at(11) })
    const res = await api.patch(`/api/entries/${entry.id}`, { start: at(12) })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/start must be before end/i)

    // Unchanged on disk.
    const rows = await listRange()
    expect(rows.find(r => r.id === entry.id).start).toBe(at(9))
  })

  it('404s an unknown id and a trashed entry', async () => {
    const entry = await create({ name: 'gone soon', start: at(9), end: at(10) })
    await api.del(`/api/entries/${entry.id}`)
    expect((await api.patch(`/api/entries/${entry.id}`, { name: 'x' })).status).toBe(404)
    expect((await api.patch(`/api/entries/${UNKNOWN_UUID}`, { name: 'x' })).status).toBe(404)
  })
})

describe('DELETE /api/entries/:id + POST /api/restore', () => {
  it('soft-deletes then restores the same row', async () => {
    const entry = await create({ name: 'undo me', start: at(9), end: at(10) })

    const del = await api.del(`/api/entries/${entry.id}`)
    expect(del.status).toBe(200)
    expect(del.body).toEqual({
      deleted: { clients: [], projects: [], tasks: [], entries: [entry.id] },
      detached: { projects: 0, tasks: 0, entries: 0 }
    })
    expect((await listRange()).map(r => r.id)).not.toContain(entry.id)

    // Soft, not hard: the row is still there with deleted_at set.
    const [row] = await testDb()
      .select()
      .from(schema.timeEntries)
      .where(eq(schema.timeEntries.id, entry.id))
    expect(row!.deletedAt).not.toBeNull()

    const undo = await api.post('/api/restore', { deleted: del.body.deleted })
    expect(undo.status).toBe(200)
    expect(undo.body.restored).toEqual({
      clients: 0,
      projects: 0,
      tasks: 0,
      entries: 1,
      tags: 0
    })
    expect((await listRange()).map(r => r.id)).toContain(entry.id)

    // Restoring twice restores nothing the second time (isNotNull guard).
    const again = await api.post('/api/restore', { deleted: del.body.deleted })
    expect(again.body.restored.entries).toBe(0)
  })

  it('404s deleting the same entry twice', async () => {
    const entry = await create({ name: 'once', start: at(9), end: at(10) })
    expect((await api.del(`/api/entries/${entry.id}`)).status).toBe(200)
    expect((await api.del(`/api/entries/${entry.id}`)).status).toBe(404)
  })
})

describe('POST /api/entries/bulk', () => {
  it('billable flips the whole selection and reports a count', async () => {
    const a = await create({ name: 'a', start: at(9), end: at(10) })
    const b = await create({ name: 'b', start: at(10), end: at(11) })

    const off = await api.post('/api/entries/bulk', {
      ids: [a.id, b.id],
      action: 'billable',
      billable: false
    })
    expect(off.status).toBe(200)
    expect(off.body).toEqual({ count: 2 })
    expect((await listRange()).every(r => r.billable === false)).toBe(true)

    const on = await api.post('/api/entries/bulk', {
      ids: [a.id, b.id],
      action: 'billable',
      billable: true
    })
    expect(on.body).toEqual({ count: 2 })
    expect((await listRange()).every(r => r.billable === true)).toBe(true)
  })

  it('400s billable without the flag', async () => {
    const a = await create({ name: 'a', start: at(9), end: at(10) })
    const res = await api.post('/api/entries/bulk', { ids: [a.id], action: 'billable' })
    expect(res.status).toBe(400)
  })

  it('delete → restore round-trips through the DeleteResult snapshot', async () => {
    const a = await create({ name: 'a', start: at(9), end: at(10) })
    const b = await create({ name: 'b', start: at(10), end: at(11) })

    const del = await api.post('/api/entries/bulk', { ids: [a.id, b.id], action: 'delete' })
    expect(del.status).toBe(200)
    expect(del.body.deleted.entries.sort()).toEqual([a.id, b.id].sort())
    expect(del.body.detached).toEqual({ projects: 0, tasks: 0, entries: 0 })
    expect(await listRange()).toHaveLength(0)

    const restored = await api.post('/api/entries/bulk', {
      ids: [a.id, b.id],
      action: 'restore'
    })
    expect(restored.body).toEqual({ count: 2 })
    expect(await listRange()).toHaveLength(2)
  })

  it('reassign moves the selection and validates the target ref', async () => {
    const a = await create({ name: 'a', start: at(9), end: at(10) })
    const b = await create({
      name: 'b',
      refType: 'task',
      refId: task.id,
      start: at(10),
      end: at(11)
    })

    const toClient = await api.post('/api/entries/bulk', {
      ids: [a.id, b.id],
      action: 'reassign',
      refType: 'client',
      refId: client.id
    })
    expect(toClient.status).toBe(200)
    expect(toClient.body).toHaveLength(2)
    for (const dto of toClient.body) {
      expect(dto.ref).toMatchObject({ refType: 'client', refId: client.id })
      expect(dto.resolvedRate).toBe(100) // client rate now, not the project's 120
    }

    const cleared = await api.post('/api/entries/bulk', {
      ids: [a.id, b.id],
      action: 'reassign',
      refType: null,
      refId: null
    })
    expect(cleared.body.every((d: any) => d.ref === null)).toBe(true)

    const ghost = await api.post('/api/entries/bulk', {
      ids: [a.id],
      action: 'reassign',
      refType: 'project',
      refId: UNKNOWN_UUID
    })
    expect(ghost.status).toBe(400)
    expect(ghost.body.message).toMatch(/unknown project/i)

    const halfRef = await api.post('/api/entries/bulk', {
      ids: [a.id],
      action: 'reassign',
      refType: 'project'
    })
    expect(halfRef.status).toBe(400)
  })

  it('validates the id list itself', async () => {
    expect((await api.post('/api/entries/bulk', { ids: [], action: 'delete' })).status).toBe(400)
    expect(
      (await api.post('/api/entries/bulk', { ids: ['not-a-uuid'], action: 'delete' })).status
    ).toBe(400)
    const tooMany = Array.from({ length: 501 }, () => UNKNOWN_UUID)
    expect((await api.post('/api/entries/bulk', { ids: tooMany, action: 'delete' })).status).toBe(
      400
    )
    expect(
      (await api.post('/api/entries/bulk', { ids: [UNKNOWN_UUID], action: 'nope' })).status
    ).toBe(400)
  })

  it('never trashes a running timer through a bulk delete', async () => {
    const started = await api.post('/api/timers', { name: 'protected' })
    expect(started.status).toBe(200)
    try {
      const res = await api.post('/api/entries/bulk', {
        ids: [started.body.entryId],
        action: 'delete'
      })
      expect(res.status).toBe(200)
      expect(res.body.deleted.entries).toEqual([])
      expect((await api.get('/api/timers')).body.map((t: any) => t.entryId)).toEqual([
        started.body.entryId
      ])
    } finally {
      await api.post(`/api/timers/${started.body.entryId}/stop`)
    }
  })
})
