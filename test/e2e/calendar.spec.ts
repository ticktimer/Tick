// /calendar week grid: seeded blocks render, clicking a block edits it (and
// must NOT start tracking), the block's play button is the only thing that does.
import { expect, test } from './helpers/test'
import { stopAllTimers, createEntry, deleteEntriesNamed, listTimers } from './helpers/api'
import { timerInput, timerToggle } from './helpers/dom'
import { SEED, startsWith, uniqueName } from './helpers/fixtures'

/** Our own block: 3–5pm today, clear of the seeded 9:05/11:30/13:00 blocks. */
const BLOCK = uniqueName('E2E block')

/** Names this file starts through the UI, swept in afterEach alongside BLOCK. */
const running: string[] = []

function todaySlot(fromHour: number, toHour: number) {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), fromHour, 0)
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), toHour, 0)
  return { start: start.toISOString(), end: end.toISOString() }
}

/** A calendar block, addressed by the entry name it opens with. */
function block(page: import('@playwright/test').Page, name: string) {
  return page.getByRole('button', { name: startsWith(name) }).first()
}

test.beforeEach(async ({ api }) => {
  await stopAllTimers(api)
  await deleteEntriesNamed(api, BLOCK)
  await createEntry(api, { name: BLOCK, billable: true, ...todaySlot(15, 17) })
})

test.afterEach(async ({ api }) => {
  await stopAllTimers(api)
  await deleteEntriesNamed(api, BLOCK, ...running)
  running.length = 0
})

test('the week grid renders the seeded blocks', async ({ page }) => {
  await page.goto('/calendar')
  await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible()

  // Today's three seeded entries always exist (server/utils/demo.ts).
  for (const name of SEED.todayEntries) {
    await expect(block(page, name)).toBeVisible()
  }
  await expect(block(page, BLOCK)).toBeVisible()
  // The block carries its own range + duration, so it is placed on the grid,
  // not just listed.
  await expect(block(page, BLOCK)).toHaveAttribute('title', `${BLOCK} · 3:00pm – 5:00pm · 2h 00m`)
})

test('clicking a block opens the edit dialog without starting the timer', async ({ page, api }) => {
  await page.goto('/calendar')
  const target = block(page, BLOCK)
  await expect(target).toBeVisible()

  // Left edge, vertical middle — clear of the play button on the right.
  await target.click({ position: { x: 10, y: 30 } })

  const dialog = page.getByRole('dialog').filter({
    has: page.getByRole('heading', { name: 'Edit entry' })
  })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('What did you work on?')).toHaveValue(BLOCK)

  // The regression this guards: a bare block surface must never start
  // tracking. The server is the authority — nothing is running at all.
  expect(await listTimers(api)).toEqual([])

  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  // …and the timer bar behind the dialog is still idle.
  await expect(timerToggle(page)).toHaveAccessibleName('Start')
})

test('the block play button starts the timer for that entry', async ({ page, api }) => {
  await page.goto('/calendar')
  await expect(block(page, BLOCK)).toBeVisible()

  await page.getByRole('button', { name: `Start timer for ${BLOCK}` }).click()

  await expect(timerToggle(page)).toHaveAccessibleName('Stop')
  await expect(timerInput(page)).toHaveValue(BLOCK)
  // No edit dialog opened alongside it.
  await expect(page.getByRole('heading', { name: 'Edit entry' })).toHaveCount(0)

  // Exactly one timer, and it is this block's — the play button starts an
  // additional timer now (ticktimer/Tick#37), so "one" is a real claim.
  expect((await listTimers(api)).map(t => t.name)).toEqual([BLOCK])
})

test('the block play button starts a SECOND timer instead of replacing the first', async ({ page, api }) => {
  await page.goto('/calendar')
  await expect(block(page, BLOCK)).toBeVisible()

  // Something is already running before the block is played.
  const first = uniqueName('E2E calendar first')
  running.push(first)
  await timerInput(page).fill(first)
  await timerToggle(page).click()
  await expect(timerToggle(page)).toHaveAccessibleName('Stop')

  await page.getByRole('button', { name: `Start timer for ${BLOCK}` }).click()

  // Both run, in start order — the first was never stopped (Tick#37).
  await expect.poll(async () => (await listTimers(api)).map(t => t.name)).toEqual([first, BLOCK])
})

// ── ticktimer/Tick#29 ───────────────────────────────────────────────────────
// `anchor` is a *local* start-of-day, but a server render computes it in the
// server's timezone and it rides the Pinia payload into the browser. The grid's
// day columns are then derived from it locally, so what breaks is the anchor
// naming a different calendar day in the browser than it did on the server —
// which is what happens to every browser behind the server (deployed: a UTC
// container, and the user west of it). Day view shows that wrong day outright;
// week view re-derives its Monday from the anchor, so it only slips a whole
// week when the server's day is a Monday — which is how the bug was reported.
//
// One host runs both sides here, so the browser context is put an hour behind.
const HOST_OFFSET_H = -new Date().getTimezoneOffset() / 60
const SHIFTED_H = Math.trunc(HOST_OFFSET_H) - 1
// Etc/GMT signs are inverted: Etc/GMT+7 is UTC-7.
const SHIFTED_TZ = `Etc/GMT${SHIFTED_H <= 0 ? '+' : '-'}${Math.abs(SHIFTED_H)}`

test.describe('browser timezone differs from the server', () => {
  test.use({ timezoneId: SHIFTED_TZ })

  test('a server-rendered load anchors the grid on the browser\'s days', async ({ page }) => {
    // UTC-12 is the westmost zone, and in the host's first hour of the day the
    // block created above belongs to the browser's yesterday.
    test.skip(SHIFTED_H < -12, `no zone an hour behind UTC${HOST_OFFSET_H}`)
    test.skip(new Date().getHours() === 0, 'host and browser are on different days')

    // A Ctrl-R, i.e. the server-rendered path. A client-side visit builds the
    // store in the browser and was always fine.
    await page.goto('/calendar')
    await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible()
    await page.getByRole('button', { name: 'Day', exact: true }).click()
    await expect(block(page, BLOCK)).toBeVisible()

    await page.reload()
    await page.getByRole('button', { name: 'Day', exact: true }).click()
    await expect(block(page, BLOCK)).toBeVisible()
  })
})
