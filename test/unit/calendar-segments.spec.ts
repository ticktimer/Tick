// How the calendar splits an entry across the day columns it touches.
import { describe, expect, it } from 'vitest'
import { splitAcrossDays } from '../../app/utils/calendar-segments'

const H = 3_600_000
/** Three flat 24h days starting at t=0. */
const DAYS = [0, 24 * H, 48 * H]
const ENDS = [24 * H, 48 * H, 72 * H]

const at = (h: number, m = 0) => h * H + m * 60_000

describe('splitAcrossDays', () => {
  it('keeps a same-day entry in one uncut segment', () => {
    expect(splitAcrossDays(at(9), at(11, 30), DAYS, ENDS)).toEqual([
      { dayIdx: 0, startMin: 540, endMin: 690, cutTop: false, cutBottom: false }
    ])
  })

  it('splits an entry that runs past midnight into a cut head and a cut tail', () => {
    expect(splitAcrossDays(at(23, 30), at(25, 15), DAYS, ENDS)).toEqual([
      { dayIdx: 0, startMin: 1410, endMin: 1440, cutTop: false, cutBottom: true },
      { dayIdx: 1, startMin: 0, endMin: 75, cutTop: true, cutBottom: false }
    ])
  })

  it('cuts a middle day at both ends when an entry runs longer than a day', () => {
    expect(splitAcrossDays(at(22), at(50), DAYS, ENDS)).toEqual([
      { dayIdx: 0, startMin: 1320, endMin: 1440, cutTop: false, cutBottom: true },
      { dayIdx: 1, startMin: 0, endMin: 1440, cutTop: true, cutBottom: true },
      { dayIdx: 2, startMin: 0, endMin: 120, cutTop: true, cutBottom: false }
    ])
  })

  it('an end at exactly midnight stays on the day before it', () => {
    expect(splitAcrossDays(at(22), at(24), DAYS, ENDS)).toEqual([
      { dayIdx: 0, startMin: 1320, endMin: 1440, cutTop: false, cutBottom: false }
    ])
  })

  it('shows only the tail when the entry started before the visible days', () => {
    expect(splitAcrossDays(at(-2), at(1), DAYS, ENDS)).toEqual([
      { dayIdx: 0, startMin: 0, endMin: 60, cutTop: true, cutBottom: false }
    ])
  })

  it('shows only the head, cut, when the entry ends after the visible days', () => {
    expect(splitAcrossDays(at(71), at(74), DAYS, ENDS)).toEqual([
      { dayIdx: 2, startMin: 1380, endMin: 1440, cutTop: false, cutBottom: true }
    ])
  })

  it('returns nothing for an entry outside the visible days', () => {
    expect(splitAcrossDays(at(80), at(82), DAYS, ENDS)).toEqual([])
    expect(splitAcrossDays(at(-5), at(-1), DAYS, ENDS)).toEqual([])
  })

  it('a just-started timer is a zero-length segment on its day', () => {
    expect(splitAcrossDays(at(9), at(9), DAYS, ENDS)).toEqual([
      { dayIdx: 0, startMin: 540, endMin: 540, cutTop: false, cutBottom: false }
    ])
    // Even at midnight sharp, where the previous day ends and this one starts
    expect(splitAcrossDays(at(24), at(24), DAYS, ENDS)).toEqual([
      { dayIdx: 1, startMin: 0, endMin: 0, cutTop: false, cutBottom: false }
    ])
  })

  it('reads minutes off each day\'s own midnight on a 25-hour DST day', () => {
    // Day 1 is 25h long: it ends at 49h, and day 2 runs 49h → 73h.
    const starts = [0, 24 * H, 49 * H]
    const ends = [24 * H, 49 * H, 73 * H]
    expect(splitAcrossDays(at(48, 30), at(50), starts, ends)).toEqual([
      { dayIdx: 1, startMin: 1440, endMin: 1440, cutTop: false, cutBottom: true },
      { dayIdx: 2, startMin: 0, endMin: 60, cutTop: true, cutBottom: false }
    ])
  })
})
