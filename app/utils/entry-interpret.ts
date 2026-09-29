// Reads the Manual-entry / calendar-create dialog's free-text fields into a
// start + end instant plus the live interpretation line shown under them.
// Pure so both dialogs share one reading of the fields and it is unit-testable.
//
// Dates come from parseDate (local midnight); times and durations are minutes.
// An entry may end on a later day than it starts — a timer left running past
// midnight — so `endDate` names that day; blank means the start day.
import { formatDateLong, formatDuration, formatRange } from './format'
import { parseDate, parseDuration, parseTime } from './parse'

export interface EntryFields {
  /** Start date, free text; blank = today. */
  date: string
  /** End date, free text; blank = the start day. */
  endDate: string
  /** Start time ("9:00", "2pm"). */
  start: string
  /** End time. */
  end: string
  /** Alternative to an end time ("2h 30m"). */
  duration: string
}

export interface EntryInterpretation {
  valid: boolean
  /** What will be saved, or what is still missing. */
  text: string
  start?: Date
  end?: Date
}

/** Local wall time `minutes` past midnight on day `d` — rolls into later days past 24h. */
function at(d: Date, minutes: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, minutes)
}

function ok(start: Date, end: Date, text: string): EntryInterpretation {
  return { valid: true, start, end, text }
}

/**
 * Precedence: start + end time → start + duration → duration alone (from
 * 9:00). Start + end only counts when the end instant is after the start one,
 * so a later end *date* is what carries an entry across midnight.
 */
export function interpretEntry(f: EntryFields, ref: Date = new Date()): EntryInterpretation {
  const day = parseDate(f.date, ref)
  if (!day) return { valid: false, text: `Couldn't read “${f.date.trim()}” as a date.` }
  const endDay = f.endDate.trim() ? parseDate(f.endDate, ref) : day
  if (!endDay) return { valid: false, text: `Couldn't read “${f.endDate.trim()}” as an end date.` }

  const dateStr = formatDateLong(day)
  const start = parseTime(f.start)
  const end = parseTime(f.end)
  const dur = parseDuration(f.duration)

  if (start != null && end != null) {
    const s = at(day, start)
    const e = at(endDay, end)
    if (e > s) return ok(s, e, `${dateStr} · ${formatRange(s, e)} · ${formatDuration((e.getTime() - s.getTime()) / 1000)}`)
  }
  if (dur != null && dur > 0 && start != null) {
    const s = at(day, start)
    const e = at(day, start + dur)
    return ok(s, e, `${dateStr} · ${formatRange(s, e)} · ${formatDuration(dur * 60)}`)
  }
  if (dur != null && dur > 0) {
    const s = at(day, 9 * 60)
    const e = at(day, 9 * 60 + dur)
    return ok(s, e, `${dateStr} · ${formatDuration(dur * 60)} (no start time — logged from 9:00)`)
  }
  if (start != null && end != null) {
    const hint = endDay.getTime() === day.getTime() ? ' — add an End date to cross midnight' : ''
    return { valid: false, text: `${dateStr} · end must be after start${hint}.` }
  }
  return { valid: false, text: `${dateStr} · add a start + end, or a duration.` }
}
