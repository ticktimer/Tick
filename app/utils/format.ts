// Display formatters — pure functions, unit-testable.
// Locale is pinned to en-US so SSR and client render identically.
//
// Anything that reads a clock takes an optional IANA `tz`. Without it these read
// the *runtime's* local fields, which on the server is the container's zone —
// the hydration mismatch in ticktimer/Tick#7. Callers that render during SSR
// pass the zone from useTimeZone(); see app/utils/tz.ts for why shifting the
// Date is enough to make every existing format string correct.
import { zonedDate } from './tz'

const DAY_MS = 86_400_000

/** Shift into `tz` for display when one was given; otherwise leave it alone. */
function inZone(d: Date | string | number, tz?: string): Date {
  return tz ? zonedDate(d, tz) : new Date(d)
}

/**
 * Map a server client-color token ("primary-400", "neutral-400") to a paintable
 * CSS value via Nuxt UI's ramp vars. Passes through values that are already CSS.
 */
export function clientColorVar(token: string | null | undefined, fallback = 'var(--ui-border-accented)'): string {
  if (!token) return fallback
  if (/^(#|var\(|rgb|hsl|oklch|color-mix)/.test(token)) return token
  return `var(--ui-color-${token})`
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** Seconds → "2h 15m" / "30m". Minutes are zero-padded when hours are present ("1h 05m"). */
export function formatDuration(sec: number): string {
  const totalMin = Math.round(Math.max(0, sec) / 60)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

/** Seconds → "01:23:45" (timer-bar clock). */
export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map(v => String(v).padStart(2, '0'))
    .join(':')
}

/** Date-ish → "9:05am", in `tz` when given. */
export function formatTime(d: Date | string | number, tz?: string): string {
  const date = inZone(d, tz)
  let h = date.getHours()
  const m = date.getMinutes()
  const ap = h >= 12 ? 'pm' : 'am'
  h = h % 12 || 12
  return `${h}:${String(m).padStart(2, '0')}${ap}`
}

/**
 * "9:05am – 11:20am". An end on a later calendar day (in `tz`) is marked with
 * the day count, "11:30pm – 1:15am +1", so a cross-midnight entry doesn't read
 * as ending before it started.
 */
export function formatRange(
  start: Date | string | number,
  end: Date | string | number,
  tz?: string
): string {
  const s = inZone(start, tz)
  const e = inZone(end, tz)
  const days = Math.round((startOfDay(e).getTime() - startOfDay(s).getTime()) / DAY_MS)
  return `${formatTime(s)} – ${formatTime(e)}${days > 0 ? ` +${days}` : ''}`
}

/** "$3,699" — rounded to whole dollars. */
export function formatMoney(n: number): string {
  return '$' + Math.round(n).toLocaleString('en-US')
}

/**
 * Day-group label: Today · Yesterday · weekday name (<7 days ago) ·
 * "Wed, Sep 2" (plus year when it differs from the reference year).
 */
export function formatDayLabel(
  d: Date | string | number,
  ref: Date = new Date(),
  tz?: string
): string {
  const date = inZone(d, tz)
  // "Today" has to mean today *where the user is*, so the reference shifts too.
  const refDate = inZone(ref, tz)
  const diff = Math.round((startOfDay(refDate).getTime() - startOfDay(date).getTime()) / DAY_MS)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  if (diff > 1 && diff < 7) return date.toLocaleDateString('en-US', { weekday: 'long' })
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== refDate.getFullYear() ? 'numeric' : undefined
  })
}

/** "Sep 11" — the muted date beside a day-group label. */
export function formatDaySub(d: Date | string | number, tz?: string): string {
  return inZone(d, tz).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** "Fri, Sep 11, 2026" — manual-entry interpretation line. */
export function formatDateLong(d: Date | string | number, tz?: string): string {
  return inZone(d, tz).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
}

/** Estimate minutes → "40h" / "2h 30m". */
export function formatEstimate(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60}h` : formatDuration(minutes * 60)
}
