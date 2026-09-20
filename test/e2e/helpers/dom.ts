// Shared locators. Everything anchors on a role, a label or a heading —
// the shell renders the desktop timer bar and the mobile dock at the same
// time (one of them CSS-hidden), so widgets that exist twice are narrowed
// with `filter({ visible: true })` rather than by breakpoint-specific classes.
import type { Locator, Page } from '@playwright/test'

/** The visible one of the two timer description inputs. */
export function timerInput(page: Page): Locator {
  return page.getByLabel('What are you working on?').filter({ visible: true })
}

/** The visible start/stop button — its accessible name IS the timer state. */
export function timerToggle(page: Page): Locator {
  return page.getByRole('button', { name: /^(Start|Stop)$/ }).filter({ visible: true })
}

/** hh:mm:ss readout — the element immediately before the start/stop button. */
export function timerClock(page: Page): Locator {
  return timerToggle(page).locator('xpath=preceding-sibling::*[1]')
}

/** The visible "+" that opens the client/project/task picker. */
export function timerPlus(page: Page): Locator {
  return page.getByRole('button', { name: 'Add client, project or task' }).filter({ visible: true })
}

/**
 * The visible running-count chip — the disclosure for the running list
 * (ticktimer/Tick#37). Desktop prints "2 running" and takes its accessible name
 * from that text; the 390px dock prints just the digit and carries the full
 * "2 timers running" as its label. Both end in "running".
 */
export function timerCount(page: Page): Locator {
  return page.getByRole('button', { name: /running$/ }).filter({ visible: true })
}

/** The visible "Add a timer" toggle — only rendered while something runs. */
export function addTimerButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Add a timer' }).filter({ visible: true })
}

/** The visible running-timer list (desktop disclosure / mobile dock overlay). */
export function timerList(page: Page): Locator {
  return page.getByRole('list', { name: 'Running timers' }).filter({ visible: true })
}

/** One row of the running list, addressed by that timer's name. */
export function timerListRow(page: Page, name: string): Locator {
  return timerList(page).getByRole('listitem').filter({
    has: page.getByRole('button', { name: `Stop ${name}`, exact: true })
  })
}

/** A running-list row's live clock. `.tnum` is the only tabular figure in a row. */
export function timerRowClock(row: Locator): Locator {
  return row.locator('.tnum')
}

/** Chain chip next to the timer description, e.g. "Website redesign · Acme Co". */
export function timerChain(page: Page): Locator {
  return page.getByRole('button', { name: 'Remove client, project or task' })
    .filter({ visible: true })
    .locator('xpath=preceding-sibling::span[1]')
}

/** The picker dialog — the one carrying the Client / Project / Task tablist. */
export function picker(page: Page): Locator {
  return page.getByRole('dialog').filter({
    has: page.getByRole('tablist', { name: 'Pick type' })
  })
}

/**
 * The mobile bulk-action bar (SelectionBar). Its "n selected" span is visual
 * only — time.vue also keeps an always-mounted live region with the same
 * text, so an unscoped `getByText('n selected')` matches both and throws a
 * strict-mode violation while the bar is mounted. Scope to the bar for the
 * visible count.
 */
export function bulkActionsBar(page: Page): Locator {
  return page.getByRole('region', { name: 'Bulk actions' })
}

/** A day / project group card on /time, addressed by its heading. */
export function group(page: Page, label: string): Locator {
  return page.locator('section').filter({
    has: page.getByRole('heading', { name: label, exact: true })
  })
}

/**
 * Every entry row, in rendered order. `div.group` is TimeEntryRow's row grid
 * (app/components/time/EntryRow.vue) and the only `group` class in the app.
 */
export function rows(scope: Page | Locator): Locator {
  return scope.locator('div.group')
}

/** One entry row, addressed by the entry's name. */
export function entryRow(scope: Page | Locator, name: string): Locator {
  const page = 'page' in scope ? scope.page() : scope
  return rows(scope).filter({ has: page.getByRole('button', { name, exact: true }) })
}
