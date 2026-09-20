/**
 * Rule 3 cascade delete (README Rule 3, docs/content/3.guide/2.projects-clients-tasks.md):
 * checked levels go to trash, unchecked levels are KEPT and detached, and the
 * returned snapshot restores both halves.
 *
 * Every test builds its own client → project → task subtree with four entries:
 *   e1 → task, e2 → project, e3 → client, e4 → no reference
 * so the expected deletions/detachments can be written out by hand.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  closeTestDb,
  registerAccount,
  stopAllTimers,
  type ApiClient,
  type TestAccount
} from '../helpers/server'

const at = (h: number, m = 0) => new Date(2026, 3, 6, h, m, 0, 0).toISOString()
const FROM = new Date(2026, 3, 6, 0, 0, 0, 0).toISOString()
const TO = new Date(2026, 3, 7, 0, 0, 0, 0).toISOString()

let acct: TestAccount
let api: ApiClient
let treeSeq = 0

beforeAll(async () => {
  acct = await registerAccount()
  api = acct.client
}, 60_000)

afterAll(async () => {
  await stopAllTimers(api)
  await closeTestDb()
})

interface Tree {
  client: any
  project: any
  task: any
  e1: any
  e2: any
  e3: any
  e4: any
}

async function makeTree(): Promise<Tree> {
  const n = ++treeSeq
  const client = (await api.post('/api/clients', { name: `C${n}`, rate: 100 })).body
  const project = (await api.post('/api/projects', { name: `P${n}`, clientId: client.id })).body
  const task = (await api.post('/api/tasks', { name: `T${n}`, projectId: project.id })).body
  const mk = (name: string, ref: any, hour: number) =>
    api
      .post('/api/entries', { name, ...ref, start: at(hour), end: at(hour + 1) })
      .then(r => {
        expect(r.status).toBe(200)
        return r.body
      })
  const e1 = await mk(`e1-${n}`, { refType: 'task', refId: task.id }, 9)
  const e2 = await mk(`e2-${n}`, { refType: 'project', refId: project.id }, 10)
  const e3 = await mk(`e3-${n}`, { refType: 'client', refId: client.id }, 11)
  const e4 = await mk(`e4-${n}`, {}, 12)
  return { client, project, task, e1, e2, e3, e4 }
}

async function entryById(id: string) {
  const res = await api.get(`/api/entries?from=${FROM}&to=${TO}`)
  expect(res.status).toBe(200)
  return (res.body as any[]).find(e => e.id === id) ?? null
}

async function projectById(id: string) {
  return ((await api.get('/api/projects')).body as any[]).find(p => p.id === id) ?? null
}

async function taskById(id: string) {
  return ((await api.get('/api/tasks')).body as any[]).find(t => t.id === id) ?? null
}

async function clientById(id: string) {
  return ((await api.get('/api/clients')).body as any[]).find(c => c.id === id) ?? null
}

describe('GET /api/:entity/:id/cascade — counts match reality', () => {
  it('client counts equal what a full cascade actually deletes', async () => {
    const t = await makeTree()
    const counts = await api.get(`/api/clients/${t.client.id}/cascade`)
    expect(counts.status).toBe(200)
    expect(counts.body).toEqual({ projects: 1, tasks: 1, entries: 3 })

    const del = await api.del(`/api/clients/${t.client.id}`, {
      cascadeProjects: true,
      cascadeTasks: true,
      cascadeEntries: true
    })
    expect(del.status).toBe(200)
    expect(del.body.deleted.projects).toHaveLength(counts.body.projects)
    expect(del.body.deleted.tasks).toHaveLength(counts.body.tasks)
    expect(del.body.deleted.entries).toHaveLength(counts.body.entries)
  })

  it('project counts equal what a full project cascade deletes', async () => {
    const t = await makeTree()
    const counts = await api.get(`/api/projects/${t.project.id}/cascade`)
    expect(counts.status).toBe(200)
    // e1 (task ref) + e2 (project ref); e3 hangs off the client, not the project.
    expect(counts.body).toEqual({ projects: 0, tasks: 1, entries: 2 })

    const del = await api.del(`/api/projects/${t.project.id}`, {
      cascadeTasks: true,
      cascadeEntries: true
    })
    expect(del.body.deleted.tasks).toHaveLength(counts.body.tasks)
    expect(del.body.deleted.entries).toHaveLength(counts.body.entries)
  })

  it('counts ignore trashed rows and running timers', async () => {
    const t = await makeTree()
    await api.del(`/api/entries/${t.e2.id}`) // trash one of the three
    const started = await api.post('/api/timers', { refType: 'task', refId: t.task.id })
    expect(started.status).toBe(200)
    try {
      const counts = await api.get(`/api/clients/${t.client.id}/cascade`)
      // 3 - 1 trashed = 2; running (end IS NULL) rows are never counted.
      expect(counts.body).toEqual({ projects: 1, tasks: 1, entries: 2 })
    } finally {
      await api.post(`/api/timers/${started.body.entryId}/stop`)
    }
  })

  it('404s cascade counts for an unknown or already-trashed client', async () => {
    const t = await makeTree()
    await api.del(`/api/clients/${t.client.id}`, {})
    expect((await api.get(`/api/clients/${t.client.id}/cascade`)).status).toBe(404)
    expect(
      (await api.get('/api/clients/00000000-0000-4000-8000-000000000000/cascade')).status
    ).toBe(404)
  })
})

describe('DELETE /api/clients/:id — every checkbox combination', () => {
  it('nothing checked: client trashed, project detached, direct entries detached', async () => {
    const t = await makeTree()
    const res = await api.del(`/api/clients/${t.client.id}`, {
      cascadeProjects: false,
      cascadeTasks: false,
      cascadeEntries: false
    })
    expect(res.status).toBe(200)
    expect(res.body.deleted).toEqual({
      clients: [t.client.id],
      projects: [],
      tasks: [],
      entries: []
    })
    expect(res.body.detached).toEqual({ projects: 1, tasks: 0, entries: 1 })
    expect(res.body.relinked.projects).toEqual([{ id: t.project.id, clientId: t.client.id }])
    expect(res.body.relinked.entries).toEqual([
      { id: t.e3.id, refType: 'client', refId: t.client.id }
    ])

    expect(await clientById(t.client.id)).toBeNull()
    expect((await projectById(t.project.id)).clientId).toBeNull()
    expect((await taskById(t.task.id)).projectId).toBe(t.project.id)
    expect((await entryById(t.e1.id)).ref).toMatchObject({ refType: 'task', refId: t.task.id })
    expect((await entryById(t.e2.id)).ref).toMatchObject({
      refType: 'project',
      refId: t.project.id
    })
    expect((await entryById(t.e3.id)).ref).toBeNull() // kept, time intact
    expect((await entryById(t.e3.id)).durationSec).toBe(3600)
    expect((await entryById(t.e4.id)).ref).toBeNull()
  })

  it('projects checked: project trashed, task detached, client+project entries detached', async () => {
    const t = await makeTree()
    const res = await api.del(`/api/clients/${t.client.id}`, {
      cascadeProjects: true,
      cascadeTasks: false,
      cascadeEntries: false
    })
    expect(res.body.deleted).toEqual({
      clients: [t.client.id],
      projects: [t.project.id],
      tasks: [],
      entries: []
    })
    expect(res.body.detached).toEqual({ projects: 0, tasks: 1, entries: 2 })
    expect(res.body.relinked.tasks).toEqual([{ id: t.task.id, projectId: t.project.id }])

    expect(await projectById(t.project.id)).toBeNull()
    expect((await taskById(t.task.id)).projectId).toBeNull()
    expect((await entryById(t.e1.id)).ref).toMatchObject({ refType: 'task', refId: t.task.id })
    expect((await entryById(t.e2.id)).ref).toBeNull()
    expect((await entryById(t.e3.id)).ref).toBeNull()
  })

  it('projects + tasks checked: all three referenced entries detached, none trashed', async () => {
    const t = await makeTree()
    const res = await api.del(`/api/clients/${t.client.id}`, {
      cascadeProjects: true,
      cascadeTasks: true,
      cascadeEntries: false
    })
    expect(res.body.deleted).toEqual({
      clients: [t.client.id],
      projects: [t.project.id],
      tasks: [t.task.id],
      entries: []
    })
    expect(res.body.detached).toEqual({ projects: 0, tasks: 0, entries: 3 })

    expect(await taskById(t.task.id)).toBeNull()
    for (const e of [t.e1, t.e2, t.e3]) {
      const dto = await entryById(e.id)
      expect(dto).toBeTruthy() // time survives
      expect(dto.ref).toBeNull()
      expect(dto.durationSec).toBe(3600)
    }
  })

  it('everything checked: the whole subtree goes to trash and nothing is detached', async () => {
    const t = await makeTree()
    const res = await api.del(`/api/clients/${t.client.id}`, {
      cascadeProjects: true,
      cascadeTasks: true,
      cascadeEntries: true
    })
    expect(res.body.deleted.clients).toEqual([t.client.id])
    expect(res.body.deleted.projects).toEqual([t.project.id])
    expect(res.body.deleted.tasks).toEqual([t.task.id])
    expect(res.body.deleted.entries.sort()).toEqual([t.e1.id, t.e2.id, t.e3.id].sort())
    expect(res.body.detached).toEqual({ projects: 0, tasks: 0, entries: 0 })

    for (const e of [t.e1, t.e2, t.e3]) expect(await entryById(e.id)).toBeNull()
    expect(await entryById(t.e4.id)).toBeTruthy() // unrelated entry untouched
  })

  it('entries checked but projects not (API accepts any combination)', async () => {
    const t = await makeTree()
    const res = await api.del(`/api/clients/${t.client.id}`, {
      cascadeProjects: false,
      cascadeTasks: false,
      cascadeEntries: true
    })
    expect(res.body.deleted.projects).toEqual([])
    expect(res.body.deleted.entries.sort()).toEqual([t.e1.id, t.e2.id, t.e3.id].sort())
    // The project survives (detached); the entries it referenced are already
    // trashed, so there is nothing left to detach.
    expect(res.body.detached).toEqual({ projects: 1, tasks: 0, entries: 0 })
    expect((await projectById(t.project.id)).clientId).toBeNull()
  })

  it('an omitted body defaults every flag to false', async () => {
    const t = await makeTree()
    const res = await api.del(`/api/clients/${t.client.id}`)
    expect(res.status).toBe(200)
    expect(res.body.deleted).toEqual({
      clients: [t.client.id],
      projects: [],
      tasks: [],
      entries: []
    })
  })

  it('never trashes a running timer, only detaches it', async () => {
    const t = await makeTree()
    const started = await api.post('/api/timers', { refType: 'task', refId: t.task.id })
    expect(started.status).toBe(200)
    try {
      const res = await api.del(`/api/clients/${t.client.id}`, {
        cascadeProjects: true,
        cascadeTasks: true,
        cascadeEntries: true
      })
      expect(res.body.deleted.entries).not.toContain(started.body.entryId)
      expect(res.body.detached.entries).toBe(1)

      const timers = await api.get('/api/timers')
      expect(timers.status).toBe(200)
      const timer = timers.body.find((x: any) => x.entryId === started.body.entryId)
      expect(timer).toBeTruthy()
      expect(timer.ref).toBeNull()
    } finally {
      await api.post(`/api/timers/${started.body.entryId}/stop`)
    }
  })
})

describe('DELETE /api/projects/:id — every checkbox combination', () => {
  it('nothing checked: task detached, project entries detached', async () => {
    const t = await makeTree()
    const res = await api.del(`/api/projects/${t.project.id}`, {
      cascadeTasks: false,
      cascadeEntries: false
    })
    expect(res.body.deleted).toEqual({
      clients: [],
      projects: [t.project.id],
      tasks: [],
      entries: []
    })
    expect(res.body.detached).toEqual({ projects: 0, tasks: 1, entries: 1 })
    expect((await taskById(t.task.id)).projectId).toBeNull()
    expect((await entryById(t.e1.id)).ref).toMatchObject({ refType: 'task' })
    expect((await entryById(t.e2.id)).ref).toBeNull()
    expect((await entryById(t.e3.id)).ref).toMatchObject({ refType: 'client' })
    expect(await clientById(t.client.id)).toBeTruthy()
  })

  it('tasks checked: task trashed, task + project entries detached', async () => {
    const t = await makeTree()
    const res = await api.del(`/api/projects/${t.project.id}`, {
      cascadeTasks: true,
      cascadeEntries: false
    })
    expect(res.body.deleted.tasks).toEqual([t.task.id])
    expect(res.body.deleted.entries).toEqual([])
    expect(res.body.detached).toEqual({ projects: 0, tasks: 0, entries: 2 })
    expect((await entryById(t.e1.id)).ref).toBeNull()
    expect((await entryById(t.e2.id)).ref).toBeNull()
  })

  it('tasks + entries checked: subtree trashed, client entry untouched', async () => {
    const t = await makeTree()
    const res = await api.del(`/api/projects/${t.project.id}`, {
      cascadeTasks: true,
      cascadeEntries: true
    })
    expect(res.body.deleted.entries.sort()).toEqual([t.e1.id, t.e2.id].sort())
    expect(res.body.detached).toEqual({ projects: 0, tasks: 0, entries: 0 })
    expect(await entryById(t.e1.id)).toBeNull()
    expect(await entryById(t.e2.id)).toBeNull()
    expect((await entryById(t.e3.id)).ref).toMatchObject({ refType: 'client' })
  })
})

describe('DELETE /api/tasks/:id', () => {
  it('trashes the task and detaches its entries (time is never lost)', async () => {
    const t = await makeTree()
    const res = await api.del(`/api/tasks/${t.task.id}`)
    expect(res.status).toBe(200)
    expect(res.body.deleted).toEqual({
      clients: [],
      projects: [],
      tasks: [t.task.id],
      entries: []
    })
    expect(res.body.detached).toEqual({ projects: 0, tasks: 0, entries: 1 })
    expect(res.body.relinked.entries).toEqual([
      { id: t.e1.id, refType: 'task', refId: t.task.id }
    ])

    expect(await taskById(t.task.id)).toBeNull()
    const e1 = await entryById(t.e1.id)
    expect(e1.ref).toBeNull()
    expect(e1.durationSec).toBe(3600)
  })
})

describe('POST /api/restore re-links what a cascade detached', () => {
  it('undoes a client delete with nothing checked', async () => {
    const t = await makeTree()
    const del = await api.del(`/api/clients/${t.client.id}`, {
      cascadeProjects: false,
      cascadeTasks: false,
      cascadeEntries: false
    })
    const undo = await api.post('/api/restore', {
      deleted: del.body.deleted,
      relinked: del.body.relinked
    })
    expect(undo.status).toBe(200)
    expect(undo.body.restored).toEqual({
      clients: 1,
      projects: 0,
      tasks: 0,
      entries: 0,
      tags: 0
    })

    expect(await clientById(t.client.id)).toBeTruthy()
    expect((await projectById(t.project.id)).clientId).toBe(t.client.id)
    expect((await entryById(t.e3.id)).ref).toMatchObject({
      refType: 'client',
      refId: t.client.id
    })
  })

  it('undoes a client delete with projects + tasks checked (rows AND edges)', async () => {
    const t = await makeTree()
    const del = await api.del(`/api/clients/${t.client.id}`, {
      cascadeProjects: true,
      cascadeTasks: true,
      cascadeEntries: false
    })
    const undo = await api.post('/api/restore', {
      deleted: del.body.deleted,
      relinked: del.body.relinked
    })
    expect(undo.body.restored).toEqual({
      clients: 1,
      projects: 1,
      tasks: 1,
      entries: 0,
      tags: 0
    })

    expect(await clientById(t.client.id)).toBeTruthy()
    expect((await projectById(t.project.id)).clientId).toBe(t.client.id)
    expect((await taskById(t.task.id)).projectId).toBe(t.project.id)
    expect((await entryById(t.e1.id)).ref).toMatchObject({ refType: 'task', refId: t.task.id })
    expect((await entryById(t.e2.id)).ref).toMatchObject({
      refType: 'project',
      refId: t.project.id
    })
    expect((await entryById(t.e3.id)).ref).toMatchObject({
      refType: 'client',
      refId: t.client.id
    })
  })

  it('undoes a full cascade, entries included', async () => {
    const t = await makeTree()
    const del = await api.del(`/api/clients/${t.client.id}`, {
      cascadeProjects: true,
      cascadeTasks: true,
      cascadeEntries: true
    })
    const undo = await api.post('/api/restore', {
      deleted: del.body.deleted,
      relinked: del.body.relinked
    })
    expect(undo.body.restored).toEqual({
      clients: 1,
      projects: 1,
      tasks: 1,
      entries: 3,
      tags: 0
    })
    for (const e of [t.e1, t.e2, t.e3]) expect(await entryById(e.id)).toBeTruthy()
    expect((await entryById(t.e1.id)).ref).toMatchObject({ refType: 'task', refId: t.task.id })
  })

  it('undoes a task delete', async () => {
    const t = await makeTree()
    const del = await api.del(`/api/tasks/${t.task.id}`)
    const undo = await api.post('/api/restore', {
      deleted: del.body.deleted,
      relinked: del.body.relinked
    })
    expect(undo.body.restored.tasks).toBe(1)
    expect((await taskById(t.task.id)).projectId).toBe(t.project.id)
    expect((await entryById(t.e1.id)).ref).toMatchObject({ refType: 'task', refId: t.task.id })
  })
})

describe('DELETE /api/tags/:id', () => {
  it('strips the label from entries without touching time, and restore brings it back', async () => {
    const n = ++treeSeq
    const tagName = `cascade-tag-${n}`
    const tag = (await api.post('/api/tags', { name: tagName })).body
    const entry = (
      await api.post('/api/entries', {
        name: `tagged-${n}`,
        start: at(14),
        end: at(15),
        tags: [tagName]
      })
    ).body
    expect(entry.tags).toEqual([tagName])

    const del = await api.del(`/api/tags/${tag.id}`)
    expect(del.status).toBe(200)
    expect(del.body).toMatchObject({ id: tag.id, name: tagName, entryCount: 1 })

    expect(((await api.get('/api/tags')).body as any[]).map(t => t.id)).not.toContain(tag.id)
    const stripped = await entryById(entry.id)
    expect(stripped).toBeTruthy()
    expect(stripped.tags).toEqual([])
    expect(stripped.durationSec).toBe(3600) // time untouched

    const undo = await api.post('/api/restore', { deleted: { tags: [tag.id] } })
    expect(undo.body.restored.tags).toBe(1)
    expect((await entryById(entry.id)).tags).toEqual([tagName])
  })
})
