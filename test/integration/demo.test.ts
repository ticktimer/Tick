/**
 * Demo mode (docs/content/4.reference/3.env.md — NUXT_DEMO_MODE).
 *
 * Runs a throwaway server on :3803 with NUXT_DEMO_MODE=true. That server
 * WIPES AND RESEEDS the "Hollow Studio" org on boot, which is exactly why it
 * is pointed at the TEST database and nothing else. Its `.data/` reset marker
 * lives in a fresh temp dir so the boot reset is guaranteed to run.
 *
 * Asserted: the boot reseed happens, the documented destructive routes answer
 * 403, and every read (plus soft deletes and the timer) still works.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  ApiClient,
  closeTestDb,
  loginAs,
  PORT_DEMO,
  registerAccount,
  schema,
  sleep,
  startServer,
  testDb,
  uniqueEmail,
  type ApiClient as Client,
  type TestServer
} from '../helpers/server'

const DEMO_URL = `http://127.0.0.1:${PORT_DEMO}`
const DEMO_EMAIL = 'mara@example.com'
const DEMO_ORG = 'Hollow Studio'
const SOME_UUID = '00000000-0000-4000-8000-000000000000'

let server: TestServer
let dataDir: string
let api: Client
let account: Awaited<ReturnType<typeof registerAccount>>

async function findMara() {
  return testDb().query.users.findFirst({
    columns: { id: true },
    where: eq(schema.users.email, DEMO_EMAIL)
  })
}

beforeAll(async () => {
  const db = testDb()
  // Remove the demo dataset first so its reappearance proves the boot reset ran.
  await db.delete(schema.orgs).where(eq(schema.orgs.name, DEMO_ORG))
  await db.delete(schema.users).where(eq(schema.users.email, DEMO_EMAIL))
  expect(await findMara()).toBeUndefined()

  dataDir = await mkdtemp(join(tmpdir(), 'tick-it-demo-'))
  server = await startServer({
    port: PORT_DEMO,
    cwd: dataDir,
    env: { NUXT_DEMO_MODE: 'true', NUXT_PUBLIC_DEMO_MODE: 'true' }
  })

  // The reset plugin kicks off at boot without blocking the listener.
  const deadline = Date.now() + 60_000
  while (!(await findMara())) {
    if (Date.now() > deadline) throw new Error('demo reset never reseeded the demo org')
    await sleep(250)
  }

  account = await registerAccount(DEMO_URL, { name: 'Demo Visitor' })
  api = account.client
}, 180_000)

afterAll(async () => {
  await server?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
  await closeTestDb()
})

describe('boot reset', () => {
  it('reseeds the demo org and its login still works', async () => {
    const mara = await findMara()
    expect(mara).toBeTruthy()

    const org = await testDb().query.orgs.findFirst({
      where: eq(schema.orgs.name, DEMO_ORG)
    })
    expect(org).toBeTruthy()

    const demoSession = await loginAs(DEMO_EMAIL, 'tick-demo', DEMO_URL)
    const me = await demoSession.get('/api/me')
    expect(me.status).toBe(200)
    expect(me.body.orgName).toBe(DEMO_ORG)

    // Three weeks of seeded history is readable.
    const clients = await demoSession.get('/api/clients')
    expect(clients.status).toBe(200)
    expect(clients.body.map((c: any) => c.name).sort()).toEqual([
      'Acme Co',
      'Northwind Legal',
      'Playtone'
    ])
  })
})

describe('guarded destructive routes answer 403', () => {
  const cases: [string, string, unknown?][] = [
    ['PATCH', '/api/me/password', { currentPassword: 'x'.repeat(10), newPassword: 'y'.repeat(10) }],
    ['PATCH', '/api/org', { name: 'Renamed In Demo' }],
    ['POST', '/api/invites', { email: 'someone@example.com', role: 'member' }],
    ['DELETE', `/api/invites/${SOME_UUID}`, {}],
    ['DELETE', `/api/org/members/${SOME_UUID}`, {}],
    ['POST', '/api/import/commit', { source: 'generic', csv: 'name,start,end\n' }],
    ['POST', '/api/trash/purge', { all: true }]
  ]

  for (const [method, path, body] of cases) {
    it(`${method} ${path}`, async () => {
      const res = await api.request(method, path, body)
      expect(`${method} ${path} -> ${res.status}`).toBe(`${method} ${path} -> 403`)
      expect(res.body.statusMessage ?? res.body.message).toMatch(/demo/i)
    })
  }

  it('leaves the org name untouched after a blocked rename', async () => {
    const org = await api.get('/api/org')
    expect(org.status).toBe(200)
    expect(org.body.name).not.toBe('Renamed In Demo')
  })
})

describe('reads and non-destructive writes still work', () => {
  it('every read endpoint answers normally', async () => {
    const from = new Date(2026, 6, 1).toISOString()
    const to = new Date(2026, 6, 8).toISOString()
    const routes: [string, string][] = [
      ['GET', '/api/me'],
      ['GET', '/api/org'],
      ['GET', '/api/org/members'],
      ['GET', '/api/clients'],
      ['GET', '/api/projects'],
      ['GET', '/api/tasks'],
      ['GET', '/api/tags'],
      ['GET', '/api/invites'],
      ['GET', '/api/trash'],
      ['GET', `/api/entries?from=${from}&to=${to}`],
      ['GET', '/api/summary/dashboard'],
      ['GET', `/api/summary/reports?from=${from}&to=${to}`],
      ['GET', `/api/export/csv?from=${from}&to=${to}`],
      ['GET', `/api/export/pdf?from=${from}&to=${to}`]
    ]
    for (const [method, path] of routes) {
      const res = await api.request(method, path)
      expect(`${method} ${path} -> ${res.status}`).toBe(`${method} ${path} -> 200`)
    }

    const timers = await api.get('/api/timers')
    expect(timers.status).toBe(200)
    expect(Array.isArray(timers.body)).toBe(true)
  })

  it('import PREVIEW stays open while commit is blocked', async () => {
    const csv = [
      'name,start,end,client,project,task,tags,billable',
      'Imported row,2026-07-02T09:00:00.000Z,2026-07-02T10:00:00.000Z,Demo Client,Demo Project,,,true'
    ].join('\n')

    const preview = await api.post('/api/import/preview', { source: 'generic', csv })
    expect(preview.status).toBe(200)
    expect(preview.body.entryCount).toBe(1)
    expect(preview.body.source).toBe('generic')

    const commit = await api.post('/api/import/commit', { source: 'generic', csv })
    expect(commit.status).toBe(403)

    // The preview really was a dry run — nothing was written.
    const clients = await api.get('/api/clients')
    expect(clients.body.map((c: any) => c.name)).not.toContain('Demo Client')
  })

  it('the timer and soft deletes (which the reset undoes) still work', async () => {
    const started = await api.post('/api/timers', { name: 'demo run' })
    expect(started.status).toBe(200)
    const stopped = await api.post(`/api/timers/${started.body.entryId}/stop`)
    expect([200, 204]).toContain(stopped.status)

    const entry = await api.post('/api/entries', {
      name: 'demo entry',
      start: new Date(2026, 6, 2, 9).toISOString(),
      end: new Date(2026, 6, 2, 10).toISOString()
    })
    expect(entry.status).toBe(200)

    const del = await api.del(`/api/entries/${entry.body.id}`)
    expect(del.status).toBe(200)
    expect(del.body.deleted.entries).toEqual([entry.body.id])

    const undo = await api.post('/api/restore', { deleted: del.body.deleted })
    expect(undo.body.restored.entries).toBe(1)
  })

  it('registration and login are not demo-guarded', async () => {
    const second = await registerAccount(DEMO_URL, { name: 'Another Visitor' })
    expect(second.user.role).toBe('owner')
    const relogin = await new ApiClient(DEMO_URL).post('/api/auth/login', {
      email: second.email,
      password: second.password
    })
    expect(relogin.status).toBe(200)

    const forgot = await new ApiClient(DEMO_URL).post('/api/auth/forgot', {
      email: uniqueEmail('nobody')
    })
    expect(forgot.status).toBe(200)
  })
})
