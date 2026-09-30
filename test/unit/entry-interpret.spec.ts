// The Manual-entry / calendar-create dialogs' reading of their free-text
// fields — the same rules both dialogs show on the live interpretation line.
import { describe, expect, it } from 'vitest'
import { interpretEntry, type EntryFields } from '../../app/utils/entry-interpret'

/** A fixed "today" (Sat Mar 14 2026) so relative words are deterministic. */
const REF = new Date(2026, 2, 14, 15, 0)

function fields(partial: Partial<EntryFields>): EntryFields {
  return { date: '', endDate: '', start: '', end: '', duration: '', ...partial }
}

describe('interpretEntry — same-day entries', () => {
  it('start + end on the given date', () => {
    const r = interpretEntry(fields({ date: '2026-03-10', start: '9:00', end: '11:30' }), REF)
    expect(r.valid).toBe(true)
    expect(r.start).toEqual(new Date(2026, 2, 10, 9, 0))
    expect(r.end).toEqual(new Date(2026, 2, 10, 11, 30))
    expect(r.text).toBe('Tue, Mar 10, 2026 · 9:00am – 11:30am · 2h 30m')
  })

  it('a blank date means today', () => {
    const r = interpretEntry(fields({ start: '9:00', end: '10:00' }), REF)
    expect(r.valid).toBe(true)
    expect(r.start).toEqual(new Date(2026, 2, 14, 9, 0))
  })

  it('start + duration derives the end', () => {
    const r = interpretEntry(fields({ date: 'yesterday', start: '2pm', duration: '1h 15m' }), REF)
    expect(r.valid).toBe(true)
    expect(r.start).toEqual(new Date(2026, 2, 13, 14, 0))
    expect(r.end).toEqual(new Date(2026, 2, 13, 15, 15))
    expect(r.text).toBe('Fri, Mar 13, 2026 · 2:00pm – 3:15pm · 1h 15m')
  })

  it('duration alone logs from 9:00', () => {
    const r = interpretEntry(fields({ duration: '45m' }), REF)
    expect(r.valid).toBe(true)
    expect(r.start).toEqual(new Date(2026, 2, 14, 9, 0))
    expect(r.end).toEqual(new Date(2026, 2, 14, 9, 45))
    expect(r.text).toContain('(no start time — logged from 9:00)')
  })

  it('start + end wins over a duration when both are given', () => {
    const r = interpretEntry(fields({ start: '9:00', end: '10:00', duration: '5h' }), REF)
    expect(r.end).toEqual(new Date(2026, 2, 14, 10, 0))
  })

  it('falls back to the duration when the end time is not after the start', () => {
    const r = interpretEntry(fields({ start: '9:00', end: '8:00', duration: '2h' }), REF)
    expect(r.valid).toBe(true)
    expect(r.end).toEqual(new Date(2026, 2, 14, 11, 0))
  })
})

describe('interpretEntry — crossing midnight', () => {
  it('an end date carries the entry into the next day', () => {
    const r = interpretEntry(fields({ date: '2026-03-13', endDate: '2026-03-14', start: '11:30pm', end: '12:15am' }), REF)
    expect(r.valid).toBe(true)
    expect(r.start).toEqual(new Date(2026, 2, 13, 23, 30))
    expect(r.end).toEqual(new Date(2026, 2, 14, 0, 15))
    expect(r.text).toBe('Fri, Mar 13, 2026 · 11:30pm – 12:15am +1 · 45m')
  })

  it('the end date takes the same free-text forms as the start date', () => {
    const r = interpretEntry(fields({ date: 'yesterday', endDate: 'today', start: '11:00pm', end: '1:00am' }), REF)
    expect(r.valid).toBe(true)
    expect(r.start).toEqual(new Date(2026, 2, 13, 23, 0))
    expect(r.end).toEqual(new Date(2026, 2, 14, 1, 0))
  })

  it('an end date more than a day out counts the days', () => {
    const r = interpretEntry(fields({ date: '2026-03-10', endDate: 'mar 12', start: '8:00', end: '8:00' }), REF)
    expect(r.valid).toBe(true)
    expect(r.text).toBe('Tue, Mar 10, 2026 · 8:00am – 8:00am +2 · 48h 00m')
  })

  it('a start + duration rolls past midnight on its own', () => {
    const r = interpretEntry(fields({ date: '2026-03-13', start: '11:00pm', duration: '3h' }), REF)
    expect(r.valid).toBe(true)
    expect(r.end).toEqual(new Date(2026, 2, 14, 2, 0))
    expect(r.text).toBe('Fri, Mar 13, 2026 · 11:00pm – 2:00am +1 · 3h 00m')
  })

  it('an end time before the start on the same day is invalid, with the End-date hint', () => {
    const r = interpretEntry(fields({ date: '2026-03-13', start: '11:30pm', end: '12:15am' }), REF)
    expect(r.valid).toBe(false)
    expect(r.text).toBe('Fri, Mar 13, 2026 · end must be after start — add an End date to cross midnight.')
  })

  it('an explicit same end date still needs the end after the start', () => {
    const r = interpretEntry(fields({ date: '2026-03-13', endDate: '2026-03-13', start: '11:30pm', end: '12:15am' }), REF)
    expect(r.valid).toBe(false)
    expect(r.text).toContain('add an End date to cross midnight')
  })

  it('an end date before the start date is invalid without the hint', () => {
    const r = interpretEntry(fields({ date: '2026-03-13', endDate: '2026-03-12', start: '9:00', end: '10:00' }), REF)
    expect(r.valid).toBe(false)
    expect(r.text).toBe('Fri, Mar 13, 2026 · end must be after start.')
  })

  it('ending exactly at midnight is the next day', () => {
    const r = interpretEntry(fields({ date: '2026-03-13', endDate: '2026-03-14', start: '10:00pm', end: '12:00am' }), REF)
    expect(r.valid).toBe(true)
    expect(r.text).toBe('Fri, Mar 13, 2026 · 10:00pm – 12:00am +1 · 2h 00m')
  })
})

describe('interpretEntry — unreadable input', () => {
  it('names an unreadable start date', () => {
    const r = interpretEntry(fields({ date: 'someday', start: '9:00', end: '10:00' }), REF)
    expect(r.valid).toBe(false)
    expect(r.text).toBe('Couldn\'t read “someday” as a date.')
  })

  it('names an unreadable end date', () => {
    const r = interpretEntry(fields({ endDate: 'never', start: '9:00', end: '10:00' }), REF)
    expect(r.valid).toBe(false)
    expect(r.text).toBe('Couldn\'t read “never” as an end date.')
  })

  it('asks for times when none are given', () => {
    const r = interpretEntry(fields({ date: '2026-03-13' }), REF)
    expect(r.valid).toBe(false)
    expect(r.text).toBe('Fri, Mar 13, 2026 · add a start + end, or a duration.')
  })
})
