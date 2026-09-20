/**
 * Timer contracts (CONTRACTS.md §Timers, docs/content/3.guide/1.timer-and-entries.md):
 * a user may run SEVERAL timers at once (Tick#37), up to MAX_RUNNING_TIMERS —
 * past the cap a start is 409. Every mutation names the timer by id, so
 * stopping or editing one leaves the others running. A stop under one second
 * is treated as an accidental tap and hard-deleted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import { MAX_RUNNING_TIMERS } from '../../shared/utils/timers'
import {
  closeTestDb,
  registerAccount,
  schema,
  sleep,
  stopAllTimers,
  testDb,
  type ApiClient,
  type TestAccount
} from '../helpers/server'

const UNKNOWN_UUID = '00000000-0000-4000-8000-000000000000'

let acct: TestAccount
let api: ApiClient
let client: any
let project: any
let task: any
let quietProject: any
let quietTask: any

beforeAll(async () => {
  acct = await registerAccount()
  api = acct.client
  client = (await api.post('/api/clients', { name: 'Timer Client', rate: 100 })).body
  project = (
    await api.post('/api/projects', { name: 'Timer Project', clientId: client.id, rate: 150 })
  ).body
  task = (await api.post('/api/tasks', { name: 'Timer Task', projectId: project.id })).body
  quietProject = (
    await api.post('/api/projects', { name: 'Non-billable Project', billableDefault: false })
  ).body
  quietTask = (
    await api.post('/api/tasks', { name: 'Quiet Task', projectId: quietProject.id })
  ).body
}, 60_000)

afterAll(async () => {
  await stopAllTimers(api)
  await closeTestDb()
})

/** Running (end IS NULL, not trashed) rows for this user, straight from the DB. */
async function runningRows() {
  return testDb()
    .select()
    .from(schema.timeEntries)
    .where(
      and(
        eq(schema.timeEntries.userId, acct.user.id),
        isNull(schema.timeEntries.end),
        isNull(schema.timeEntries.deletedAt)
      )
    )
}

/** Start one timer and return its TimerState, failing loudly if it did not. */
async function start(body: Record<string, unknown> = {}) {
  const res = await api.post('/api/timers', body)
  expect(`start -> ${res.status}`).toBe('start -> 200')
  return res.body
}

const listIds = async () =>
  (await api.get('/api/timers')).body.map((t: any) => t.entryId)

describe('GET /api/timers', () => {
  it('is an empty array when nothing runs — never 204', async () => {
    await stopAllTimers(api)
    const res = await api.get('/api/timers')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  it('returns every running timer ordered by start ascending', async () => {
    await stopAllTimers(api)
    const first = await start({ name: 'first' })
    await sleep(1100) // distinct `start` values, so the order is unambiguous
    const second = await start({ name: 'second' })
    await sleep(1100)
    const third = await start({ name: 'third' })

    const res = await api.get('/api/timers')
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(3)
    expect(res.body.map((t: any) => t.entryId)).toEqual([
      first.entryId,
      second.entryId,
      third.entryId
    ])
    expect(res.body.map((t: any) => t.name)).toEqual(['first', 'second', 'third'])
    // Ascending, so a row already in the list never jumps when one is added.
    const starts = res.body.map((t: any) => Date.parse(t.start))
    expect([...starts].sort((a, b) => a - b)).toEqual(starts)
    expect(await runningRows()).toHaveLength(3)

    await stopAllTimers(api)
  })
})

describe('POST /api/timers', () => {
  it('returns a TimerState with the resolved chain and rate', async () => {
    await stopAllTimers(api)
    const started = await api.post('/api/timers', {
      name: 'Writing tests',
      refType: 'task',
      refId: task.id
    })
    expect(started.status).toBe(200)
    expect(started.body).toMatchObject({
      name: 'Writing tests',
      billable: true,
      resolvedRate: 150 // project rate wins over client rate (Rule 2)
    })
    expect(started.body.entryId).toMatch(/^[0-9a-f-]{36}$/)
    expect(started.body.ref).toMatchObject({
      refType: 'task',
      refId: task.id,
      taskName: 'Timer Task',
      projectName: 'Timer Project',
      clientName: 'Timer Client'
    })
    expect(Number.isFinite(Date.parse(started.body.start))).toBe(true)

    await stopAllTimers(api)
  })

  it('starts a second timer instead of 409ing — the first keeps running', async () => {
    await stopAllTimers(api)
    const first = await start({ name: 'one' })
    const second = await api.post('/api/timers', { name: 'two' })
    expect(second.status).toBe(200)
    expect(second.body.entryId).not.toBe(first.entryId)
    expect(await runningRows()).toHaveLength(2)
    expect(await listIds()).toEqual(
      expect.arrayContaining([first.entryId, second.body.entryId])
    )
    await stopAllTimers(api)
  })

  it('400s an unknown reference', async () => {
    await stopAllTimers(api)
    const res = await api.post('/api/timers', { refType: 'project', refId: UNKNOWN_UUID })
    expect(res.status).toBe(400)
    expect(await runningRows()).toHaveLength(0)
  })
})

describe('PATCH /api/timers/:id', () => {
  it('renames, retargets, detaches and toggles billable on one timer only', async () => {
    await stopAllTimers(api)
    const target = await start({ name: 'before' })
    const bystander = await start({ name: 'bystander', refType: 'task', refId: task.id })

    const renamed = await api.patch(`/api/timers/${target.entryId}`, {
      name: 'after',
      billable: false
    })
    expect(renamed.status).toBe(200)
    expect(renamed.body).toMatchObject({ name: 'after', billable: false })
    expect(renamed.body.entryId).toBe(target.entryId)

    const attached = await api.patch(`/api/timers/${target.entryId}`, {
      refType: 'project',
      refId: project.id
    })
    expect(attached.status).toBe(200)
    expect(attached.body.ref).toMatchObject({ refType: 'project', refId: project.id })
    expect(attached.body.resolvedRate).toBe(150)

    const detached = await api.patch(`/api/timers/${target.entryId}`, {
      refType: null,
      refId: null
    })
    expect(detached.status).toBe(200)
    expect(detached.body.ref).toBeNull()

    const bogus = await api.patch(`/api/timers/${target.entryId}`, {
      refType: 'project',
      refId: UNKNOWN_UUID
    })
    expect(bogus.status).toBe(400)

    // The other timer was never touched.
    const list = (await api.get('/api/timers')).body
    const other = list.find((t: any) => t.entryId === bystander.entryId)
    expect(other).toMatchObject({ name: 'bystander', billable: true })
    expect(other.ref).toMatchObject({ refType: 'task', refId: task.id })
    expect(await runningRows()).toHaveLength(2)

    await stopAllTimers(api)
  })

  it('404s with a generic message for unknown, ended and trashed ids', async () => {
    await stopAllTimers(api)
    const unknown = await api.patch(`/api/timers/${UNKNOWN_UUID}`, { name: 'nope' })
    expect(unknown.status).toBe(404)
    expect(unknown.body.message).toBe('No timer running.')

    // An id that exists but has already stopped reads exactly the same.
    const started = await start({ name: 'will end' })
    await sleep(1200)
    expect((await api.post(`/api/timers/${started.entryId}/stop`)).status).toBe(200)
    const ended = await api.patch(`/api/timers/${started.entryId}`, { name: 'nope' })
    expect(ended.status).toBe(404)
    expect(ended.body.message).toBe('No timer running.')

    // Trashed, too.
    await api.del(`/api/entries/${started.entryId}`)
    const trashed = await api.patch(`/api/timers/${started.entryId}`, { name: 'nope' })
    expect(trashed.status).toBe(404)
    expect(trashed.body.message).toBe('No timer running.')

    expect((await api.patch('/api/timers/not-a-uuid', { name: 'nope' })).status).toBe(400)
  })
})

describe('POST /api/timers/:id/stop', () => {
  it('persists the entry with a real end and leaves the others running', async () => {
    await stopAllTimers(api)
    const keep = await start({ name: 'still going' })
    const started = await start({ name: 'Persisted run', refType: 'task', refId: task.id })
    await sleep(1200)

    const stopped = await api.post(`/api/timers/${started.entryId}/stop`)
    expect(stopped.status).toBe(200)
    expect(stopped.body.id).toBe(started.entryId)
    expect(stopped.body.end).not.toBeNull()
    expect(stopped.body.durationSec).toBeGreaterThanOrEqual(1)
    expect(stopped.body.name).toBe('Persisted run')
    expect(stopped.body.resolvedRate).toBe(150)
    // amount is rounded to cents at the DTO boundary (round2 in entry-dto.ts).
    expect(stopped.body.amount).toBe(
      Math.round((stopped.body.durationSec / 3600) * 150 * 100) / 100
    )

    // The row really is in the database, ended, not trashed.
    const [row] = await testDb()
      .select()
      .from(schema.timeEntries)
      .where(eq(schema.timeEntries.id, started.entryId))
    expect(row).toBeTruthy()
    expect(row!.end).not.toBeNull()
    expect(row!.deletedAt).toBeNull()
    expect(row!.end!.getTime()).toBeGreaterThan(row!.start.getTime())

    // The sibling survived, and it is the only thing left running.
    expect(await listIds()).toEqual([keep.entryId])
    expect(await runningRows()).toHaveLength(1)

    await stopAllTimers(api)
  })

  it('404s with a generic message for unknown, ended and already-stopped ids', async () => {
    await stopAllTimers(api)
    const unknown = await api.post(`/api/timers/${UNKNOWN_UUID}/stop`)
    expect(unknown.status).toBe(404)
    expect(unknown.body.message).toBe('No timer running.')

    const started = await start({ name: 'stop me twice' })
    await sleep(1200)
    expect((await api.post(`/api/timers/${started.entryId}/stop`)).status).toBe(200)
    const again = await api.post(`/api/timers/${started.entryId}/stop`)
    expect(again.status).toBe(404)
    expect(again.body.message).toBe('No timer running.')

    expect((await api.post('/api/timers/not-a-uuid/stop')).status).toBe(400)
  })
})

describe('sub-second stop', () => {
  it('discards the row, returns null, and touches nothing else', async () => {
    await stopAllTimers(api)
    const keep = await start({ name: 'still going' })
    const started = await api.post('/api/timers', { name: 'Accidental tap' })
    expect(started.status).toBe(200)
    const id = started.body.entryId

    const stopped = await api.post(`/api/timers/${id}/stop`)
    expect([200, 204]).toContain(stopped.status)
    expect(stopped.body).toBeNull()

    // Hard-deleted: not trashed, simply gone.
    const rows = await testDb()
      .select()
      .from(schema.timeEntries)
      .where(eq(schema.timeEntries.id, id))
    expect(rows).toHaveLength(0)

    expect(await listIds()).toEqual([keep.entryId])
    expect(await runningRows()).toHaveLength(1)

    await stopAllTimers(api)
  })
})

describe(`the ${MAX_RUNNING_TIMERS}-timer cap`, () => {
  it('allows the cap and 409s the next start', async () => {
    await stopAllTimers(api)
    for (let i = 0; i < MAX_RUNNING_TIMERS; i++) {
      await start({ name: `capped ${i}` })
    }
    expect(await runningRows()).toHaveLength(MAX_RUNNING_TIMERS)

    const overflow = await api.post('/api/timers', { name: 'one too many' })
    expect(overflow.status).toBe(409)
    expect(overflow.body.message).toBe(`Timer limit reached (${MAX_RUNNING_TIMERS} running).`)
    expect(await runningRows()).toHaveLength(MAX_RUNNING_TIMERS)

    // Stopping one makes room again.
    const [first] = await listIds()
    await sleep(1100)
    expect((await api.post(`/api/timers/${first}/stop`)).status).toBe(200)
    const retry = await api.post('/api/timers', { name: 'room again' })
    expect(retry.status).toBe(200)
    expect(await runningRows()).toHaveLength(MAX_RUNNING_TIMERS)

    await stopAllTimers(api)
  })

  it('holds under parallel starts: the cap is never overshot', async () => {
    await stopAllTimers(api)
    const attempts = MAX_RUNNING_TIMERS + 5
    const results = await Promise.all(
      Array.from({ length: attempts }, (_, i) =>
        api.post('/api/timers', { name: `race ${i}` })
      )
    )
    const ok = results.filter(r => r.status === 200)
    const capped = results.filter(r => r.status === 409)
    expect(ok).toHaveLength(MAX_RUNNING_TIMERS)
    expect(capped).toHaveLength(attempts - MAX_RUNNING_TIMERS)
    expect(ok.length + capped.length).toBe(attempts)
    expect(await runningRows()).toHaveLength(MAX_RUNNING_TIMERS)

    await stopAllTimers(api)
  })

  it('parallel starts under the cap all succeed', async () => {
    await stopAllTimers(api)
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => api.post('/api/timers', { name: `parallel ${i}` }))
    )
    expect(results.map(r => r.status)).toEqual([200, 200, 200, 200, 200])
    const ids = new Set(results.map(r => r.body.entryId))
    expect(ids.size).toBe(5)
    expect(await runningRows()).toHaveLength(5)
    expect((await api.get('/api/timers')).body).toHaveLength(5)

    await stopAllTimers(api)
  })
})

describe('billable default (Rule 2)', () => {
  it("inherits the project's billable_default when the caller does not say", async () => {
    await stopAllTimers(api)
    const quiet = await api.post('/api/timers', {
      refType: 'task',
      refId: quietTask.id
    })
    expect(quiet.status).toBe(200)
    expect(quiet.body.billable).toBe(false)

    const explicit = await api.post('/api/timers', {
      refType: 'task',
      refId: quietTask.id,
      billable: true
    })
    expect(explicit.status).toBe(200)
    expect(explicit.body.billable).toBe(true)

    await stopAllTimers(api)
  })
})
