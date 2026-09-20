// Automated accessibility sweep (axe-core) — the regression guard for the
// swing-6 accessibility audit (issue #15). Desktop project runs every test
// here; a small subset tagged `@mobile` also runs at 390×844.
//
// Covers: logged-out auth pages, every main page logged in (in both shipped
// color-mode defaults — Nocturne/dark and Daylight/light), and the two
// dialogs that don't show up in a plain page load (picker, manual entry).
// See test/e2e/README.md for how to read a failing run.
import AxeBuilder from '@axe-core/playwright'
import type { AxeResults } from 'axe-core'
import type { Page } from '@playwright/test'
import { createTask, deleteTasksNamed, stopAllTimers } from './helpers/api'
import { addTimerButton, picker, timerInput, timerList, timerPlus, timerToggle } from './helpers/dom'
import { uniqueName } from './helpers/fixtures'
import { expect, test } from './helpers/test'

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

// axe includes `opacity` in its color-contrast math, and Nuxt UI's dialogs
// (scale-in/fade-in, 200ms) and the mobile selection bar (tick-rise, 180ms)
// animate opacity on mount. `toBeVisible()` passes as soon as an element is
// in the layout — including mid-fade at a fraction of full opacity — so a
// scan that races an animation is a flaky color-contrast violation on
// perfectly fine, fully-rendered UI. main.css already collapses every
// animation to ~0 under prefers-reduced-motion; opting every test in this
// file into it is what actually makes axe see the settled state.
test.use({ reducedMotion: 'reduce' })

function formatViolations(violations: AxeResults['violations']): string {
  return violations
    .map(v =>
      `${v.id} (${v.impact}) — ${v.help}\n`
      + v.nodes.map(n => `    target: ${n.target.join(' ')}`).join('\n')
    )
    .join('\n\n')
}

/** Runs axe over the whole document and asserts zero violations. No blanket
 * rule disables — a genuine third-party-only violation gets a `.exclude()`
 * with a comment, not a disabled rule. */
async function checkA11y(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze()
  expect(violations, violations.length ? `axe violations on ${label}:\n\n${formatViolations(violations)}` : '').toEqual([])
}

/** Settings → Appearance preset buttons apply AND persist immediately (cookie
 * + localStorage + `PATCH /api/me/theme`) — the same mechanism theme.spec.ts
 * exercises, so this is the "real" way to switch theme, not a hand-rolled
 * cookie. Every test below starts from a fresh context (Playwright's default
 * `page` fixture reloads `storageState` per test), so the preset has to be
 * (re)applied at the top of each one — it does not carry over between tests. */
async function applyPreset(page: Page, name: 'Nocturne' | 'Daylight') {
  await page.goto('/settings')
  const btn = page.getByRole('button', { name: `Apply ${name} preset` })
  await btn.click()
  await expect(btn).toHaveAttribute('aria-pressed', 'true')
}

const PAGES = ['/', '/time', '/calendar', '/reports', '/projects', '/clients', '/tags', '/settings']

test.describe('logged out', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('/login has no violations', async ({ page }) => {
    await page.goto('/login')
    await checkA11y(page, '/login')
  })

  test('/register has no violations', async ({ page }) => {
    await page.goto('/register')
    await checkA11y(page, '/register')
  })
})

for (const preset of ['Nocturne', 'Daylight'] as const) {
  test.describe(`logged in — ${preset}`, () => {
    // Restore the default theme right after every test that changes it — the
    // preset persists server-side (`users.theme`) for the rest of this run,
    // so leaving it dirty would carry into whichever spec runs next on the
    // same worker (e.g. auth.spec.ts, which logs in through the real form
    // and applies the saved theme). Global setup's per-run reseed already
    // clears `users.theme` between separate `npm run test:e2e` invocations,
    // so no cross-run cleanup is needed here.
    if (preset !== 'Nocturne') {
      test.afterEach(async ({ page }) => {
        await applyPreset(page, 'Nocturne')
      })
    }

    for (const path of PAGES) {
      test(`${path} has no violations (${preset})`, async ({ page }) => {
        await applyPreset(page, preset)
        await page.goto(path)
        await checkA11y(page, `${path} (${preset})`)
      })
    }

    // ticktimer/Tick#37 — the running list is a whole new surface in the shell
    // and it is only on screen once two things run and the disclosure is open,
    // so a plain page-load scan never reaches it. Both shipped presets, because
    // the list's fill and every text token on it are mode-dependent.
    test(`the running-timer list has no violations (${preset})`, async ({ page, api }) => {
      const first = uniqueName('E2E a11y timer one')
      const second = uniqueName('E2E a11y timer two')
      await applyPreset(page, preset)
      await page.goto('/time')
      try {
        await timerInput(page).fill(first)
        await timerToggle(page).click()
        await expect(timerToggle(page)).toHaveAccessibleName('Stop')

        await addTimerButton(page).click()
        await timerInput(page).fill(second)
        await timerToggle(page).click()
        await expect(timerToggle(page)).toHaveAccessibleName('Stop')

        // Opened on its own once the second timer bumped the first out of the bar.
        await expect(timerList(page)).toBeVisible()
        await checkA11y(page, `running-timer list (${preset})`)
      } finally {
        // stopAllTimers also deletes the entries the two timers produced.
        await stopAllTimers(api)
      }
    })
  })
}

test.describe('open dialogs (desktop)', () => {
  test('picker dialog has no violations', async ({ page }) => {
    await page.goto('/time')
    await timerPlus(page).click()
    await page.getByRole('menuitem', { name: 'Project' }).click()
    await expect(picker(page)).toBeVisible()
    // Every tab's aria-controls must resolve to a real tabpanel, not the
    // results listbox (which the search combobox controls separately).
    await expect(picker(page).locator('#picker-panel[role="tabpanel"]')).toBeAttached()
    // The first option is already highlighted (aria-activedescendant set) as
    // soon as the picker opens — filtering re-highlights index 0, it isn't
    // what sets the attribute in the first place. Assert the combobox/listbox
    // wiring directly rather than just trusting a fill() to have done it,
    // since axe's aria-valid-attr-value rule only checks the id reference
    // when aria-activedescendant is present — it says nothing if the binding
    // broke and the attribute went missing.
    await picker(page).getByRole('combobox').fill('a')
    await expect(picker(page).getByRole('option').first()).toBeVisible()
    await expect(picker(page).getByRole('combobox')).toHaveAttribute('aria-activedescendant', /^picker-option-/)
    await checkA11y(page, 'picker dialog')
  })

  test('picker tabs follow the APG tablist keyboard model', async ({ page }) => {
    await page.goto('/time')
    await timerPlus(page).click()
    await page.getByRole('menuitem', { name: 'Client' }).click()
    await expect(picker(page)).toBeVisible()

    const clientTab = picker(page).getByRole('tab', { name: 'Client' })
    const projectTab = picker(page).getByRole('tab', { name: 'Project' })
    const taskTab = picker(page).getByRole('tab', { name: 'Task' })

    // Roving tabindex: only the active tab is a Tab stop.
    await expect(clientTab).toHaveAttribute('tabindex', '0')
    await expect(projectTab).toHaveAttribute('tabindex', '-1')
    await expect(taskTab).toHaveAttribute('tabindex', '-1')

    await clientTab.focus()
    await page.keyboard.press('ArrowRight')
    await expect(projectTab).toHaveAttribute('aria-selected', 'true')
    await expect(projectTab).toBeFocused()
    await expect(projectTab).toHaveAttribute('tabindex', '0')
    await expect(clientTab).toHaveAttribute('tabindex', '-1')

    await page.keyboard.press('End')
    await expect(taskTab).toHaveAttribute('aria-selected', 'true')
    await expect(taskTab).toBeFocused()

    await page.keyboard.press('Home')
    await expect(clientTab).toHaveAttribute('aria-selected', 'true')
    await expect(clientTab).toBeFocused()

    // Wraps backward past the first tab to the last.
    await page.keyboard.press('ArrowLeft')
    await expect(taskTab).toHaveAttribute('aria-selected', 'true')
    await expect(taskTab).toBeFocused()
  })

  test('manual entry dialog has no violations', async ({ page }) => {
    await page.goto('/time')
    await page.getByRole('button', { name: 'Manual entry' }).click()
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Manual entry' }) })
    await expect(dialog).toBeVisible()
    await checkA11y(page, 'manual entry dialog')
  })

  test('picker dialog has no violations once the results overflow the scroller', async ({ page, api }) => {
    // The seed data never overflows the 340px results scroller, so a plain
    // page-load scan of the picker never exercises this. With more than a
    // screenful of options and no "Show more"/"Create" row inside the
    // scroller (both hidden once the results already fill the page), the
    // scroller needs a focusable descendant or a combobox pointed at it of
    // its own — otherwise axe's scrollable-region-focusable rule fires.
    const created: string[] = []
    const tag = uniqueName('E2E overflow')
    for (let i = 0; i < 12; i++) {
      const dto = await createTask(api, `${tag} ${i}`)
      created.push(dto.name)
    }
    try {
      await page.goto('/time')
      await timerPlus(page).click()
      await page.getByRole('menuitem', { name: 'Task' }).click()
      await expect(picker(page)).toBeVisible()
      await picker(page).getByRole('combobox').fill(tag)
      await expect(picker(page).getByRole('option')).toHaveCount(12)
      await checkA11y(page, 'picker dialog (overflowing results)')
    } finally {
      await deleteTasksNamed(api, ...created)
    }
  })
})

test.describe('mobile subset', { tag: '@mobile' }, () => {
  test('/ has no violations', async ({ page }) => {
    await page.goto('/')
    await checkA11y(page, '/ (mobile)')
  })

  test('/time has no violations, incl. Select mode + the bulk-action bar', async ({ page }) => {
    await page.goto('/time')
    await checkA11y(page, '/time (mobile)')

    await page.getByRole('button', { name: 'Select', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible()
    await checkA11y(page, '/time (mobile, Select mode on)')

    // The bulk-action bar (TimeSelectionBar) only mounts once something is
    // selected — scan it too, not just the empty Select-mode state, since
    // it's the main new mobile UI this checklist item adds.
    await page.getByRole('checkbox', { name: 'Select entry' }).first().check()
    await expect(page.getByRole('region', { name: 'Bulk actions' })).toBeVisible()
    await checkA11y(page, '/time (mobile, Select mode + bulk bar)')
  })

  test('/clients has no violations', async ({ page }) => {
    await page.goto('/clients')
    await checkA11y(page, '/clients (mobile)')
  })

  test('/tags has no violations', async ({ page }) => {
    await page.goto('/tags')
    await checkA11y(page, '/tags (mobile)')
  })

  test('picker bottom sheet has no violations', async ({ page }) => {
    await page.goto('/time')
    await timerPlus(page).click()
    await expect(picker(page)).toBeVisible()
    await checkA11y(page, 'picker bottom sheet (mobile)')
  })
})
