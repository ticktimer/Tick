// Where an entry (or a running timer) is drawn on the calendar: one segment
// per visible day column it touches. An entry that runs past midnight gets a
// head on its start day, cut at the bottom, and a tail on each later day, cut
// at the top; a middle day, when one runs longer than a day, is cut at both.
// Pure so the split is unit-testable; Grid.vue turns segments into blocks.

export interface DaySegment {
  /** Index into the visible days. */
  dayIdx: number
  /** Minutes from that day's midnight, capped at a 24h column. */
  startMin: number
  endMin: number
  /** The entry began on an earlier day: the block continues from above. */
  cutTop: boolean
  /** The entry goes on past this day's midnight: the block continues below. */
  cutBottom: boolean
}

const DAY_MIN = 1440

/**
 * `dayStarts[i]`..`dayEnds[i]` are the real instants column `i` covers (a DST
 * day is 23 or 25 hours long, so the caller supplies both ends rather than a
 * flat 24h). Days the entry never touches produce nothing, so an empty result
 * means it is off screen. An end at exactly midnight belongs to the day before
 * it, and an end at or before the start (a timer that just started) still
 * yields a zero-length segment on the start day so the block is drawn.
 */
export function splitAcrossDays(
  startTs: number,
  endTs: number,
  dayStarts: readonly number[],
  dayEnds: readonly number[]
): DaySegment[] {
  const end = Math.max(startTs, endTs)
  const out: DaySegment[] = []
  for (let i = 0; i < dayStarts.length; i++) {
    const dayStart = dayStarts[i]!
    const dayEnd = dayEnds[i]!
    if (startTs >= dayEnd) continue
    if (end <= dayStart && startTs < dayStart) continue
    const segStart = Math.max(startTs, dayStart)
    const segEnd = Math.min(end, dayEnd)
    out.push({
      dayIdx: i,
      startMin: Math.min(DAY_MIN, (segStart - dayStart) / 60_000),
      endMin: Math.min(DAY_MIN, (segEnd - dayStart) / 60_000),
      cutTop: startTs < dayStart,
      cutBottom: end > dayEnd
    })
  }
  return out
}
