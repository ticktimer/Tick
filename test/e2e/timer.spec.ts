// Timer bar: describe → start → clock ticks → attach a project through the
// picker → stop → the entry is at the top of Today on /time with its chain
// and resolved rate. Plus ticktimer/Tick#37: two timers at once, both ticking,
// stopping one by id leaves the other running.
import type { Page } from '@playwright/test'
import { expect, test } from './helpers/test'
import type { DeleteResult } from '../../shared/types'
import {
  stopAllTimers,
  createEntry,
  deleteEntriesNamed,
  deleteEntry,
  listEntries,
  listTimers,
  restoreDeleted,
  todayRange
} from './helpers/api'
import {
  addTimerButton,
  cancelTimerButton,
  group,
  picker,
  rows,
  entryRow,
  timerChain,
  timerClock,
  timerCount,
  timerInput,
  timerList,
  timerListRow,
  timerListSelect,
  timerPlus,
  timerRowClock,
  timerToggle
} from './helpers/dom'
import { SEED, SEED_USER, startsWith, uniqueName } from './helpers/fixtures'

const NAME = uniqueName('E2E timer run')
const SECOND = uniqueName('E2E timer second')

/** Seeded rows parked in the trash for the duration of the test. */
const parked: DeleteResult[] = []

/** Extra names a single test creates; swept in afterEach alongside the two above. */
const created = new Set<string>()

function name(prefix: string): string {
  const n = uniqueName(prefix)
  created.add(n)
  return n
}

/** A fixed early-morning slot today — never collides with the seeded rows. */
function slot(hour: number, minutes = 30) {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0)
  return { start: start.toISOString(), end: new Date(start.getTime() + minutes * 60_000).toISOString() }
}

/** The collection endpoint itself — not `/api/timers/:id/...`. */
const isTimerList = (url: URL) => url.pathname === '/api/timers'

/**
 * Counts the store's collection re-reads (GET /api/timers) whose status
 * `accept`s, from the moment this is called.
 *
 * Why on the wire rather than on screen: reka-ui marks the whole page
 * `aria-hidden` while a dialog is open, so every role-based locator in
 * helpers/dom.ts goes blind to the timer bar as soon as the picker opens — a
 * "did the bar change?" gate would read 0 for the wrong reason and pass
 * vacuously. `hydrate()` is the only caller of this endpoint and it assigns
 * the store in that same fetch's continuation, so a counted response means the
 * state behind the dialog has already moved.
 */
function countListReloads(page: Page, accept: (status: number) => boolean): () => number {
  let n = 0
  page.on('response', (res) => {
    if (res.request().method() !== 'GET') return
    if (new URL(res.url()).pathname !== '/api/timers') return
    if (accept(res.status())) n++
  })
  return () => n
}

/**
 * Provoke the refocus re-hydrate until `landed()` says it did.
 *
 * `hydrateIfStale()` debounces to once per 5s, so a single dispatched focus
 * right after mount does nothing. Polling the dispatch (rather than sleeping
 * past the window) keeps this deterministic AND keeps the test honest: every
 * assertion afterwards runs only once the hydrate has demonstrably happened,
 * so none of them can pass merely because nothing ever fired.
 */
async function hydrateOnRefocus(page: Page, landed: () => boolean): Promise<void> {
  await expect.poll(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    return landed()
  }, { timeout: 20_000 }).toBe(true)
}

test.beforeEach(async ({ api }) => {
  await stopAllTimers(api)
  // The seed writes today's three entries at fixed clock times (9:05, 11:30,
  // 13:00). Whether a timer stopped "now" sorts above them therefore depends
  // on the hour of the run — so park them in the trash and restore them after,
  // which makes "at the top of Today" a claim about the app, not the clock.
  for (const e of await listEntries(api, todayRange())) {
    const result = await deleteEntry(api, e.id)
    if (result) parked.push(result)
  }
})

test.afterEach(async ({ api }) => {
  await stopAllTimers(api)
  await deleteEntriesNamed(api, NAME, SECOND, ...created)
  created.clear()
  while (parked.length) await restoreDeleted(api, parked.pop()!)
})

test('starts, ticks, attaches a project, stops into the top of Today', async ({ page }) => {
  await page.goto('/time')

  // ── Describe + start ─────────────────────────────────────────────────────
  await timerInput(page).fill(NAME)
  await expect(timerToggle(page)).toHaveAccessibleName('Start')
  await timerToggle(page).click()
  await expect(timerToggle(page)).toHaveAccessibleName('Stop')

  // ── The clock ticks (polled, never a fixed sleep) ─────────────────────────
  await expect(timerClock(page)).toHaveText(/^00:00:0[2-9]$/, { timeout: 15_000 })

  // ── Attach a project through the picker ──────────────────────────────────
  await timerPlus(page).click()
  await page.getByRole('menuitem', { name: 'Project' }).click()
  await expect(picker(page)).toBeVisible()
  await picker(page).getByRole('combobox').fill(SEED.projectNoRate.name)
  await picker(page).getByRole('option', { name: startsWith(SEED.projectNoRate.name) }).click()
  await expect(picker(page)).toBeHidden()
  await expect(timerChain(page)).toHaveText(`${SEED.projectNoRate.name} · ${SEED.projectNoRate.client}`)

  // ── Stop ─────────────────────────────────────────────────────────────────
  await timerToggle(page).click()
  await page.waitForURL('**/time')
  await expect(timerToggle(page)).toHaveAccessibleName('Start')

  // ── The stopped entry tops the Today group, chain and rate intact ────────
  const today = group(page, 'Today')
  await expect(rows(today).first()).toContainText(NAME)
  const row = entryRow(today, NAME)
  await expect(row).toContainText(SEED.projectNoRate.name)
  await expect(row).toContainText(SEED.projectNoRate.client)
  // Rule 2: nothing overrides, so the rate resolves to the user default.
  await expect(
    row.getByRole('button', { name: `Billable at $${SEED_USER.defaultRate}/h` })
  ).toBeVisible()
})

// ── ticktimer/Tick#37 ───────────────────────────────────────────────────────
test('two timers run at once; stopping one by id leaves the other running', async ({ page, api }) => {
  await page.goto('/time')

  // ── First timer ──────────────────────────────────────────────────────────
  await timerInput(page).fill(NAME)
  await timerToggle(page).click()
  await expect(timerToggle(page)).toHaveAccessibleName('Stop')
  // The count chip is the disclosure for the running list; it appears with the
  // first timer, not the second.
  await expect(timerCount(page)).toHaveText(/1\s*running/)

  // ── "Add a timer" hands the bar to the draft without stopping anything ────
  await addTimerButton(page).click()
  // The slot is now the way out — a ✕ labelled "Cancel new timer".
  await expect(cancelTimerButton(page)).toBeVisible()
  await expect(timerToggle(page)).toHaveAccessibleName('Start')
  expect((await listTimers(api)).map(t => t.name)).toEqual([NAME])

  await timerInput(page).fill(SECOND)
  await timerToggle(page).click()
  await expect(timerToggle(page)).toHaveAccessibleName('Stop')
  await expect(addTimerButton(page)).toBeVisible()
  await expect(timerCount(page)).toHaveText(/2\s*running/)

  // Server truth: two rows with end IS NULL, ordered start ASC.
  await expect.poll(async () => (await listTimers(api)).map(t => t.name)).toEqual([NAME, SECOND])

  // ── The list opened on its own when the first timer left the bar, and both
  //    clocks tick off the one shared now ──────────────────────────────────────
  await expect(timerCount(page)).toHaveAttribute('aria-expanded', 'true')
  await expect(timerList(page)).toBeVisible()

  const firstRow = timerListRow(page, NAME)
  const secondRow = timerListRow(page, SECOND)
  await expect(firstRow).toBeVisible()
  await expect(secondRow).toBeVisible()
  // The row the bar is showing is marked, not moved: the newest is active and
  // it is still the second row.
  await expect(secondRow).toHaveAttribute('aria-current', 'true')

  for (const row of [firstRow, secondRow]) {
    const before = await timerRowClock(row).innerText()
    await expect.poll(() => timerRowClock(row).innerText(), { timeout: 15_000 }).not.toBe(before)
  }

  // ── Stop the FIRST one from the list; the second keeps running ────────────
  await firstRow.getByRole('button', { name: `Stop ${NAME}`, exact: true }).click()
  await expect(firstRow).toHaveCount(0)
  await expect(secondRow).toBeVisible()
  await expect(timerCount(page)).toHaveText(/1\s*running/)
  // The bar still belongs to the survivor — no navigation, no stop-all.
  await expect(timerToggle(page)).toHaveAccessibleName('Stop')
  await expect(timerInput(page)).toHaveValue(SECOND)

  await expect.poll(async () => (await listTimers(api)).map(t => t.name)).toEqual([SECOND])

  // The stopped one landed in Today like any other entry.
  await expect(entryRow(group(page, 'Today'), NAME)).toBeVisible()
})

test('"Add a timer" composes an empty draft and opens the list — nothing starts', async ({ page, api }) => {
  await page.goto('/time')

  await timerInput(page).fill(NAME)
  await timerToggle(page).click()
  await expect(timerToggle(page)).toHaveAccessibleName('Stop')
  await expect(timerCount(page)).toHaveAttribute('aria-expanded', 'false')

  await addTimerButton(page).click()

  // The bar is now the draft, honestly: blank, 00:00:00, a play button, and
  // the cursor already in the field. The clock used to keep counting the
  // timer that had just left the bar — dimmed, under a play button — which
  // read as "a new timer started by itself at 00:00:07".
  await expect(timerInput(page)).toHaveValue('')
  await expect(timerInput(page)).toBeFocused()
  await expect(timerClock(page)).toHaveText('00:00:00')
  await expect(timerToggle(page)).toHaveAccessibleName('Start')

  // …and the running timer did not vanish: the list opened with it in.
  await expect(timerCount(page)).toHaveAttribute('aria-expanded', 'true')
  await expect(timerListRow(page, NAME)).toBeVisible()
  await expect(timerRowClock(timerListRow(page, NAME))).not.toHaveText('00:00:00')

  // Nothing started server-side.
  expect((await listTimers(api)).map(t => t.name)).toEqual([NAME])

  // ✕ hands the bar back to the running timer…
  await timerInput(page).fill('half a thought')
  await cancelTimerButton(page).click()
  await expect(addTimerButton(page)).toBeVisible()
  await expect(timerInput(page)).toHaveValue(NAME)
  await expect(timerToggle(page)).toHaveAccessibleName('Stop')
  await expect(timerClock(page)).not.toHaveText('00:00:00')

  // …and cancel means discard: the next "Add a timer" is blank, not "half a
  // thought" waiting to surprise you. Esc in the field is the same cancel.
  await addTimerButton(page).click()
  await expect(timerInput(page)).toHaveValue('')
  await timerInput(page).fill('another')
  await timerInput(page).press('Escape')
  await expect(addTimerButton(page)).toBeVisible()
  await expect(timerInput(page)).toHaveValue(NAME)
  expect((await listTimers(api)).map(t => t.name)).toEqual([NAME])
})

test('▶ on an entry while a timer runs adds a second one and opens the list', async ({ page, api }) => {
  const again = name('E2E timer again')
  await createEntry(api, { name: again, billable: true, ...slot(6) })
  await page.goto('/time')

  await timerInput(page).fill(NAME)
  await timerToggle(page).click()
  await expect(timerToggle(page)).toHaveAccessibleName('Stop')
  await expect(timerCount(page)).toHaveAttribute('aria-expanded', 'false')

  // Start again from the row. This used to stop the running timer first; now
  // it adds one — and since that bumps NAME out of the bar, the list opens so
  // it is still on screen.
  await entryRow(group(page, 'Today'), again).getByRole('button', { name: 'Start again' }).click()

  await expect(timerCount(page)).toHaveText(/2\s*running/)
  await expect(timerCount(page)).toHaveAttribute('aria-expanded', 'true')
  await expect(timerListRow(page, NAME)).toBeVisible()
  await expect(timerListRow(page, again)).toBeVisible()
  await expect(timerListRow(page, again)).toHaveAttribute('aria-current', 'true')
  await expect(timerInput(page)).toHaveValue(again)

  await expect.poll(async () => (await listTimers(api)).map(t => t.name)).toEqual([NAME, again])
})

test('clicking anywhere outside the running list closes it', async ({ page }) => {
  await page.goto('/time')

  await timerInput(page).fill(NAME)
  await timerToggle(page).click()
  await expect(timerToggle(page)).toHaveAccessibleName('Stop')

  await timerCount(page).click()
  await expect(timerList(page)).toBeVisible()

  // Inside the region — a row, the chip's neighbours — is not outside: the
  // list stays. (The chip itself toggles, which is its own behaviour.)
  await timerListRow(page, NAME).click()
  await expect(timerList(page)).toBeVisible()

  // The page below is.
  await page.getByRole('heading', { name: 'Time', exact: true }).click()
  await expect(timerList(page)).toBeHidden()
  await expect(timerCount(page)).toHaveAttribute('aria-expanded', 'false')

  // A pick made with the list open does not close it under you: the picker
  // is a dialog, and dialogs are ignored.
  await timerCount(page).click()
  await expect(timerList(page)).toBeVisible()
  await timerPlus(page).click()
  await page.getByRole('menuitem', { name: 'Project' }).click()
  await expect(picker(page)).toBeVisible()
  await picker(page).getByRole('combobox').fill(SEED.projectNoRate.name)
  await picker(page).getByRole('option', { name: startsWith(SEED.projectNoRate.name) }).click()
  await expect(picker(page)).toBeHidden()
  await expect(timerList(page)).toBeVisible()
})

test('a timer you start takes the bar; one started elsewhere leaves your selection alone', async ({ page, api }) => {
  const elsewhere = name('E2E timer elsewhere')
  await page.goto('/time')

  await timerInput(page).fill(NAME)
  await timerToggle(page).click()
  await expect(timerToggle(page)).toHaveAccessibleName('Stop')

  await timerCount(page).click()
  await timerListSelect(page, NAME).click()
  await expect(timerListRow(page, NAME)).toHaveAttribute('aria-current', 'true')

  // ── A start made here is deliberate: it takes the bar and the selection ──
  await addTimerButton(page).click()
  await timerInput(page).fill(SECOND)
  await timerToggle(page).click()
  await expect.poll(async () => (await listTimers(api)).map(t => t.name)).toEqual([NAME, SECOND])

  await expect(timerInput(page)).toHaveValue(SECOND)
  await expect(timerListRow(page, SECOND)).toHaveAttribute('aria-current', 'true')
  await expect(timerListRow(page, NAME)).not.toHaveAttribute('aria-current', 'true')

  // Tapping a row hands the bar to it.
  await timerListSelect(page, NAME).click()
  await expect(timerInput(page)).toHaveValue(NAME)
  await expect(timerListRow(page, NAME)).toHaveAttribute('aria-current', 'true')

  // ── A start made ELSEWHERE (another tab, a phone) arrives through the
  //    refocus re-hydrate. It goes to the list; the bar stays where you put it.
  const reloads = countListReloads(page, s => s === 200)
  const res = await api.post('/api/timers', { data: { name: elsewhere } })
  expect(res.ok(), `POST /api/timers → ${res.status()}`).toBe(true)
  await hydrateOnRefocus(page, () => reloads() > 0)

  await expect(timerCount(page)).toHaveText(/3\s*running/)
  await expect(timerListRow(page, elsewhere)).toBeVisible()
  await expect(timerInput(page)).toHaveValue(NAME)
  await expect(timerListRow(page, NAME)).toHaveAttribute('aria-current', 'true')
  await expect(timerListRow(page, elsewhere)).not.toHaveAttribute('aria-current', 'true')
})

// ── Regressions found reviewing #37 ─────────────────────────────────────────

test('“start again” on a ref-less entry does not inherit the composer draft’s project', async ({ page, api }) => {
  const bare = name('E2E bare entry')
  await createEntry(api, { name: bare, billable: true, ...slot(4) })

  await page.goto('/time')

  // Attach a project to the COMPOSER. Nothing is running, so this ref lives
  // only on the client draft — it has never been near a timer.
  await timerPlus(page).click()
  await page.getByRole('menuitem', { name: 'Project' }).click()
  await expect(picker(page)).toBeVisible()
  await picker(page).getByRole('combobox').fill(SEED.projectNoRate.name)
  await picker(page).getByRole('option', { name: startsWith(SEED.projectNoRate.name) }).click()
  await expect(timerChain(page)).toHaveText(`${SEED.projectNoRate.name} · ${SEED.projectNoRate.client}`)

  // Start again on an entry that carries no client, project or task.
  await entryRow(group(page, 'Today'), bare).getByRole('button', { name: 'Start again' }).click()

  // It starts with the entry's own chain — which is none. The draft's project
  // must not be merged in behind the user's back: that is mis-attributed and
  // potentially mis-billed time.
  await expect.poll(async () => (await listTimers(api)).length).toBe(1)
  const [running] = await listTimers(api)
  expect(running!.name).toBe(bare)
  expect(running!.ref).toBeNull()
})

test('a failed re-hydrate leaves the running timers and the pin alone', async ({ page }) => {
  await page.goto('/time')

  await timerInput(page).fill(NAME)
  await timerToggle(page).click()
  await expect(timerToggle(page)).toHaveAccessibleName('Stop')

  await timerCount(page).click()
  await timerListSelect(page, NAME).click()
  await expect(timerListRow(page, NAME)).toHaveAttribute('aria-current', 'true')
  expect(await page.evaluate(() => localStorage.getItem('tick-timer-pinned'))).not.toBeNull()

  // Every collection GET now fails at the network level — a Wi-Fi blip, not an
  // answer from the server. Other methods still go through.
  let refused = 0
  await page.route(isTimerList, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    refused++
    return route.abort('connectionfailed')
  })

  try {
    await hydrateOnRefocus(page, () => refused > 0)

    // The blip changed nothing. The clocks used to blank — recoverable — and
    // the pin reconciliation used to read that empty list as "the pinned timer
    // is gone" and delete tick-timer-pinned from disk, which never recovered.
    await expect(timerCount(page)).toHaveText(/1\s*running/)
    await expect(timerListRow(page, NAME)).toBeVisible()
    await expect(timerListRow(page, NAME)).toHaveAttribute('aria-current', 'true')
    expect(await page.evaluate(() => localStorage.getItem('tick-timer-pinned'))).not.toBeNull()

    // …and the shared interval is still running.
    const row = timerListRow(page, NAME)
    const before = await timerRowClock(row).innerText()
    await expect.poll(() => timerRowClock(row).innerText(), { timeout: 15_000 }).not.toBe(before)
  } finally {
    await page.unroute(isTimerList)
  }
})

test('a PATCH that re-adds a drifted timer restarts its clock', async ({ page }) => {
  await page.goto('/time')

  await timerInput(page).fill(NAME)
  await timerToggle(page).click()
  await expect(timerToggle(page)).toHaveAccessibleName('Stop')

  // Open the picker while it runs: the dialog captures this timer's id.
  await timerPlus(page).click()
  await page.getByRole('menuitem', { name: 'Project' }).click()
  await expect(picker(page)).toBeVisible()

  // Now the collection GET answers 401 — the one failure that really does mean
  // "nothing is running" — so the client drops the timer and stops the shared
  // interval. The row is still running server-side, which is why the PATCH
  // below succeeds.
  const refused = countListReloads(page, status => status === 401)
  await page.route(isTimerList, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    return route.fulfill({ status: 401, contentType: 'application/json', body: '{"message":"Unauthorized"}' })
  })

  try {
    await hydrateOnRefocus(page, () => refused() > 0)

    // Picking PATCHes the captured id. The 200 puts the timer back in the list
    // — and the clock has to start moving again with it, rather than sitting
    // frozen wherever the last tick left `nowMs`.
    await picker(page).getByRole('combobox').fill(SEED.projectNoRate.name)
    await picker(page).getByRole('option', { name: startsWith(SEED.projectNoRate.name) }).click()
    await expect(picker(page)).toBeHidden()

    await expect(timerToggle(page)).toHaveAccessibleName('Stop')
    const before = await timerClock(page).innerText()
    await expect.poll(() => timerClock(page).innerText(), { timeout: 15_000 }).not.toBe(before)
  } finally {
    await page.unroute(isTimerList)
  }
})

test('a pick lands on the draft even when a timer arrives while the picker is open', async ({ page, api }) => {
  await page.goto('/time')

  // Nothing is running, so the bar is the composer and the picker's target is
  // "the draft" — decided now, as the dialog opens.
  await timerPlus(page).click()
  await page.getByRole('menuitem', { name: 'Project' }).click()
  await expect(picker(page)).toBeVisible()

  // Meanwhile a timer starts on another device.
  const elsewhere = name('E2E other device')
  const started = await api.post('/api/timers', { data: { name: elsewhere } })
  expect(started.ok(), `POST /api/timers → ${started.status()}`).toBe(true)

  // The app picks it up behind the open dialog. Counting only re-reads that
  // happen after the POST above, so a success here means the store now holds a
  // running timer — and with `timers` non-empty and nobody having pressed "add
  // a timer", `composing` is false by construction. That is the state the bug
  // needed: a target worked out now would resolve to this timer.
  const reloaded = countListReloads(page, status => status === 200)
  await hydrateOnRefocus(page, () => reloaded() > 0)

  await picker(page).getByRole('combobox').fill(SEED.projectNoRate.name)
  await picker(page).getByRole('option', { name: startsWith(SEED.projectNoRate.name) }).click()
  await expect(picker(page)).toBeHidden()

  // The ref went where the user was pointing it. The timer that turned up
  // mid-dialog is untouched.
  const running = await listTimers(api)
  expect(running.map(t => t.name)).toEqual([elsewhere])
  expect(running[0]!.ref).toBeNull()

  // …and it really did reach the draft: the composer still carries it.
  await addTimerButton(page).click()
  await expect(timerChain(page)).toHaveText(`${SEED.projectNoRate.name} · ${SEED.projectNoRate.client}`)
})

test('picking onto a timer stopped meanwhile re-syncs instead of failing silently', async ({ page, api }) => {
  await page.goto('/time')

  await timerInput(page).fill(NAME)
  await timerToggle(page).click()
  await expect(timerToggle(page)).toHaveAccessibleName('Stop')

  // The dialog captures this timer's id…
  await timerPlus(page).click()
  await page.getByRole('menuitem', { name: 'Project' }).click()
  await expect(picker(page)).toBeVisible()

  // …and then it is stopped elsewhere, so the pick's PATCH will 404.
  await stopAllTimers(api)

  await picker(page).getByRole('combobox').fill(SEED.projectNoRate.name)
  await picker(page).getByRole('option', { name: startsWith(SEED.projectNoRate.name) }).click()
  await expect(picker(page)).toBeHidden()

  // The 404 is handled like every other 4xx here: re-sync and let the server
  // win. It used to be an unhandled rejection that left the bar sitting on a
  // timer which had already ended.
  await expect(timerToggle(page)).toHaveAccessibleName('Start')
  await expect(timerCount(page)).toHaveCount(0)
})
