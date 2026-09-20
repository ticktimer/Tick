// Mobile shell (<1024px): bottom tab bar, docked timer card, picker as a
// bottom sheet. Runs in the `mobile` project only — 390×844 with touch.
import { expect, test } from './helpers/test'
import { stopAllTimers, createEntry, deleteEntriesNamed, listEntries } from './helpers/api'
import {
  addTimerButton,
  closeTimerListButton,
  bulkActionsBar,
  entryRow,
  group,
  picker,
  timerClock,
  timerCount,
  timerInput,
  timerList,
  timerListRow,
  timerPlus,
  timerToggle
} from './helpers/dom'
import { uniqueName } from './helpers/fixtures'

const VIEWPORT = { width: 390, height: 844 }
const TIMER_NAME = uniqueName('E2E mobile timer')

/** Every name a test in this file creates, so afterEach can sweep them all. */
const created = new Set<string>()

function name(prefix: string): string {
  const n = uniqueName(prefix)
  created.add(n)
  return n
}

/** A fixed early-morning slot today — never collides with the seed's 9:05/11:30/13:00 rows. */
function slot(hour: number, minutes = 30) {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0)
  return { start: start.toISOString(), end: new Date(start.getTime() + minutes * 60_000).toISOString() }
}

test.describe('mobile shell', { tag: '@mobile' }, () => {
  test.beforeEach(async ({ api }) => {
    await stopAllTimers(api)
  })

  test.afterEach(async ({ api }) => {
    await stopAllTimers(api)
    await deleteEntriesNamed(api, TIMER_NAME, ...created)
    created.clear()
  })

  test('the bottom tab bar navigates', async ({ page }) => {
    await page.goto('/')
    const tabs = page.getByRole('navigation', { name: 'Primary' })
    await expect(tabs).toBeVisible()

    await tabs.getByRole('link', { name: 'Time' }).click()
    await page.waitForURL('**/time')
    await expect(tabs.getByRole('link', { name: 'Time' })).toHaveAttribute('aria-current', 'page')

    await tabs.getByRole('link', { name: 'Calendar' }).click()
    await page.waitForURL('**/calendar')
    await expect(tabs.getByRole('link', { name: 'Calendar' })).toHaveAttribute('aria-current', 'page')

    await tabs.getByRole('link', { name: 'Dashboard' }).click()
    await page.waitForURL(url => new URL(url).pathname === '/')
  })

  test('the docked timer starts and stops', async ({ page }) => {
    await page.goto('/time')

    await timerInput(page).fill(TIMER_NAME)
    await expect(timerToggle(page)).toHaveAccessibleName('Start')
    await timerToggle(page).click()
    await expect(timerToggle(page)).toHaveAccessibleName('Stop')
    await expect(timerClock(page)).toHaveText(/^00:00:0[2-9]$/, { timeout: 15_000 })

    await timerToggle(page).click()
    await expect(timerToggle(page)).toHaveAccessibleName('Start')
    await page.waitForURL('**/time')
    await expect(entryRow(group(page, 'Today'), TIMER_NAME)).toBeVisible()
  })

  // ── ticktimer/Tick#37 ────────────────────────────────────────────────────
  // The layout reserves a fixed pb-[calc(150px+env(safe-area-inset-bottom))]
  // for the dock, so the running list has to float ABOVE the card rather than
  // add a row to it. If the card ever grows, the reserved padding stops
  // matching and the last entry row slides under the dock.
  test('the running list opens above the dock without changing its height', async ({ page }) => {
    await page.goto('/time')

    const dock = page.getByRole('region', { name: 'Timer' }).filter({ visible: true })
    const idle = await dock.boundingBox()
    expect(idle).not.toBeNull()

    await timerInput(page).fill(TIMER_NAME)
    await timerToggle(page).click()
    await expect(timerToggle(page)).toHaveAccessibleName('Stop')
    await expect(timerCount(page)).toBeVisible()

    // Row 2 gained a count chip and an "Add a timer" button — both shorter
    // than the "+" that already set that row's height.
    const withTimer = await dock.boundingBox()
    expect(Math.round(withTimer!.height)).toBe(Math.round(idle!.height))
    expect(Math.round(withTimer!.y)).toBe(Math.round(idle!.y))

    await timerCount(page).click()
    await expect(timerList(page)).toBeVisible()
    await expect(timerListRow(page, TIMER_NAME)).toBeVisible()

    const opened = await dock.boundingBox()
    expect(Math.round(opened!.height)).toBe(Math.round(idle!.height))
    expect(Math.round(opened!.y)).toBe(Math.round(idle!.y))

    // …and the list really is an overlay: its whole box sits above the card.
    // Polled, because it rises in on mount (tick-rise, 180ms).
    await expect.poll(async () => {
      const b = await timerList(page).boundingBox()
      return b ? Math.round(b.y + b.height) <= Math.round(opened!.y) : null
    }).toBe(true)
  })

  test('"Add a timer" starts a second one from the dock', async ({ page }) => {
    const second = name('E2E mobile second')
    await page.goto('/time')

    await timerInput(page).fill(TIMER_NAME)
    await timerToggle(page).click()
    await expect(timerToggle(page)).toHaveAccessibleName('Stop')

    // Row 2's layout: "+" sits beside the thing it attaches to, and "Add a
    // timer" holds the right corner.
    const plusBox = (await timerPlus(page).boundingBox())!
    const addBox = (await addTimerButton(page).boundingBox())!
    expect(addBox.x).toBeGreaterThan(plusBox.x)

    await addTimerButton(page).click()
    await expect(timerToggle(page)).toHaveAccessibleName('Start')
    await timerInput(page).fill(second)
    await timerToggle(page).click()
    await expect(timerToggle(page)).toHaveAccessibleName('Stop')

    // The list opened by itself when the first timer left the card…
    await expect(timerCount(page)).toHaveAttribute('aria-expanded', 'true')
    await expect(timerListRow(page, TIMER_NAME)).toBeVisible()
    await expect(timerListRow(page, second)).toBeVisible()

    // …and the overlay's own ✕ closes it, without reaching back down to the
    // chip that opened it. The chip reopens it.
    await closeTimerListButton(page).click()
    await expect(timerList(page)).toBeHidden()
    await expect(timerCount(page)).toHaveAttribute('aria-expanded', 'false')
    await timerCount(page).click()
    await expect(timerListRow(page, TIMER_NAME)).toBeVisible()

    // Stopping one from the list leaves the other running and stays put.
    await timerListRow(page, TIMER_NAME).getByRole('button', { name: `Stop ${TIMER_NAME}`, exact: true }).click()
    await expect(timerListRow(page, TIMER_NAME)).toHaveCount(0)
    await expect(timerListRow(page, second)).toBeVisible()
    await expect(timerToggle(page)).toHaveAccessibleName('Stop')
  })

  test('the picker opens as a bottom sheet', async ({ page }) => {
    await page.goto('/time')

    await timerPlus(page).click()
    await expect(picker(page)).toBeVisible()

    // Docked to the bottom edge, full width — the <640px sheet layout.
    // Polled, because the dialog animates in.
    await expect.poll(async () => {
      const b = await picker(page).boundingBox()
      return b && { x: Math.round(b.x), width: Math.round(b.width), bottom: Math.round(b.y + b.height) }
    }).toEqual({ x: 0, width: VIEWPORT.width, bottom: VIEWPORT.height })

    // It is the real picker: tabs and a searchable list.
    await expect(picker(page).getByRole('tab', { name: 'Task' })).toBeVisible()
    await picker(page).getByRole('combobox').fill('Homepage hero')
    await expect(picker(page).getByRole('option', { name: /^Homepage hero/ })).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(picker(page)).toBeHidden()
  })

  test('Select mode: bulk-mark two rows billable, then toggling off clears the selection', async ({ page, api }) => {
    const first = name('E2E mobile select one')
    const second = name('E2E mobile select two')
    await createEntry(api, { name: first, billable: false, ...slot(2) })
    await createEntry(api, { name: second, billable: false, ...slot(3) })

    await page.goto('/time')
    const today = group(page, 'Today')
    await expect(entryRow(today, first)).toBeVisible()

    // Off by default: no checkbox. Select/Done is a plain action button (its
    // changing label is the state cue, not aria-pressed — see time.vue).
    const selectBtn = page.getByRole('button', { name: 'Select', exact: true })
    await expect(selectBtn).toBeVisible()
    await expect(entryRow(today, first).getByRole('checkbox', { name: 'Select entry' })).toBeHidden()

    await selectBtn.click()
    const doneBtn = page.getByRole('button', { name: 'Done', exact: true })
    await expect(doneBtn).toBeVisible()

    await entryRow(today, first).getByRole('checkbox', { name: 'Select entry' }).click()
    await entryRow(today, second).getByRole('checkbox', { name: 'Select entry' }).click()
    // Scoped to the bar: time.vue also keeps an always-mounted live region
    // with the same text, so an unscoped getByText matches both.
    await expect(bulkActionsBar(page).getByText('2 selected')).toBeVisible()

    // Mobile rows show no billable indicator at all (that's the point — the
    // per-row $ toggle stays desktop-only); verify the bulk action landed
    // through the API instead, same as the bulk bar itself would confirm it.
    await page.getByRole('button', { name: 'Mark billable' }).click()
    await expect(bulkActionsBar(page)).toBeHidden()
    const afterBillable = await listEntries(api)
    for (const n of [first, second]) {
      expect(afterBillable.find(e => e.name === n)?.billable, `${n} billable after bulk mark`).toBe(true)
    }

    // Toggling off drops any selection and hides the checkboxes again.
    await entryRow(today, first).getByRole('checkbox', { name: 'Select entry' }).click()
    await expect(bulkActionsBar(page).getByText('1 selected')).toBeVisible()
    await doneBtn.click()
    await expect(selectBtn).toBeVisible()
    await expect(bulkActionsBar(page)).toBeHidden()
    await expect(entryRow(today, first).getByRole('checkbox', { name: 'Select entry' })).toBeHidden()
  })

  test('selection-count live region is always mounted, unlike the bar\'s own visual count', async ({ page, api }) => {
    const first = name('E2E mobile live region')
    await createEntry(api, { name: first, billable: false, ...slot(6) })

    await page.goto('/time')
    const today = group(page, 'Today')
    await expect(entryRow(today, first)).toBeVisible()

    // Present from page load — not only once the bar mounts, which is what
    // a <span role="status"> living inside the v-if'd bar would require,
    // and which meant the very first "n selected" was usually never
    // announced.
    const live = page.locator('[role="status"][aria-live="polite"].sr-only')
    await expect(live).toBeAttached()
    await expect(live).toHaveText('')

    await page.getByRole('button', { name: 'Select', exact: true }).click()
    await entryRow(today, first).getByRole('checkbox', { name: 'Select entry' }).click()
    await expect(live).toHaveText('1 selected')

    await entryRow(today, first).getByRole('checkbox', { name: 'Select entry' }).click()
    await expect(live).toHaveText('Selection cleared')
  })

  test('focus after a bulk action in Select mode lands on the Select/Done toggle, not an off-screen row', async ({ page, api }) => {
    // Enough rows to push well past the fold, same setup as the reachability
    // test above — the row selected sits well below the header.
    const names: string[] = []
    for (let i = 0; i < 20; i++) {
      const n = name(`E2E mobile focus ${i}`)
      names.push(n)
      await createEntry(api, { name: n, billable: false, ...slot(i) })
    }

    await page.goto('/time')
    const today = group(page, 'Today')
    await expect(entryRow(today, names[19]!)).toBeVisible()

    await page.getByRole('button', { name: 'Select', exact: true }).click()

    const lastRow = entryRow(today, names[0]!)
    await lastRow.scrollIntoViewIfNeeded()
    await lastRow.getByRole('checkbox', { name: 'Select entry' }).click()

    const bar = bulkActionsBar(page)
    await expect(bar).toBeVisible()
    await bar.getByRole('button', { name: 'Clear' }).click()
    await expect(bar).toBeHidden()

    // Landing on the header's Select/Done toggle (still reading "Done" —
    // Clear doesn't turn Select mode off) beats the first entry in the
    // whole list: that row sits off-screen after scrolling down to select
    // a row near the bottom, so a sighted keyboard user would lose their
    // focus ring entirely.
    const doneBtn = page.getByRole('button', { name: 'Done', exact: true })
    await expect(doneBtn).toBeFocused()
    await expect(doneBtn).toBeInViewport()
  })

  test('Select mode: tab order reaches the rows before the bulk-action bar (WCAG 2.4.3)', async ({ page, api }) => {
    // The bar sits at the BOTTOM of the screen (fixed, above the dock) but
    // must come AFTER every row in Tab order — issue #15's followup: it used
    // to render before the groups in the DOM on every breakpoint, so Tab
    // order was bar → rows while it visually sits below them.
    const names: string[] = []
    for (let i = 0; i < 20; i++) {
      const n = name(`E2E mobile order ${i}`)
      names.push(n)
      await createEntry(api, { name: n, billable: false, ...slot(i) })
    }

    await page.goto('/time')
    const today = group(page, 'Today')
    const topRow = entryRow(today, names[19]!) // hour 19 sorts newest → rendered first
    const bottomRow = entryRow(today, names[0]!) // hour 0 sorts oldest → rendered last
    await expect(topRow).toBeVisible()

    await page.getByRole('button', { name: 'Select', exact: true }).click()
    const doneBtn = page.getByRole('button', { name: 'Done', exact: true })

    // Show the bar (select the bottom row — also the row a not-obscured
    // check below cares about).
    await bottomRow.scrollIntoViewIfNeeded()
    await bottomRow.getByRole('checkbox', { name: 'Select entry' }).click()
    const bar = bulkActionsBar(page)
    await expect(bar).toBeVisible()

    // A real Tab from the toggle lands in the FIRST row, not the bar.
    await doneBtn.focus()
    await page.keyboard.press('Tab')
    await expect(topRow.getByRole('checkbox', { name: 'Select entry' })).toBeFocused()

    // The mechanism behind that for every row count, not just the first
    // press: the bar's DOM node comes after the very last row, so nothing
    // in between skips over it however many Tabs it takes to get there.
    const barAfterLastRow = await page.evaluate(() => {
      const bars = [...document.querySelectorAll('[data-selection-bar]')]
      const visibleBar = bars.find(el => el.getBoundingClientRect().height > 0)
      const lastRow = [...document.querySelectorAll('div.group')].at(-1)
      if (!visibleBar || !lastRow) return null
      // eslint-disable-next-line no-bitwise
      return !!(lastRow.compareDocumentPosition(visibleBar) & Node.DOCUMENT_POSITION_FOLLOWING)
    })
    expect(barAfterLastRow).toBe(true)
  })

  test('Select mode: tabbing through the rows never leaves focus under the bulk-action bar', async ({ page, api }) => {
    // WCAG 2.2 SC 2.4.11 Focus Not Obscured. Only step-by-step Tab traversal
    // exposes an obscured row: focus() on a far-away element scrolls it to the
    // middle of the viewport whatever scroll-padding-bottom is.
    const names: string[] = []
    for (let i = 0; i < 20; i++) {
      const n = name(`E2E mobile obscure ${i}`)
      names.push(n)
      await createEntry(api, { name: n, billable: false, ...slot(i) })
    }

    await page.goto('/time')
    const today = group(page, 'Today')
    await expect(entryRow(today, names[19]!)).toBeVisible()

    await page.getByRole('button', { name: 'Select', exact: true }).click()
    await entryRow(today, names[19]!).getByRole('checkbox', { name: 'Select entry' }).click()
    const bar = bulkActionsBar(page)
    await expect(bar).toBeVisible()

    await page.evaluate(() => window.scrollTo(0, 0))
    await page.getByRole('button', { name: 'Done', exact: true }).focus()

    const obscured: string[] = []
    let rowStops = 0
    let reachedBar = false
    for (let step = 0; step < 1000; step++) {
      await page.keyboard.press('Tab')
      const state = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null
        const barEl = [...document.querySelectorAll<HTMLElement>('[role="region"][aria-label="Bulk actions"]')]
          .find(b => b.getClientRects().length > 0)
        if (!el || !barEl) return null
        const r = el.getBoundingClientRect()
        return {
          inBar: barEl.contains(el),
          inRow: !!el.closest('[data-entry-id]'),
          label: el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 40) || el.tagName,
          bottom: r.bottom,
          top: r.top,
          barTop: barEl.getBoundingClientRect().top
        }
      })
      if (!state) break
      if (state.inBar) {
        reachedBar = true
        break
      }
      if (!state.inRow) continue
      rowStops++
      if (state.bottom > state.barTop || state.top < 0) {
        obscured.push(`${state.label}: top ${state.top.toFixed(0)}, bottom ${state.bottom.toFixed(0)}, bar top ${state.barTop.toFixed(0)}`)
      }
    }

    expect(reachedBar, 'Tab traversal never reached the bulk-action bar').toBe(true)
    expect(rowStops).toBeGreaterThan(names.length)
    expect(obscured, `focused rows hidden under the bar:\n${obscured.join('\n')}`).toEqual([])
  })

  test('mobile list: deleting an entry via the "…" overflow menu shows the undo toast and undo restores it', async ({ page, api }) => {
    const entryName = name('E2E mobile overflow delete')
    await createEntry(api, { name: entryName, billable: true, ...slot(20) })

    await page.goto('/time')
    const today = group(page, 'Today')
    const row = entryRow(today, entryName)
    await expect(row).toBeVisible()

    // Start again/Edit/Delete icon buttons are desktop-only here — a second
    // always-visible icon crowded the name column at 390px, so all three
    // fold into the "…" menu instead (swipe gestures still cover them too).
    await expect(row.getByRole('button', { name: 'Start again' })).toBeHidden()
    await expect(row.getByRole('button', { name: 'Edit entry' })).toBeHidden()
    await expect(row.getByRole('button', { name: 'Delete entry' })).toBeHidden()

    await row.getByRole('button', { name: 'Entry actions' }).click()
    await page.getByRole('menuitem', { name: 'Delete entry' }).click()
    await expect(row).toHaveCount(0)

    // Rule 4: same undo toast the swipe-to-delete gesture produces.
    await expect(page.getByText(`Deleted “${entryName}”`, { exact: true })).toBeVisible()
    await expect(page.getByText(/^Undo within \d+s$/)).toBeVisible()

    await page.getByRole('button', { name: 'Undo' }).click()
    await expect(entryRow(today, entryName)).toBeVisible()
  })

  test('mobile list: the "…" overflow menu also opens the edit dialog', async ({ page, api }) => {
    const entryName = name('E2E mobile overflow edit')
    await createEntry(api, { name: entryName, billable: true, ...slot(21) })

    await page.goto('/time')
    const today = group(page, 'Today')
    const row = entryRow(today, entryName)
    await expect(row).toBeVisible()

    await row.getByRole('button', { name: 'Entry actions' }).click()
    // Start again lives in the same menu (folded in alongside Edit/Delete).
    await expect(page.getByRole('menuitem', { name: 'Start again' })).toBeVisible()
    await page.getByRole('menuitem', { name: 'Edit entry' }).click()
    const dialog = page.getByRole('dialog').filter({
      has: page.getByRole('heading', { name: 'Edit entry' })
    })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel('What did you work on?')).toHaveValue(entryName)
  })

  test('mobile: the edit dialog\'s Delete removes the entry and undo restores it', async ({ page, api }) => {
    const entryName = name('E2E mobile dialog delete')
    await createEntry(api, { name: entryName, billable: true, ...slot(22) })

    await page.goto('/time')
    const today = group(page, 'Today')
    const row = entryRow(today, entryName)
    await expect(row).toBeVisible()

    // Tapping the name is the existing route into edit mode on mobile.
    await row.getByRole('button', { name: entryName, exact: true }).click()
    const dialog = page.getByRole('dialog').filter({
      has: page.getByRole('heading', { name: 'Edit entry' })
    })
    await expect(dialog).toBeVisible()

    await dialog.getByRole('button', { name: 'Delete entry' }).click()
    await expect(dialog).toBeHidden()
    await expect(entryRow(today, entryName)).toHaveCount(0)

    await expect(page.getByText(`Deleted “${entryName}”`, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect(entryRow(today, entryName)).toBeVisible()
  })

  test('bulk-action bar stays reachable and on-screen once the list scrolls', async ({ page, api }) => {
    // Enough rows to push well past the fold; hour ascending so the lowest
    // hour (oldest) sorts to the very bottom of the "Today" group.
    const names: string[] = []
    for (let i = 0; i < 20; i++) {
      const n = name(`E2E mobile scroll ${i}`)
      names.push(n)
      await createEntry(api, { name: n, billable: false, ...slot(4 + i) })
    }

    await page.goto('/time')
    const today = group(page, 'Today')
    await expect(entryRow(today, names[19]!)).toBeVisible()

    await page.getByRole('button', { name: 'Select', exact: true }).click()

    // Select the bottom-most (oldest) row, below the fold on a 390×844 screen.
    const lastRow = entryRow(today, names[0]!)
    await lastRow.scrollIntoViewIfNeeded()
    await lastRow.getByRole('checkbox', { name: 'Select entry' }).click()

    // The bar must actually be reachable: fully inside the viewport, above
    // the fixed dock — not scrolled off the top (a bottom-sticky element
    // rendered above the list can only move up, never back into view).
    const bar = page.getByRole('region', { name: 'Bulk actions' })
    await expect(bar).toBeVisible()
    const barBox = await bar.boundingBox()
    expect(barBox).not.toBeNull()
    expect(barBox!.y).toBeGreaterThanOrEqual(0)
    expect(barBox!.y + barBox!.height).toBeLessThanOrEqual(VIEWPORT.height)

    // No page-wide horizontal scroll (WCAG 1.4.10 Reflow), and every bar
    // action — Delete included — sits fully inside the 390px viewport.
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(scrollWidth).toBeLessThanOrEqual(VIEWPORT.width)
    const deleteBox = await bar.getByRole('button', { name: 'Delete' }).boundingBox()
    expect(deleteBox).not.toBeNull()
    expect(deleteBox!.x).toBeGreaterThanOrEqual(0)
    expect(deleteBox!.x + deleteBox!.width).toBeLessThanOrEqual(VIEWPORT.width)
  })
})
