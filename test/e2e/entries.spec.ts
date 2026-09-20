// /time: manual entry with a free-text date, inline edit, delete + undo toast,
// and a bulk "Move to…" reassign.
import { expect, test } from './helpers/test'
import { createEntry, stopAllTimers, deleteEntriesNamed } from './helpers/api'
import { bulkActionsBar, entryRow, group, picker } from './helpers/dom'
import { SEED, startsWith, uniqueName } from './helpers/fixtures'

/** Every name this file creates, so afterEach can sweep them all. */
const created = new Set<string>()

function name(prefix: string): string {
  const n = uniqueName(prefix)
  created.add(n)
  return n
}

/** A fixed early-morning slot `daysAgo` days back — never collides with the seed. */
function slot(daysAgo: number, hour: number, minutes = 30) {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, hour, 0)
  return { start: start.toISOString(), end: new Date(start.getTime() + minutes * 60_000).toISOString() }
}

test.beforeEach(async ({ api }) => {
  await stopAllTimers(api)
})

test.afterEach(async ({ api }) => {
  await deleteEntriesNamed(api, ...created)
  created.clear()
})

test('a manual entry dated "yesterday" lands in the Yesterday group', async ({ page }) => {
  const entryName = name('E2E manual')
  await page.goto('/time')

  await page.getByRole('button', { name: 'Manual entry' }).click()
  const dialog = page.getByRole('dialog').filter({
    has: page.getByRole('heading', { name: 'Manual entry' })
  })
  await expect(dialog).toBeVisible()

  await dialog.getByLabel('What did you work on?').fill(entryName)
  await dialog.getByLabel('Date — type it any way').fill('yesterday')
  await dialog.getByLabel('Start', { exact: true }).fill('9:00')
  await dialog.getByLabel('End', { exact: true }).fill('10:30')
  // The interpretation line proves the free-text date parsed before we save.
  await expect(dialog.getByText(/9:00am – 10:30am · 1h 30m/)).toBeVisible()

  await dialog.getByRole('button', { name: 'Add entry' }).click()
  await expect(dialog).toBeHidden()

  await expect(entryRow(group(page, 'Yesterday'), entryName)).toBeVisible()
  await expect(entryRow(group(page, 'Yesterday'), entryName)).toContainText('9:00am – 10:30am')
  await expect(entryRow(group(page, 'Today'), entryName)).toHaveCount(0)
})

test('editing an entry updates its row', async ({ page, api }) => {
  const before = name('E2E edit before')
  const after = name('E2E edit after')
  await createEntry(api, { name: before, billable: true, ...slot(0, 3) })

  await page.goto('/time')
  const today = group(page, 'Today')
  await expect(entryRow(today, before)).toBeVisible()

  // Clicking the row's name opens the dialog in edit mode.
  await entryRow(today, before).getByRole('button', { name: before, exact: true }).click()
  const dialog = page.getByRole('dialog').filter({
    has: page.getByRole('heading', { name: 'Edit entry' })
  })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('What did you work on?')).toHaveValue(before)

  await dialog.getByLabel('What did you work on?').fill(after)
  await dialog.getByLabel('End', { exact: true }).fill('4:00')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()

  await expect(entryRow(today, after)).toBeVisible()
  await expect(entryRow(today, after)).toContainText('3:00am – 4:00am')
  await expect(entryRow(today, before)).toHaveCount(0)
})

test('deleting an entry shows the undo toast and undo restores the row', async ({ page, api }) => {
  const entryName = name('E2E undo')
  await createEntry(api, { name: entryName, billable: true, ...slot(0, 4) })

  await page.goto('/time')
  const today = group(page, 'Today')
  const row = entryRow(today, entryName)
  await expect(row).toBeVisible()

  await row.getByRole('button', { name: 'Delete entry' }).click()
  await expect(row).toHaveCount(0)

  // Rule 4: undo toast with a visible countdown.
  await expect(page.getByText(`Deleted “${entryName}”`, { exact: true })).toBeVisible()
  await expect(page.getByText(/^Undo within \d+s$/)).toBeVisible()

  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(entryRow(today, entryName)).toBeVisible()
})

test('the edit dialog\'s Delete removes the entry and shows the undo toast', async ({ page, api }) => {
  const entryName = name('E2E dialog delete')
  await createEntry(api, { name: entryName, billable: true, ...slot(0, 10) })

  await page.goto('/time')
  const today = group(page, 'Today')
  const row = entryRow(today, entryName)
  await expect(row).toBeVisible()

  await row.getByRole('button', { name: entryName, exact: true }).click()
  const dialog = page.getByRole('dialog').filter({
    has: page.getByRole('heading', { name: 'Edit entry' })
  })
  await expect(dialog).toBeVisible()

  // Same delete flow as the row's own Delete button: the dialog just closes
  // and routes the actual removal + undo toast through the Time page.
  await dialog.getByRole('button', { name: 'Delete entry' }).click()
  await expect(dialog).toBeHidden()
  await expect(entryRow(today, entryName)).toHaveCount(0)

  await expect(page.getByText(`Deleted “${entryName}”`, { exact: true })).toBeVisible()
  await expect(page.getByText(/^Undo within \d+s$/)).toBeVisible()

  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(entryRow(today, entryName)).toBeVisible()
})

test('deleting the sole selected row via its own Delete button restores focus to a neighbour', async ({ page, api }) => {
  // Selecting exactly this row, then deleting it, flips hasSelection back to
  // false from under a row that isn't the selection bar — the page's
  // neighbour-focus restore must win the race against the (unrelated)
  // hasSelection watcher, which would otherwise steal focus to the top row.
  const early = name('E2E focus early')
  const middle = name('E2E focus middle')
  const late = name('E2E focus late')
  await createEntry(api, { name: early, billable: true, ...slot(0, 5) })
  await createEntry(api, { name: middle, billable: true, ...slot(0, 6) })
  await createEntry(api, { name: late, billable: true, ...slot(0, 7) })

  await page.goto('/time')
  const today = group(page, 'Today')
  const middleRow = entryRow(today, middle)
  await expect(middleRow).toBeVisible()

  await middleRow.getByRole('checkbox', { name: 'Select entry' }).click()
  await middleRow.getByRole('button', { name: 'Delete entry' }).click()
  await expect(middleRow).toHaveCount(0)

  // "early" is the next row after "middle" in start-time-descending order —
  // the correct neighbour, not "late" (the top of the whole list).
  await expect(entryRow(today, early).getByRole('button', { name: early, exact: true })).toBeFocused()
})

test('bulk selecting two rows and "Move to…" reassigns both', async ({ page, api }) => {
  const first = name('E2E bulk one')
  const second = name('E2E bulk two')
  await createEntry(api, { name: first, billable: true, ...slot(0, 5) })
  await createEntry(api, { name: second, billable: true, ...slot(0, 6) })

  await page.goto('/time')
  const today = group(page, 'Today')
  await entryRow(today, first).getByRole('checkbox', { name: 'Select entry' }).click()
  await entryRow(today, second).getByRole('checkbox', { name: 'Select entry' }).click()
  // Scoped to the bar: time.vue also keeps an always-mounted live region
  // with the same text, so an unscoped getByText matches both.
  await expect(bulkActionsBar(page).getByText('2 selected')).toBeVisible()

  await page.getByRole('button', { name: 'Move to…' }).click()
  await expect(picker(page)).toBeVisible()
  await picker(page).getByRole('combobox').fill(SEED.projectBrand.name)
  await picker(page).getByRole('option', { name: startsWith(SEED.projectBrand.name) }).click()
  await expect(picker(page)).toBeHidden()
  await expect(page.getByText(`2 entries moved to ${SEED.projectBrand.name}`, { exact: true })).toBeVisible()

  for (const row of [entryRow(today, first), entryRow(today, second)]) {
    await expect(row).toContainText(SEED.projectBrand.name)
    await expect(row).toContainText(SEED.projectBrand.client)
  }
})

test('desktop (≥1024px): the bulk-action bar stays in-flow above the list, unchanged by the mobile bar/order fix', async ({ page, api }) => {
  // mobile.spec.ts's "tab order" test covers <1024px, where a second copy of
  // TimeSelectionBar now renders after the groups (lg:hidden) so Tab order
  // is rows → bar there. This is the other side of that same change: the
  // desktop copy (max-lg:hidden) must still be the in-flow, non-fixed bar
  // sitting above the rows that it always was.
  const entryName = name('E2E desktop bar position')
  await createEntry(api, { name: entryName, billable: true, ...slot(0, 8) })

  await page.goto('/time')
  const today = group(page, 'Today')
  await entryRow(today, entryName).getByRole('checkbox', { name: 'Select entry' }).click()

  const bar = bulkActionsBar(page)
  await expect(bar).toBeVisible()
  expect(await bar.evaluate(el => getComputedStyle(el).position)).toBe('static')

  const [barBox, rowBox] = await Promise.all([bar.boundingBox(), entryRow(today, entryName).boundingBox()])
  expect(barBox).not.toBeNull()
  expect(rowBox).not.toBeNull()
  // Above the row, not overlapping it — i.e. still part of the normal flow.
  expect(barBox!.y + barBox!.height).toBeLessThanOrEqual(rowBox!.y)
})
