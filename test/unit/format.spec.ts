import { describe, expect, it } from 'vitest'
import {
  clientColorVar,
  formatClock,
  formatDateLong,
  formatDayLabel,
  formatDaySub,
  formatDuration,
  formatEstimate,
  formatMoney,
  formatRange,
  formatTime
} from '../../app/utils/format'
import { parseDuration } from '../../app/utils/parse'

/**
 * Timezone note: every Date below is built from LOCAL components
 * (`new Date(2026, 2, 14, 9, 5)`), and the formatters read local getters, so
 * the expected strings hold in any TZ the CI box happens to use. Never build
 * these fixtures from ISO strings ("2026-03-14T09:05Z") — those shift by zone.
 * The locale, by contrast, is pinned to en-US inside format.ts, so the
 * month/weekday spellings below are stable regardless of system locale.
 */
const REF = new Date(2026, 2, 14, 10, 30, 0) // Saturday 14 March 2026, local

describe('formatDuration', () => {
  it.each<[number, string]>([
    [0, '0m'],
    [59, '1m'], // rounds to the nearest minute
    [29, '0m'],
    [60, '1m'],
    [30 * 60, '30m'],
    [3600, '1h 00m'], // exactly an hour: minutes zero-padded once hours show
    [3600 + 5 * 60, '1h 05m'],
    [2 * 3600 + 15 * 60, '2h 15m'],
    [24 * 3600, '24h 00m'],
    [25 * 3600 + 1 * 60, '25h 01m'],
    [100 * 3600, '100h 00m']
  ])('%i sec → %s', (sec, expected) => {
    expect(formatDuration(sec)).toBe(expected)
  })

  it('clamps negatives to zero rather than printing "-1h"', () => {
    expect(formatDuration(-5)).toBe('0m')
    expect(formatDuration(-9999)).toBe('0m')
  })
})

describe('formatDuration ↔ parseDuration round-trip', () => {
  // The written form is lossless at whole-minute resolution, so parsing a
  // formatted duration must return exactly the minutes that went in.
  const seconds = [0, 60, 61, 599, 1800, 2700, 3600, 3661, 5400, 8100, 45 * 60, 86_400, 90_000, 123_456, 360_000]

  it.each(seconds)('parseDuration(formatDuration(%i)) === round(sec/60)', (sec) => {
    expect(parseDuration(formatDuration(sec))).toBe(Math.round(sec / 60))
  })

  it.each(seconds)('formatDuration re-emits the same string for %i', (sec) => {
    const text = formatDuration(sec)
    const minutes = parseDuration(text)!
    expect(formatDuration(minutes * 60)).toBe(text)
  })
})

describe('formatClock', () => {
  it.each<[number, string]>([
    [0, '00:00:00'],
    [1, '00:00:01'],
    [59, '00:00:59'],
    [60, '00:01:00'],
    [3599, '00:59:59'],
    [3600, '01:00:00'],
    [3661, '01:01:01'],
    [90_061, '25:01:01'],
    [59.9, '00:00:59'] // truncates, never rounds a tick forward
  ])('%d sec → %s', (sec, expected) => {
    expect(formatClock(sec)).toBe(expected)
  })

  it('clamps negatives to 00:00:00', () => {
    expect(formatClock(-1)).toBe('00:00:00')
  })
})

describe('formatMoney', () => {
  it.each<[number, string]>([
    [0, '$0'],
    [0.4, '$0'],
    [0.5, '$1'], // cents round to whole dollars
    [1234.56, '$1,235'],
    [84.99, '$85'],
    [840, '$840'],
    [3699, '$3,699'],
    [1_000_000, '$1,000,000']
  ])('%d → %s', (n, expected) => {
    expect(formatMoney(n)).toBe(expected)
  })
})

describe('formatTime / formatRange', () => {
  it.each<[Date, string]>([
    [new Date(2026, 2, 14, 9, 5), '9:05am'],
    [new Date(2026, 2, 14, 0, 0), '12:00am'],
    [new Date(2026, 2, 14, 12, 0), '12:00pm'],
    [new Date(2026, 2, 14, 13, 0), '1:00pm'],
    [new Date(2026, 2, 14, 23, 59), '11:59pm']
  ])('%s → %s', (d, expected) => {
    expect(formatTime(d)).toBe(expected)
  })

  it('accepts a timestamp as well as a Date', () => {
    const d = new Date(2026, 2, 14, 14, 5)
    expect(formatTime(d.getTime())).toBe('2:05pm')
  })

  it('joins a range with an en dash', () => {
    expect(formatRange(new Date(2026, 2, 14, 9, 5), new Date(2026, 2, 14, 11, 20))).toBe('9:05am – 11:20am')
    expect(formatRange(new Date(2026, 2, 14, 13, 0), new Date(2026, 2, 14, 14, 45))).toBe('1:00pm – 2:45pm')
  })

  it('marks an end on a later day with the day count', () => {
    expect(formatRange(new Date(2026, 2, 14, 23, 30), new Date(2026, 2, 15, 1, 15))).toBe('11:30pm – 1:15am +1')
    expect(formatRange(new Date(2026, 2, 14, 23, 30), new Date(2026, 2, 16, 0, 5))).toBe('11:30pm – 12:05am +2')
    // Ending at exactly midnight is already the next day
    expect(formatRange(new Date(2026, 2, 14, 22, 0), new Date(2026, 2, 15, 0, 0))).toBe('10:00pm – 12:00am +1')
  })

  it('counts the days in the given zone, not the runtime one', () => {
    // 23:30 → 01:15 in Denver crosses midnight there; UTC clock reads 05:30 → 07:15 the next day
    const start = Date.UTC(2026, 2, 15, 5, 30)
    const end = Date.UTC(2026, 2, 15, 7, 15)
    expect(formatRange(start, end, 'America/Denver')).toBe('11:30pm – 1:15am +1')
    expect(formatRange(start, end, 'UTC')).toBe('5:30am – 7:15am')
  })
})

describe('formatDayLabel', () => {
  it('labels the reference day Today', () => {
    expect(formatDayLabel(new Date(2026, 2, 14, 23, 59), REF)).toBe('Today')
    expect(formatDayLabel(new Date(2026, 2, 14, 0, 0), REF)).toBe('Today')
  })

  it('labels the day before Yesterday', () => {
    expect(formatDayLabel(new Date(2026, 2, 13, 8, 0), REF)).toBe('Yesterday')
  })

  it('uses the weekday name for 2–6 days back', () => {
    expect(formatDayLabel(new Date(2026, 2, 12), REF)).toBe('Thursday')
    expect(formatDayLabel(new Date(2026, 2, 10), REF)).toBe('Tuesday')
    expect(formatDayLabel(new Date(2026, 2, 9), REF)).toBe('Monday')
    // 6 days back is the last day that still gets a bare weekday name.
    expect(formatDayLabel(new Date(2026, 2, 8), REF)).toBe('Sunday')
  })

  it('falls back to a dated label at 7 days and beyond', () => {
    expect(formatDayLabel(new Date(2026, 2, 7), REF)).toBe('Sat, Mar 7')
    expect(formatDayLabel(new Date(2026, 1, 20), REF)).toBe('Fri, Feb 20')
  })

  it('adds the year only when it differs from the reference year', () => {
    expect(formatDayLabel(new Date(2025, 8, 2), REF)).toBe('Tue, Sep 2, 2025')
    expect(formatDayLabel(new Date(2026, 0, 2), REF)).toBe('Fri, Jan 2')
  })

  it('handles future days with the dated label (no negative-day weirdness)', () => {
    expect(formatDayLabel(new Date(2026, 2, 20), REF)).toBe('Fri, Mar 20')
  })

  it('is DST-safe: the day after a spring-forward is still Yesterday', () => {
    // US DST starts 2026-03-08; a 23-hour day must not round to 0 or 2 days.
    expect(formatDayLabel(new Date(2026, 2, 8), new Date(2026, 2, 9, 12, 0))).toBe('Yesterday')
  })
})

describe('formatDaySub / formatDateLong', () => {
  it('formatDaySub is the short month/day pair', () => {
    expect(formatDaySub(new Date(2026, 8, 11))).toBe('Sep 11')
    expect(formatDaySub(new Date(2026, 0, 1))).toBe('Jan 1')
  })

  it('formatDateLong spells out weekday, month, day and year', () => {
    expect(formatDateLong(new Date(2026, 8, 11))).toBe('Fri, Sep 11, 2026')
    expect(formatDateLong(new Date(2026, 2, 14))).toBe('Sat, Mar 14, 2026')
  })
})

describe('formatEstimate', () => {
  it.each<[number, string]>([
    [2400, '40h'], // whole hours collapse to "40h"
    [60, '1h'],
    [150, '2h 30m'],
    [30, '30m'],
    [90, '1h 30m']
  ])('%i min → %s', (minutes, expected) => {
    expect(formatEstimate(minutes)).toBe(expected)
  })

  it('round-trips through the duration grammar', () => {
    for (const minutes of [30, 60, 90, 150, 2400]) {
      expect(parseDuration(formatEstimate(minutes))).toBe(minutes)
    }
  })
})

describe('clientColorVar', () => {
  it('maps a ramp token to the Nuxt UI CSS var', () => {
    expect(clientColorVar('primary-400')).toBe('var(--ui-color-primary-400)')
    expect(clientColorVar('neutral-400')).toBe('var(--ui-color-neutral-400)')
  })

  it('passes through values that are already CSS', () => {
    expect(clientColorVar('var(--ui-primary)')).toBe('var(--ui-primary)')
    expect(clientColorVar('oklch(0.7 0.1 250)')).toBe('oklch(0.7 0.1 250)')
    expect(clientColorVar('rgb(1 2 3)')).toBe('rgb(1 2 3)')
  })

  it('falls back when the token is missing', () => {
    expect(clientColorVar(null)).toBe('var(--ui-border-accented)')
    expect(clientColorVar(undefined)).toBe('var(--ui-border-accented)')
    expect(clientColorVar('')).toBe('var(--ui-border-accented)')
    expect(clientColorVar(null, 'var(--custom)')).toBe('var(--custom)')
  })
})

// The avatar-initials ink (app/pages/clients.vue) used to be a JS function
// (`clientColorInk`) keyed off color-mode, but that's the wrong variable —
// the swatch's hue (17 primaries × 9 neutrals, user-chosen) decides the ink,
// not the app's mode. It's now a CSS-only relative-color computation
// (`.tick-on-swatch` in app/assets/css/main.css) with no JS unit to test;
// see test/e2e/client-color-contrast.spec.ts for its coverage.
