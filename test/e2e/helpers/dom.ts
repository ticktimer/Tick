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

/** The visible "Add a timer" button — only rendered while something runs. */
export function addTimerButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Add a timer' }).filter({ visible: true })
}

/** The same slot while the bar is composing: a ✕ that discards the draft. */
export function cancelTimerButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Cancel new timer' }).filter({ visible: true })
}

/** The mobile overlay's ✕ (the desktop disclosure has none — its chip is adjacent). */
export function closeTimerListButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Close the running timers' }).filter({ visible: true })
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

/** A row's tap-to-select control: the selected timer is the one the bar shows. */
export function timerListSelect(page: Page, name: string): Locator {
  return timerListRow(page, name).getByRole('button', { name: `Show ${name} in the timer bar`, exact: true })
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

// ── Calendar ───────────────────────────────────────────────────────────────
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A drawn calendar entry block, by the name its accessible name leads with —
 * "<name> · Sat 12 · 3:00pm – 5:00pm · 2h 00m · <chain>". Anchored on the
 * " · " after the name, so a fold whose label begins with the same name and a
 * comma ("<name>, <other> · 2 entries …") never matches.
 */
export function calendarBlock(page: Page, name: string): Locator {
  return page.getByRole('button', { name: new RegExp(`^${esc(name)} · `) })
}

/** A folded cluster (ticktimer/Tick#37), by its members in start order. */
export function calendarFold(page: Page, ...names: string[]): Locator {
  return page.getByRole('button', {
    name: new RegExp(`^${names.map(esc).join(', ')} · ${names.length} entries`)
  })
}

/** The list a fold discloses: one row per member, a ▶ on every ended one. */
export function foldList(page: Page): Locator {
  return page.getByRole('list', { name: 'Overlapping entries' })
}

/**
 * Lane widths — and so whether a cluster is drawn as lanes or a fold — come
 * from the measured grid; the server render assumes Week's widest column.
 * The flag is set once the first measurement lands and never cleared, so this
 * gates the first client layout only: a later Week↔Day switch re-derives the
 * column width synchronously from the same measurement.
 */
export async function waitForLanesMeasured(page: Page): Promise<void> {
  await page.locator('[data-lanes-measured]').waitFor()
}
