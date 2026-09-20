/**
 * Tenancy / IDOR — the most important file in this suite.
 *
 * Contract (docs/content/4.reference/4.security.md §Tenancy): "Every query is
 * scoped by org_id, and entry mutations additionally by user_id. Ids are UUIDs
 * and validated as such, so a guessed id from another org returns 404, not
 * data."
 *
 * Two orgs are registered fresh for this file. Org B holds every id org A owns
 * and tries, endpoint by endpoint, to read or mutate them — including bulk
 * operations with MIXED id sets and a foreign /api/restore snapshot. Every
 * assertion checks BOTH the response B gets AND that A's rows are untouched
 * afterwards, because a silent partial write is the failure mode that matters.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ApiClient,
  closeTestDb,
  MAIN_URL,
  registerAccount,
  stopAllTimers,
  uniqueEmail,
  type TestAccount
} from '../helpers/server'

type Client = ApiClient

const at = (h: number, m = 0) => new Date(2026, 0, 5, h, m, 0, 0).toISOString()
const FROM = new Date(2026, 0, 5, 0, 0, 0, 0).toISOString()
const TO = new Date(2026, 0, 6, 0, 0, 0, 0).toISOString()
const RANDOM_UUID = '00000000-0000-4000-8000-000000000000'

interface Fixture {
  acct: TestAccount
  client: any
  project: any
  task: any
  tag: any
  entry: any
}

async function buildOrg(name: string): Promise<Fixture> {
  const acct = await registerAccount(MAIN_URL, { name })
  const api = acct.client
  const client = (await api.post('/api/clients', { name: `${name} Client`, rate: 100 })).body
  const project = (
    await api.post('/api/projects', { name: `${name} Project`, clientId: client.id, rate: 200 })
  ).body
  const task = (await api.post('/api/tasks', { name: `${name} Task`, projectId: project.id })).body
  const tag = (await api.post('/api/tags', { name: `${name.toLowerCase()}-tag` })).body
  const entry = (
    await api.post('/api/entries', {
      name: `${name} Entry`,
      refType: 'task',
      refId: task.id,
      start: at(9),
      end: at(10),
      tags: [`${name.toLowerCase()}-tag`]
    })
  ).body
  return { acct, client, project, task, tag, entry }
}

/** An extra ended entry for a given account, so mutation tests never share rows. */
async function makeEntry(api: Client, name: string, hour: number) {
  const res = await api.post('/api/entries', {
    name,
    start: at(hour),
    end: at(hour + 1)
  })
  expect(res.status).toBe(200)
  return res.body
}

let A: Fixture
let B: Fixture
let a: Client
let b: Client

beforeAll(async () => {
  ;[A, B] = await Promise.all([buildOrg('Alpha'), buildOrg('Bravo')])
  a = A.acct.client
  b = B.acct.client
}, 60_000)

afterAll(async () => {
  await closeTestDb()
})

describe('catalog reads are org-scoped', () => {
  it('B never sees A rows in any list endpoint', async () => {
    const [clients, projects, tasks, tags] = await Promise.all([
      b.get('/api/clients'),
      b.get('/api/projects'),
      b.get('/api/tasks'),
      b.get('/api/tags')
    ])
    expect(clients.status).toBe(200)
    expect(clients.body.map((c: any) => c.id)).not.toContain(A.client.id)
    expect(clients.body.map((c: any) => c.id)).toContain(B.client.id)
    expect(projects.body.map((p: any) => p.id)).not.toContain(A.project.id)
    expect(tasks.body.map((t: any) => t.id)).not.toContain(A.task.id)
    expect(tags.body.map((t: any) => t.id)).not.toContain(A.tag.id)
  })

  it('B sees only its own org and members', async () => {
    const org = await b.get('/api/org')
    expect(org.status).toBe(200)
    expect(org.body.id).toBe(B.acct.user.orgId)
    expect(org.body.id).not.toBe(A.acct.user.orgId)

    const members = await b.get('/api/org/members')
    expect(members.status).toBe(200)
    expect(members.body.map((m: any) => m.email)).toEqual([B.acct.email])
  })

  it("B's entry range never contains A rows", async () => {
    const res = await b.get(`/api/entries?from=${FROM}&to=${TO}`)
    expect(res.status).toBe(200)
    const ids = res.body.map((e: any) => e.id)
    expect(ids).toContain(B.entry.id)
    expect(ids).not.toContain(A.entry.id)
  })
})

describe('catalog mutations by id are 404 across orgs', () => {
  it('clients: patch / delete / cascade counts', async () => {
    expect((await b.patch(`/api/clients/${A.client.id}`, { name: 'pwned' })).status).toBe(404)
    expect((await b.get(`/api/clients/${A.client.id}/cascade`)).status).toBe(404)
    expect(
      (
        await b.del(`/api/clients/${A.client.id}`, {
          cascadeProjects: true,
          cascadeTasks: true,
          cascadeEntries: true
        })
      ).status
    ).toBe(404)

    // A still has it, unrenamed and not trashed.
    const mine = await a.get('/api/clients')
    const row = mine.body.find((c: any) => c.id === A.client.id)
    expect(row).toBeTruthy()
    expect(row.name).toBe('Alpha Client')
  })

  it('projects: patch / delete / cascade counts', async () => {
    expect((await b.patch(`/api/projects/${A.project.id}`, { name: 'pwned' })).status).toBe(404)
    expect((await b.get(`/api/projects/${A.project.id}/cascade`)).status).toBe(404)
    expect(
      (await b.del(`/api/projects/${A.project.id}`, { cascadeTasks: true, cascadeEntries: true }))
        .status
    ).toBe(404)

    const mine = await a.get('/api/projects')
    const row = mine.body.find((p: any) => p.id === A.project.id)
    expect(row?.name).toBe('Alpha Project')
    expect(row?.clientId).toBe(A.client.id)
  })

  it('tasks: patch / delete', async () => {
    expect((await b.patch(`/api/tasks/${A.task.id}`, { done: true })).status).toBe(404)
    expect((await b.del(`/api/tasks/${A.task.id}`)).status).toBe(404)

    const mine = await a.get('/api/tasks')
    const row = mine.body.find((t: any) => t.id === A.task.id)
    expect(row?.done).toBe(false)
  })

  it('tags: delete', async () => {
    expect((await b.del(`/api/tags/${A.tag.id}`)).status).toBe(404)
    const mine = await a.get('/api/tags')
    expect(mine.body.map((t: any) => t.id)).toContain(A.tag.id)
  })

  it('B cannot reparent its own rows onto A catalog rows', async () => {
    // 400 "Unknown project"/"Unknown client" — the ref check is org-scoped too.
    const p = await b.patch(`/api/tasks/${B.task.id}`, { projectId: A.project.id })
    expect(p.status).toBe(400)
    const c = await b.patch(`/api/projects/${B.project.id}`, { clientId: A.client.id })
    expect(c.status).toBe(400)

    const tasks = await b.get('/api/tasks')
    expect(tasks.body.find((t: any) => t.id === B.task.id).projectId).toBe(B.project.id)
  })
})

describe('entry mutations by id are 404 across orgs', () => {
  it('patch / delete', async () => {
    expect((await b.patch(`/api/entries/${A.entry.id}`, { name: 'pwned' })).status).toBe(404)
    expect((await b.del(`/api/entries/${A.entry.id}`)).status).toBe(404)

    const mine = await a.get(`/api/entries?from=${FROM}&to=${TO}`)
    const row = mine.body.find((e: any) => e.id === A.entry.id)
    expect(row).toBeTruthy()
    expect(row.name).toBe('Alpha Entry')
    expect(row.billable).toBe(true)
  })

  it('a well-formed unknown uuid is 404, a malformed one is a terse 400', async () => {
    expect((await b.patch(`/api/entries/${RANDOM_UUID}`, { name: 'x' })).status).toBe(404)
    const bad = await b.patch('/api/entries/not-a-uuid', { name: 'x' })
    expect(bad.status).toBe(400)
    expect(bad.body.statusMessage).toBe('Invalid input')
    expect(bad.body.data).toEqual({ fields: ['id'] })
    expect(bad.text).not.toMatch(/invalid input syntax for type uuid/i)
  })
})

describe('bulk operations with MIXED id sets', () => {
  it('delete touches only the caller own rows', async () => {
    const mine = await makeEntry(b, 'Bravo bulk delete', 11)
    const res = await b.post('/api/entries/bulk', {
      ids: [mine.id, A.entry.id],
      action: 'delete'
    })
    expect(res.status).toBe(200)
    expect(res.body.deleted.entries).toEqual([mine.id])
    expect(res.body.deleted.clients).toEqual([])

    // A's entry is still live for A.
    const aList = await a.get(`/api/entries?from=${FROM}&to=${TO}`)
    expect(aList.body.map((e: any) => e.id)).toContain(A.entry.id)
    // B's is gone for B.
    const bList = await b.get(`/api/entries?from=${FROM}&to=${TO}`)
    expect(bList.body.map((e: any) => e.id)).not.toContain(mine.id)
  })

  it('billable touches only the caller own rows', async () => {
    const mine = await makeEntry(b, 'Bravo bulk billable', 12)
    const res = await b.post('/api/entries/bulk', {
      ids: [mine.id, A.entry.id],
      action: 'billable',
      billable: false
    })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ count: 1 })

    const aList = await a.get(`/api/entries?from=${FROM}&to=${TO}`)
    expect(aList.body.find((e: any) => e.id === A.entry.id).billable).toBe(true)
    const bList = await b.get(`/api/entries?from=${FROM}&to=${TO}`)
    expect(bList.body.find((e: any) => e.id === mine.id).billable).toBe(false)
  })

  it('restore touches only the caller own rows', async () => {
    const mine = await makeEntry(b, 'Bravo bulk restore', 13)
    await b.del(`/api/entries/${mine.id}`)
    const aVictim = await makeEntry(a, 'Alpha trashed', 13)
    await a.del(`/api/entries/${aVictim.id}`)

    const res = await b.post('/api/entries/bulk', {
      ids: [mine.id, aVictim.id],
      action: 'restore'
    })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ count: 1 })

    const bList = await b.get(`/api/entries?from=${FROM}&to=${TO}`)
    expect(bList.body.map((e: any) => e.id)).toContain(mine.id)
    // A's stayed in the trash — B could not resurrect it.
    const aList = await a.get(`/api/entries?from=${FROM}&to=${TO}`)
    expect(aList.body.map((e: any) => e.id)).not.toContain(aVictim.id)
  })

  it('reassign touches only the caller own rows and validates the ref against the caller org', async () => {
    const mine = await makeEntry(b, 'Bravo bulk reassign', 14)

    // A foreign ref is rejected outright — nothing is written at all.
    const foreignRef = await b.post('/api/entries/bulk', {
      ids: [mine.id],
      action: 'reassign',
      refType: 'project',
      refId: A.project.id
    })
    expect(foreignRef.status).toBe(400)
    expect(foreignRef.body.message).toMatch(/unknown project/i)
    let bList = await b.get(`/api/entries?from=${FROM}&to=${TO}`)
    expect(bList.body.find((e: any) => e.id === mine.id).ref).toBeNull()

    // A legitimate ref + a foreign id in the same call: only B's row moves.
    const ok = await b.post('/api/entries/bulk', {
      ids: [mine.id, A.entry.id],
      action: 'reassign',
      refType: 'project',
      refId: B.project.id
    })
    expect(ok.status).toBe(200)
    expect(ok.body).toHaveLength(1)
    expect(ok.body[0].id).toBe(mine.id)
    expect(ok.body[0].ref).toMatchObject({ refType: 'project', refId: B.project.id })

    const aList = await a.get(`/api/entries?from=${FROM}&to=${TO}`)
    expect(aList.body.find((e: any) => e.id === A.entry.id).ref).toMatchObject({
      refType: 'task',
      refId: A.task.id
    })

    // refType null clears the reference (and still only for the caller).
    const cleared = await b.post('/api/entries/bulk', {
      ids: [mine.id, A.entry.id],
      action: 'reassign',
      refType: null,
      refId: null
    })
    expect(cleared.status).toBe(200)
    expect(cleared.body).toHaveLength(1)
    expect(cleared.body[0].ref).toBeNull()
  })
})

describe('POST /api/restore with a foreign snapshot', () => {
  it('restores nothing and leaves A rows trashed', async () => {
    const victim = await makeEntry(a, 'Alpha restore victim', 15)
    const del = await a.del(`/api/entries/${victim.id}`)
    expect(del.status).toBe(200)
    expect(del.body.deleted.entries).toEqual([victim.id])

    // B replays A's undo snapshot verbatim.
    const res = await b.post('/api/restore', { deleted: del.body.deleted })
    expect(res.status).toBe(200)
    expect(res.body.restored).toEqual({
      clients: 0,
      projects: 0,
      tasks: 0,
      entries: 0,
      tags: 0
    })

    const aList = await a.get(`/api/entries?from=${FROM}&to=${TO}`)
    expect(aList.body.map((e: any) => e.id)).not.toContain(victim.id)

    // A's own undo still works.
    const undo = await a.post('/api/restore', { deleted: del.body.deleted })
    expect(undo.body.restored.entries).toBe(1)
    const back = await a.get(`/api/entries?from=${FROM}&to=${TO}`)
    expect(back.body.map((e: any) => e.id)).toContain(victim.id)
  })

  it('cannot replay a foreign cascade snapshot (deleted ids AND relink edges)', async () => {
    // A cascade-deletes a client, keeping its project (which gets detached).
    const client = (await a.post('/api/clients', { name: 'Alpha Cascade', rate: 50 })).body
    const project = (
      await a.post('/api/projects', { name: 'Alpha Cascade Project', clientId: client.id })
    ).body
    const del = await a.del(`/api/clients/${client.id}`, {
      cascadeProjects: false,
      cascadeTasks: false,
      cascadeEntries: false
    })
    expect(del.status).toBe(200)
    expect(del.body.deleted.clients).toEqual([client.id])
    expect(del.body.relinked.projects).toEqual([{ id: project.id, clientId: client.id }])

    const hijack = await b.post('/api/restore', {
      deleted: del.body.deleted,
      relinked: del.body.relinked
    })
    expect(hijack.status).toBe(200)
    expect(hijack.body.restored).toEqual({
      clients: 0,
      projects: 0,
      tasks: 0,
      entries: 0,
      tags: 0
    })

    // Still trashed, still detached.
    const aClients = await a.get('/api/clients')
    expect(aClients.body.map((c: any) => c.id)).not.toContain(client.id)
    const aProjects = await a.get('/api/projects')
    expect(aProjects.body.find((p: any) => p.id === project.id).clientId).toBeNull()

    // A's own undo re-links.
    const undo = await a.post('/api/restore', {
      deleted: del.body.deleted,
      relinked: del.body.relinked
    })
    expect(undo.body.restored.clients).toBe(1)
    const relinked = await a.get('/api/projects')
    expect(relinked.body.find((p: any) => p.id === project.id).clientId).toBe(client.id)
  })
})

describe('timer isolation', () => {
  it("B cannot see, edit or stop A's running timers — not even by id", async () => {
    const first = await a.post('/api/timers', { name: 'Alpha running' })
    const second = await a.post('/api/timers', { name: 'Alpha running too' })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    try {
      // B's own list never leaks A's rows.
      const bTimers = await b.get('/api/timers')
      expect(bTimers.status).toBe(200)
      expect(bTimers.body).toEqual([])

      // Naming A's ids gets the same generic 404 as an id that exists nowhere,
      // so B cannot use the message to learn that A's id is real.
      const unknown = await b.patch(`/api/timers/${RANDOM_UUID}`, { name: 'pwned' })
      expect(unknown.status).toBe(404)
      for (const id of [first.body.entryId, second.body.entryId]) {
        const patched = await b.patch(`/api/timers/${id}`, { name: 'pwned' })
        expect(patched.status).toBe(404)
        expect(patched.body.message).toBe(unknown.body.message)
        expect(patched.body.message).toBe('No timer running.')

        const stopped = await b.post(`/api/timers/${id}/stop`)
        expect(stopped.status).toBe(404)
        expect(stopped.body.message).toBe(unknown.body.message)
      }

      // A's timers are untouched and still named as A left them.
      const aTimers = await a.get('/api/timers')
      expect(aTimers.status).toBe(200)
      expect([...aTimers.body.map((t: any) => t.name)].sort()).toEqual([
        'Alpha running',
        'Alpha running too'
      ])

      // The cap is per user, not global: B starts its own regardless of A's.
      const bStart = await b.post('/api/timers', { name: 'Bravo running' })
      expect(bStart.status).toBe(200)
      await b.post(`/api/timers/${bStart.body.entryId}/stop`)
    } finally {
      await stopAllTimers(a)
      await stopAllTimers(b)
    }
  })
})

describe('reporting and export are org-scoped', () => {
  it('summaries, reports and CSV never aggregate the other org', async () => {
    const report = await b.get(`/api/summary/reports?from=${FROM}&to=${TO}&groupBy=project`)
    expect(report.status).toBe(200)
    const labels = report.body.groups.map((g: any) => g.label)
    expect(labels).not.toContain('Alpha Project')

    const csv = await b.get(`/api/export/csv?from=${FROM}&to=${TO}`)
    expect(csv.status).toBe(200)
    expect(csv.text).not.toContain('Alpha Entry')
    expect(csv.text).not.toContain('Alpha Project')

    const dash = await b.get('/api/summary/dashboard')
    expect(dash.status).toBe(200)
  })
})

describe('same org, different user', () => {
  it('a member reads the org catalog but cannot mutate another user entries', async () => {
    const email = uniqueEmail('member')
    const invite = await a.post('/api/invites', { email, role: 'member' })
    expect(invite.status).toBe(200)
    expect(invite.body.token).toBeTruthy()

    const member = await registerAccount(MAIN_URL, {
      name: 'Mallory Member',
      email,
      inviteToken: invite.body.token
    })
    expect(member.user.orgId).toBe(A.acct.user.orgId)
    expect(member.user.role).toBe('member')
    const m = member.client

    // Catalog is org-wide: the member sees A's client.
    const clients = await m.get('/api/clients')
    expect(clients.body.map((c: any) => c.id)).toContain(A.client.id)

    // Entries are user-scoped: A's rows are invisible and immutable.
    const list = await m.get(`/api/entries?from=${FROM}&to=${TO}`)
    expect(list.body.map((e: any) => e.id)).not.toContain(A.entry.id)
    expect((await m.patch(`/api/entries/${A.entry.id}`, { name: 'pwned' })).status).toBe(404)
    expect((await m.del(`/api/entries/${A.entry.id}`)).status).toBe(404)

    const bulk = await m.post('/api/entries/bulk', {
      ids: [A.entry.id],
      action: 'delete'
    })
    expect(bulk.status).toBe(200)
    expect(bulk.body.deleted.entries).toEqual([])

    // Role gates hold on the server for a plain member.
    expect((await m.patch('/api/org', { name: 'Member Renamed' })).status).toBe(403)
    expect((await m.post('/api/invites', { email: uniqueEmail(), role: 'member' })).status).toBe(403)

    // A's entry survived all of it.
    const after = await a.get(`/api/entries?from=${FROM}&to=${TO}`)
    expect(after.body.find((e: any) => e.id === A.entry.id).name).toBe('Alpha Entry')
  })
})

describe('unauthenticated access', () => {
  it('every guarded route answers 401 without a session', async () => {
    const anon = new ApiClient(MAIN_URL)
    const routes: [string, string][] = [
      ['GET', '/api/clients'],
      ['GET', '/api/projects'],
      ['GET', '/api/tasks'],
      ['GET', '/api/tags'],
      ['GET', `/api/entries?from=${FROM}&to=${TO}`],
      ['GET', '/api/timers'],
      ['GET', '/api/org'],
      ['GET', '/api/trash'],
      ['GET', '/api/summary/dashboard'],
      ['GET', `/api/summary/reports?from=${FROM}&to=${TO}`],
      ['GET', `/api/export/csv?from=${FROM}&to=${TO}`],
      ['GET', `/api/export/pdf?from=${FROM}&to=${TO}`]
    ]
    for (const [method, path] of routes) {
      const res = await anon.request(method, path)
      expect(`${method} ${path} -> ${res.status}`).toBe(`${method} ${path} -> 401`)
    }

    // Mutations too — including the ones that carry an id.
    expect((await anon.post('/api/timers', {})).status).toBe(401)
    expect((await anon.patch(`/api/timers/${RANDOM_UUID}`, { name: 'x' })).status).toBe(401)
    expect((await anon.post(`/api/timers/${RANDOM_UUID}/stop`)).status).toBe(401)
    expect((await anon.patch(`/api/entries/${A.entry.id}`, { name: 'x' })).status).toBe(401)
    expect((await anon.del(`/api/entries/${A.entry.id}`)).status).toBe(401)
    expect(
      (await anon.post('/api/entries/bulk', { ids: [A.entry.id], action: 'delete' })).status
    ).toBe(401)
    expect((await anon.post('/api/restore', { deleted: { entries: [A.entry.id] } })).status).toBe(401)
  })
})
