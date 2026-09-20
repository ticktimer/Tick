// ticktimer/Tick#7 — the server and the browser must agree on the clock.
//
// A self-hosted container runs in UTC; the user does not. Every display helper
// used to read a Date's *local* fields, so SSR spelled times, day labels and day
// groupings in the container's zone and the browser re-rendered them in its own
// — Vue reported hydration mismatches on /, /time and /calendar, and near
// midnight an entry could be filed under the wrong day in the server HTML.
//
// One host serves both sides here, so the browser context is put several hours
// off it instead. Two things are asserted, and the second is the one that
// matters: no mismatch warnings, AND the *server-rendered HTML itself* carries
// the browser's times — a page that only looked right after hydration would
// still be flashing the wrong day at every visitor.
import { expect, test } from './helpers/test'
import { stopAllTimers, createEntry, deleteEntriesNamed } from './helpers/api'
import { uniqueName } from './helpers/fixtures'

const HOST_OFFSET_H = -new Date().getTimezoneOffset() / 60
/** Five hours off the host, whichever direction keeps us inside Etc/GMT±. */
const SHIFTED_H = HOST_OFFSET_H - 5 >= -12 ? Math.trunc(HOST_OFFSET_H) - 5 : Math.trunc(HOST_OFFSET_H) + 5
// Etc/GMT signs are inverted: Etc/GMT+7 is UTC-7.
const SHIFTED_TZ = `Etc/GMT${SHIFTED_H <= 0 ? '+' : '-'}${Math.abs(SHIFTED_H)}`

const ENTRY = uniqueName('TZ entry')

/** Today at `hour` host-local — mid-afternoon, so ±5h stays the same date. */
function todaySlot(hour: number) {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0)
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour + 1, 0)
  return { start: start.toISOString(), end: end.toISOString() }
}

/** "3:00pm" for `iso` as the clock reads in `tz` — the app's own time format. */
function timeIn(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).formatToParts(new Date(iso))
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  return `${get('hour')}:${get('minute')}${get('dayPeriod').toLowerCase()}`
}

const SLOT = todaySlot(14)

test.describe('browser timezone differs from the server', () => {
  test.use({ timezoneId: SHIFTED_TZ })

  test.beforeEach(async ({ api }) => {
    await stopAllTimers(api)
    await deleteEntriesNamed(api, ENTRY)
    await createEntry(api, { name: ENTRY, billable: true, ...SLOT })
  })

  test.afterEach(async ({ api }) => {
    await deleteEntriesNamed(api, ENTRY)
  })

  test('the dashboard, time and calendar pages hydrate without mismatches', async ({ page }) => {
    const warnings: string[] = []
    page.on('console', (m) => {
      if (/Hydration/i.test(m.text())) warnings.push(m.text())
    })

    // A cold browser has no timezone cookie yet: SSR falls back to its own zone
    // and ships that in the payload, so the hydration render still agrees.
    for (const path of ['/', '/time', '/calendar']) {
      await page.goto(path)
      await expect(page.locator('#__nuxt')).toBeVisible()
    }
    expect(warnings, `hydration warnings:\n${warnings.join('\n')}`).toEqual([])

    // And again now that the cookie is set — this time SSR renders in the
    // browser's zone, which is the path every visit after the first takes.
    for (const path of ['/', '/time', '/calendar']) {
      await page.goto(path)
      await expect(page.locator('#__nuxt')).toBeVisible()
    }
    expect(warnings, `hydration warnings:\n${warnings.join('\n')}`).toEqual([])
  })

  test('the server renders times in the browser timezone, not its own', async ({ page }) => {
    const expected = timeIn(SLOT.start, SHIFTED_TZ)
    const hostRendered = timeIn(SLOT.start, Intl.DateTimeFormat().resolvedOptions().timeZone)
    // Guard the guard: a five-hour shift must actually change the printed time,
    // or this test would pass without proving anything.
    expect(expected).not.toBe(hostRendered)

    // First visit sets the cookie; the second is server-rendered with it.
    await page.goto('/time')
    const res = await page.goto('/time')
    const html = (await res!.text()) ?? ''

    // Look only at this entry's own row: the seeded fixture has entries at other
    // times, and one of those can legitimately print the host-zone string.
    // Booleans rather than toContain(), because the page is ~400KB and a raw
    // failure would print all of it.
    const at = html.indexOf(ENTRY)
    expect(at, `${ENTRY} is missing from the server HTML`).toBeGreaterThan(-1)
    const row = html.slice(Math.max(0, at - 1200), at + 1200)
    expect(row.includes(expected), `the row should print ${expected} (browser zone)`).toBe(true)
    expect(row.includes(hostRendered), `the row must not print ${hostRendered} (host zone)`).toBe(false)
    await expect(page.getByRole('button', { name: new RegExp(ENTRY) }).first()).toBeVisible()
  })
})
