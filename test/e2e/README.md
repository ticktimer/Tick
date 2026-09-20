# End-to-end tests

Playwright drives a **real production build** of Tick against the dedicated
`tick_test` database. These specs cover the flows that were re-verified by hand
every swing: sign in / out, the timer (including several running at once), the
Time page's entry flows, the calendar grid, theme persistence, and the mobile
shell.

```bash
npm run test:e2e                      # everything (desktop + mobile projects)
npm run test:e2e -- timer.spec.ts     # one file
npm run test:e2e -- --project=mobile  # the 390×844 project only
npx playwright test --ui              # interactive (needs a headed browser)
```

## What it does *not* touch

* The **dev server on 3790** and the **`tick` dev database** are never used and
  never written to.
* `nuxt build` clears and locks the shared `.nuxt` build directory, which would
  break that running dev server. So `test/e2e/build.mjs` drives `@nuxt/kit`
  directly with an isolated `buildDir` and Nitro output dir under
  `test/e2e/.cache/` (gitignored).

## How a run is wired

| Step | Where |
| --- | --- |
| Build the app (only when a source file is newer than the bundle) | `test/e2e/build.mjs` |
| Serve it on **3804** against `tick_test` | `test/e2e/serve.mjs` (Playwright `webServer`) |
| `db:push --force` + `db:seed` into `tick_test`, then log in once and save the session | `test/e2e/global-setup.ts` |
| Specs | `test/e2e/*.spec.ts` |

`E2E_FORCE_BUILD=1` forces a rebuild, `E2E_SERVER_LOG=1` shows the build/server
output, `E2E_PORT` / `E2E_BASE_URL` / `E2E_CHROMIUM` / `E2E_DATABASE_URL`
override the defaults. `E2E_DATABASE_URL` drives both halves of the run:
`global-setup.ts` reads it directly, and `playwright.config.ts`'s
`webServer.env` forwards the same value to `serve.mjs` as `NUXT_DATABASE_URL`
— so the database seeded and the database served are the same one. The
exception is a local run that reuses a server already listening on
`E2E_PORT` (`reuseExistingServer` is on outside CI): that server keeps
whatever database it was started with, so stop it when switching databases.

Chromium is the headless shell already installed on this machine; the path is
set in `playwright.config.ts` (`launchOptions.executablePath`).

### Environment tweaks the e2e build makes

The first two are test-environment concessions that nothing under test asserts
on. The third is also load-bearing for `session-cookie.spec.ts`, which asserts
directly on the plain-HTTP login it enables:

* `NUXT_AUTH_RATE_LIMIT=0` — the auth endpoints allow 10 POSTs per IP per
  minute; a suite that signs in repeatedly would trip the limiter.
* `NUXT_AUTO_MIGRATE=false` — `tick_test` is managed with `db:push`, so it
  carries no Drizzle migration journal and replaying `0000` would fail on
  existing tables.
* `NUXT_SESSION_COOKIE_SECURE=false` (set in `serve.mjs`) — the suite talks
  plain http to 127.0.0.1 and Playwright's `APIRequestContext` will not send a
  `Secure` cookie over http, so the API-driven setup/cleanup helpers would run
  unauthenticated. `session-cookie.spec.ts` case 1 also verifies this override
  end to end: a plain-HTTP login that the browser would otherwise refuse.
* The PWA service worker is disabled for this build. An auto-updating worker
  re-registering in every fresh browser context is pure flake and no flow under
  test involves it.

## Determinism rules the specs follow

* **One worker, files in order** (`fullyParallel: false`, `workers: 1`). Every
  spec drives the same seeded account, and running timers are account-wide
  state (up to `MAX_RUNNING_TIMERS` of them since ticktimer/Tick#37), so
  parallel files would show each other's timers and share one cap.
* **The seed is the fixture.** `global-setup` reseeds `tick_test` before every
  run, so a run never inherits the previous one's state.
* **Everything a spec creates, it deletes** through the API in `afterEach`
  (`helpers/api.ts`). Specs that start a timer call `stopAllTimers(api)` there,
  which stops every running timer and deletes the entries they produced — a
  leaked running timer would show up in the next spec's running list and eat
  into its cap.
* **No wall-clock assumptions.** Ticking clocks are asserted with polled
  matchers, never `waitForTimeout`. The multi-timer cases read a row's clock,
  then poll until it differs, rather than matching a literal `00:00:0x` — two
  timers started seconds apart never show the same digits. `timer.spec` parks today's three seeded
  rows in the trash for the duration of the test and restores them afterwards:
  the seed writes them at fixed clock times (9:05, 11:30, 13:00), so whether a
  timer stopped "now" sorts above them would otherwise depend on the hour of
  the run.
* **Unique names.** Every row a spec creates carries a per-run suffix
  (`helpers/fixtures.ts`), so a row leaked by a crashed run can never be
  mistaken for a fresh one.

## Projects

| Project | Viewport | Runs |
| --- | --- | --- |
| `desktop` | 1440×900 | everything except `@mobile` |
| `mobile` | 390×844, `hasTouch` | only tests tagged `@mobile` (`mobile.spec.ts`, `manage-mobile.spec.ts`, and the `a11y.spec.ts` mobile subset) |

## Accessibility (`a11y.spec.ts`)

`@axe-core/playwright` scans every main page (logged out: `/login`, `/register`;
logged in: dashboard, Time, Calendar, Reports, Projects, Clients, Tags,
Settings) plus the picker and manual-entry dialogs, asserting zero
`wcag2a`/`wcag2aa`/`wcag21a`/`wcag21aa` violations. Logged-in pages run once
per shipped color-mode default — **Nocturne** (dark) and **Daylight**
(light) — switched via the real Settings → Appearance preset buttons (not a
hand-rolled cookie). The same pair also scans the **running-timer list**
(ticktimer/Tick#37): it is a surface no page load reaches, so that test starts
two timers, opens the disclosure, scans, and stops them again in a `finally`. Every test that switches to a non-default preset restores
Nocturne in its own `afterEach`: the preset persists server-side
(`users.theme`) for the rest of the run, so leaving it dirty would carry into
whichever spec runs next. This doesn't need a run-to-run cleanup step —
global setup's reseed clears `users.theme` between separate
`npm run test:e2e` invocations. A small `@mobile`-tagged subset (`/`, `/time`
incl. Select mode on + the bulk-action bar, `/clients`, `/tags`, the picker
bottom sheet) also runs in the `mobile` project.

**Reading a failure**: the assertion message lists every violation with its
axe rule id, impact (`minor`/`moderate`/`serious`/`critical`), the rule's
`help` text, and each failing node's target CSS selector — enough to find the
element without re-running anything. There are no disabled rules; a violation
that turns out to live inside a Nuxt UI internal you can't fix would get a
`.exclude()` on that exact selector with a comment explaining why (none exist
as of this writing — check `a11y.spec.ts` itself for the current list).

### Client/tag row layout at phone width (`manage-mobile.spec.ts`)

Issue #8: the /clients and /tags row grids gave the name/tag track
`minmax(0, …)` while the other tracks were bare `1fr` (`minmax(auto, 1fr)`,
which won't shrink below its content), so at 390px the flexible track
absorbed the whole shortfall and collapsed toward zero — invisible client
names, overlapping "Client"/"Rate" header labels. `@mobile`-tagged, asserting
each row's name/tag cell renders wider than 80px and that the column-header
row (hidden entirely below `sm` now) stays hidden. Read-only against the
seed — nothing to clean up.

### Client avatar swatch ink (`client-color-contrast.spec.ts`)

The /clients avatar initials paint their ink with a CSS-only relative-color
computation (`.tick-on-swatch`, app/assets/css/main.css) instead of a JS
function, because the right ink depends on whichever primary (17 choices) and
neutral (9 choices) the user picked — not just the two shipped presets — and
CSS can't be unit-tested. This spec drives every primary and every neutral
through the real Settings → Appearance editor, in both color modes, and
asserts ≥4.5:1 via `getComputedStyle` on a live probe element (not a full axe
run — much faster, and deterministic in a way reading real seeded-client
avatars wouldn't be, since seeded client ids are DB-generated per seed run).
Restores the default theme in its own `afterEach` for the same reason as the
a11y spec above.

## Selector conventions

Roles, labels and headings first (`helpers/dom.ts`). Two notes:

* The shell renders the desktop timer bar **and** the mobile dock at the same
  time, one of them CSS-hidden — widgets that exist twice are narrowed with
  `filter({ visible: true })`, never with breakpoint classes. That is also why
  the running list's `id` is passed in (`timer-list-desktop` /
  `timer-list-mobile`): two copies are mounted, and each disclosure's
  `aria-controls` has to resolve to its own one.
* `div.group` is the one class-based hook: it is `TimeEntryRow`'s row grid and
  the only `group` class in the app.

## Shared-database caveat

Other suites on this machine also use `tick_test`. They work in their own orgs,
and `db:seed` only resets the "Hollow Studio" org and `mara@example.com`, so the
two coexist — but running another suite that reseeds *at the same time* as this
one will disturb it. A full run (both projects, 61 tests as of this writing)
takes about 2 minutes once the build is cached; add ~10-15s the first time,
for the build and `db:push`/`db:seed`.
