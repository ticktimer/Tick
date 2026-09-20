/**
 * Integration-test harness: builds the app once into an isolated output dir,
 * boots real Nitro servers against the TEST database, and hands tests a
 * cookie-jar fetch client.
 *
 * Hard rules baked in here:
 *  - Every server started through `startServer()` is pinned to the TEST
 *    database (`tick_test`). The dev database is never reachable from a test.
 *  - The build lives in `.nuxt/it/` (gitignored) so it never overwrites the
 *    `.nuxt/` + `.output/` the running dev server owns.
 *  - Ports are explicit per suite (3801 shared, 3802 rate-limit, 3803 demo,
 *    3805 session-cookie, 3806 boot probes; 3804 belongs to e2e).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import http from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from '../../server/db/schema'

export const TEST_DATABASE_URL
  = 'postgresql://tick:tick_dev_password@localhost:5432/tick_test'

export const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
export const OUTPUT_DIR = resolve(ROOT, '.nuxt/it/output')
const SERVER_ENTRY = resolve(OUTPUT_DIR, 'server/index.mjs')

/** Ports owned by this suite. */
export const PORT_MAIN = 3801
export const PORT_RATE_LIMIT = 3802
export const PORT_DEMO = 3803
export const PORT_SESSION_COOKIE = 3805
/** Boot-behaviour probes (migrate-boot.test.ts) — servers expected to die. */
export const PORT_MIGRATE = 3806

/** The long-lived server booted by the vitest globalSetup. */
export const MAIN_URL = `http://127.0.0.1:${PORT_MAIN}`

/** Fixed so sealed session cookies survive across servers in one run. */
const SESSION_PASSWORD = 'tick-integration-tests-session-password-0123456789'

/* ------------------------------------------------------------------ build */

/** Sources whose mtime decides whether the cached build is stale. */
const SOURCE_PATHS = ['server', 'shared', 'app', 'nuxt.config.ts', 'package.json']

function newestMtime(path: string): number {
  let newest = 0
  const stack = [path]
  while (stack.length) {
    const p = stack.pop()!
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      for (const entry of readdirSync(p)) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue
        stack.push(resolve(p, entry))
      }
    } else if (st.mtimeMs > newest) {
      newest = st.mtimeMs
    }
  }
  return newest
}

/**
 * Builds `.nuxt/it/output`. The build is cached between runs and reused only
 * while it is newer than every app/server/shared source — a stale build would
 * quietly test yesterday's code. TICK_IT_REBUILD=1 forces a rebuild.
 */
export async function buildOnce(): Promise<void> {
  if (existsSync(SERVER_ENTRY) && process.env.TICK_IT_REBUILD !== '1') {
    const builtAt = statSync(SERVER_ENTRY).mtimeMs
    const newestSource = Math.max(
      ...SOURCE_PATHS.map(p => newestMtime(resolve(ROOT, p)))
    )
    if (builtAt >= newestSource) return
    console.log('[it] sources changed since the last build — rebuilding')
  }
  await new Promise<void>((res, rej) => {
    const child = spawn(
      process.execPath,
      [resolve(ROOT, 'test/integration/build-app.mjs')],
      {
        cwd: ROOT,
        stdio: 'inherit',
        env: { ...process.env, NUXT_DATABASE_URL: TEST_DATABASE_URL }
      }
    )
    child.on('error', rej)
    child.on('exit', code =>
      code === 0 ? res() : rej(new Error(`build-app.mjs exited with ${code}`))
    )
  })
}

/* ----------------------------------------------------------------- server */

export interface TestServer {
  url: string
  port: number
  close: () => Promise<void>
}

export interface StartServerOptions {
  port: number
  /** Extra env for the child. NUXT_DATABASE_URL is always forced to the TEST db. */
  env?: Record<string, string>
  /** cwd for the child (demo mode writes its `.data/` marker there). */
  cwd?: string
  /** Seconds to wait for the port to answer. */
  timeoutMs?: number
}

export async function startServer(opts: StartServerOptions): Promise<TestServer> {
  await buildOnce()
  const url = `http://127.0.0.1:${opts.port}`
  const logs: string[] = []

  // A server leaked by an earlier interrupted or misassessed run would let this
  // one silently attach to someone else's process instead of its own child.
  try {
    const probe = await fetch(`${url}/api/me`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(300)
    })
    if (probe.status > 0) {
      throw new Error(`port ${opts.port} already in use (stale server from a previous run?)`)
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('port ')) throw err
    // Nothing answered — the port is free, as expected.
  }

  // Strip any inherited value so a developer's shell can't flip the default
  // test. Don't blank it: an empty value aborts startup (server/plugins/00.session-cookie.ts).
  const { NUXT_SESSION_COOKIE_SECURE: _s, NITRO_SESSION_COOKIE_SECURE: _n, ...inherited } = process.env

  const child: ChildProcess = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: opts.cwd ?? ROOT,
    env: {
      ...inherited,
      NODE_ENV: 'production',
      NITRO_HOST: '127.0.0.1',
      NITRO_PORT: String(opts.port),
      PORT: String(opts.port),
      // Never the dev database. Set last so nothing can override it.
      NUXT_SESSION_PASSWORD: SESSION_PASSWORD,
      NUXT_AUTO_MIGRATE: 'false',
      NUXT_AUTH_RATE_LIMIT: '0',
      NUXT_DEMO_MODE: '',
      NUXT_PUBLIC_DEMO_MODE: '',
      ...opts.env,
      NUXT_DATABASE_URL: TEST_DATABASE_URL
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout?.on('data', (d: Buffer) => logs.push(d.toString()))
  child.stderr?.on('data', (d: Buffer) => logs.push(d.toString()))

  let exited = false
  child.on('exit', () => (exited = true))

  const deadline = Date.now() + (opts.timeoutMs ?? 60_000)
  for (;;) {
    if (exited) {
      throw new Error(`server on ${opts.port} exited early:\n${logs.join('')}`)
    }
    try {
      const res = await fetch(`${url}/api/me`, { redirect: 'manual' })
      // 401 = Nitro is up and the auth guard answered. Anything parseable works.
      if (res.status > 0) break
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`server on ${opts.port} never came up:\n${logs.join('')}`)
      }
      await sleep(200)
    }
  }

  return {
    url,
    port: opts.port,
    close: () =>
      new Promise<void>((res) => {
        if (exited || child.exitCode !== null) return res()
        child.once('exit', () => res())
        child.kill('SIGTERM')
        setTimeout(() => {
          if (!exited) child.kill('SIGKILL')
        }, 4000).unref()
      })
  }
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/* ------------------------------------------------------------- api client */

export interface ApiResponse<T = any> {
  status: number
  headers: Headers
  /** Parsed JSON when the response is JSON, else null. */
  body: T
  text: string
  bytes: Uint8Array
}

/** Cookie-jar fetch client — one instance == one browser session. */
export class ApiClient {
  readonly baseUrl: string
  private jar = new Map<string, string>()

  constructor(baseUrl: string = MAIN_URL) {
    this.baseUrl = baseUrl
  }

  get cookieNames(): string[] {
    return [...this.jar.keys()]
  }

  hasCookie(name: string): boolean {
    return this.jar.has(name)
  }

  clearCookies(): void {
    this.jar.clear()
  }

  async request<T = any>(
    method: string,
    path: string,
    body?: unknown,
    init: RequestInit = {}
  ): Promise<ApiResponse<T>> {
    const headers = new Headers(init.headers)
    if (this.jar.size) {
      headers.set(
        'cookie',
        [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
      )
    }
    let payload: string | undefined
    if (body !== undefined) {
      payload = JSON.stringify(body)
      headers.set('content-type', 'application/json')
      headers.set('content-length', String(Buffer.byteLength(payload)))
    }
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      method,
      headers,
      body: payload,
      redirect: 'manual'
    })
    this.absorbCookies(res)

    const bytes = new Uint8Array(await res.arrayBuffer())
    const isBinary = (res.headers.get('content-type') ?? '').includes('pdf')
    const text = isBinary ? '' : Buffer.from(bytes).toString('utf8')
    let parsed: unknown = null
    if (!isBinary && text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = null
      }
    }
    return { status: res.status, headers: res.headers, body: parsed as T, text, bytes }
  }

  private absorbCookies(res: Response): void {
    const raw
      = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : ([res.headers.get('set-cookie')].filter(Boolean) as string[])
    for (const line of raw) {
      const [pair, ...attrs] = line.split(';')
      const idx = pair!.indexOf('=')
      if (idx < 0) continue
      const name = pair!.slice(0, idx).trim()
      const value = pair!.slice(idx + 1).trim()
      const expired = attrs.some((a) => {
        const s = a.trim().toLowerCase()
        if (s.startsWith('max-age=')) return Number(s.slice(8)) <= 0
        if (s.startsWith('expires=')) return Date.parse(s.slice(8)) <= Date.now()
        return false
      })
      if (expired || value === '') this.jar.delete(name)
      else this.jar.set(name, value)
    }
  }

  get<T = any>(path: string) {
    return this.request<T>('GET', path)
  }

  post<T = any>(path: string, body?: unknown) {
    return this.request<T>('POST', path, body ?? {})
  }

  patch<T = any>(path: string, body?: unknown) {
    return this.request<T>('PATCH', path, body ?? {})
  }

  del<T = any>(path: string, body?: unknown) {
    return this.request<T>('DELETE', path, body ?? {})
  }
}

/* ------------------------------------------------------------- fixtures */

export interface TestAccount {
  client: ApiClient
  user: SessionUserLike
  email: string
  password: string
  name: string
  /** The raw register response, so callers can inspect its Set-Cookie lines. */
  response: ApiResponse<SessionUserLike>
}

export interface SessionUserLike {
  id: string
  name: string
  email: string
  defaultRate: number | null
  orgId: string
  orgName: string
  role: 'owner' | 'admin' | 'member'
}

export function uniqueEmail(prefix = 'it'): string {
  return `${prefix}-${randomUUID()}@tick.test`
}

/**
 * Registers a brand-new user + org and returns a logged-in client.
 * Every test file uses its own accounts, so files share no mutable state and
 * can run in any order (and alongside data other suites left behind).
 */
export async function registerAccount(
  baseUrl: string = MAIN_URL,
  opts: { name?: string, email?: string, password?: string, inviteToken?: string } = {}
): Promise<TestAccount> {
  const client = new ApiClient(baseUrl)
  const email = opts.email ?? uniqueEmail()
  const password = opts.password ?? 'integration-pass-1'
  const name = opts.name ?? 'Ivy Tester'
  const res = await client.post<SessionUserLike>('/api/auth/register', {
    name,
    email,
    password,
    ...(opts.inviteToken ? { inviteToken: opts.inviteToken } : {})
  })
  if (res.status !== 200) {
    throw new Error(`register failed (${res.status}): ${res.text}`)
  }
  return { client, user: res.body, email, password, name, response: res }
}

/**
 * Stops every timer this client has running, oldest first, and trashes the
 * entries they persisted.
 *
 * Cleanup blocks used to blind-fire `POST /api/timer/stop` because a user
 * could only ever have one running row; with several (Tick#37) there is no
 * such single target, so ask the server which ids are live and stop each.
 *
 * The old blind stop left nothing behind: a lone timer stopped microseconds
 * after it started was always under a second, so the server discarded it.
 * These tests hold timers across `sleep(1100)` and start up to the cap, so a
 * sweep now persists real ended entries — up to ten of them. Left in place
 * they would be invisible today (no test counts entries after a cleanup) and
 * a flake tomorrow, so the sweep removes what it created, the way its e2e
 * twin in `test/e2e/helpers/api.ts` already does. Safe (and silent) when
 * nothing is running.
 */
export async function stopAllTimers(api: ApiClient): Promise<void> {
  const res = await api.get<{ entryId: string }[]>('/api/timers')
  if (res.status !== 200 || !Array.isArray(res.body)) return
  for (const timer of res.body) {
    const stopped = await api.post<{ id: string } | null>(`/api/timers/${timer.entryId}/stop`)
    // null = under a second, discarded server-side; nothing to clean up.
    if (stopped.status !== 200 || !stopped.body?.id) continue
    await api.del(`/api/entries/${stopped.body.id}`)
  }
}

/** A second, independent session for an existing account. */
export async function loginAs(
  email: string,
  password: string,
  baseUrl: string = MAIN_URL
): Promise<ApiClient> {
  const client = new ApiClient(baseUrl)
  const res = await client.post('/api/auth/login', { email, password })
  if (res.status !== 200) throw new Error(`login failed (${res.status}): ${res.text}`)
  return client
}

/* --------------------------------------------------------------- test db */

let sql: ReturnType<typeof postgres> | null = null
let db: PostgresJsDatabase<typeof schema> | null = null

/** Drizzle handle on the TEST database (read-only use in assertions/fixtures). */
export function testDb(): PostgresJsDatabase<typeof schema> {
  if (!db) {
    sql = postgres(TEST_DATABASE_URL, { max: 4 })
    db = drizzle(sql, { schema })
  }
  return db
}

export async function closeTestDb(): Promise<void> {
  await sql?.end({ timeout: 5 })
  sql = null
  db = null
}

export { schema }

/* --------------------------------------------- raw http with a source IP */

export interface RawResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  text: string
}

/**
 * A request issued from a specific loopback source address. The auth rate
 * limiter buckets on the socket's remote address, so this is how a test proves
 * the window is per-IP without waiting on anything shared.
 */
export function requestFromIp(opts: {
  port: number
  path: string
  method?: string
  body?: unknown
  localAddress: string
}): Promise<RawResponse> {
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body)
  return new Promise((res, rej) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: opts.port,
        path: opts.path,
        method: opts.method ?? 'POST',
        localAddress: opts.localAddress,
        headers: payload
          ? {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload)
            }
          : {}
      },
      (r) => {
        const chunks: Buffer[] = []
        r.on('data', c => chunks.push(c as Buffer))
        r.on('end', () =>
          res({
            status: r.statusCode ?? 0,
            headers: r.headers,
            text: Buffer.concat(chunks).toString('utf8')
          })
        )
      }
    )
    req.on('error', rej)
    if (payload) req.write(payload)
    req.end()
  })
}
