// Calendar store — visible range (week or day), anchor date, and the entries
// for that range. Week starts Monday. `view` is exposed so mobile can default
// to 'day' later. Move/resize commits optimistically and reverts on error;
// the server stays the source of truth for duration/amount (Rule 2).

export type CalendarView = 'week' | 'day'

export const useCalendarStore = defineStore('calendar', () => {
  // SSR-safe fetch: forwards the request's cookies during server render;
  // plain $fetch on the client.
  const requestFetch = useRequestFetch()

  // Every boundary below is a day in the *user's* zone, resolved to a real
  // instant. Using the runtime's own midnights made the server render a
  // different week from the browser (ticktimer/Tick#7, and the empty grid in
  // #29); these agree on both sides because both read the same zone.
  const { timeZone } = useTimeZone()

  /** Start-of-day (ms) of the day `d` falls on, in the user's zone. */
  function dayStart(d: Date | number): number {
    return startOfDayInstant(d, timeZone.value)
  }

  /** `n` calendar days on — 25 hours across a DST end, not a flat 24. */
  function addDays(t: number, n: number): number {
    return addDaysInstant(t, timeZone.value, n)
  }

  /** Monday 00:00 of the week containing t. */
  function mondayOf(t: number): number {
    return addDays(t, -((zonedDate(t, timeZone.value).getDay() + 6) % 7))
  }

  const view = ref<CalendarView>('week')
  /** Start-of-day (ms) the visible range anchors on. */
  const anchor = ref<number>(dayStart(new Date()))
  const entries = ref<EntryDto[]>([])
  const loading = ref(false)

  const rangeStart = computed(() => view.value === 'week' ? mondayOf(anchor.value) : anchor.value)
  const dayCount = computed(() => view.value === 'week' ? 7 : 1)
  const rangeEnd = computed(() => addDays(rangeStart.value, dayCount.value))
  /** Start-of-day timestamps of the visible columns. */
  const days = computed(() => Array.from({ length: dayCount.value }, (_, i) => addDays(rangeStart.value, i)))
  /** Whole weeks between the visible week and the current one (README state: weekOffset). */
  const weekOffset = computed(() =>
    Math.round((mondayOf(anchor.value) - mondayOf(dayStart(new Date()))) / (7 * 86_400_000))
  )

  function prev() {
    anchor.value = view.value === 'week' ? addDays(mondayOf(anchor.value), -7) : addDays(anchor.value, -1)
  }

  function next() {
    anchor.value = view.value === 'week' ? addDays(mondayOf(anchor.value), 7) : addDays(anchor.value, 1)
  }

  function today() {
    anchor.value = dayStart(new Date())
  }

  /**
   * Re-anchor when the browser's timezone arrives.
   *
   * On a cold load there is no timezone cookie yet, so SSR anchors on the
   * server's midnight and the client hydrates with that same value (no
   * mismatch). The plugin then supplies the browser's zone — at which point the
   * server's midnight reads as a different calendar day, and the grid would show
   * the day the server guessed: yesterday for anyone west of it, and a whole
   * week out when the server's day is a Monday (ticktimer/Tick#29, #7).
   *
   * The anchor is always "today" by construction at that point — the flip lands
   * in the same tick as hydration, before the user can page anywhere — so
   * recomputing it from the clock is exact. It also does the right thing later
   * for a laptop that changes zones mid-session.
   */
  watch(timeZone, () => {
    anchor.value = dayStart(new Date())
  })

  function setView(v: CalendarView) {
    view.value = v
  }

  /** Does an entry touch the visible range? Its tail counts even when it started before. */
  function inRange(dto: EntryDto): boolean {
    const start = new Date(dto.start).getTime()
    const end = new Date(dto.end ?? dto.start).getTime()
    return start < rangeEnd.value && end > rangeStart.value
  }

  /**
   * GET /api/entries for the visible range (running + trashed excluded
   * server-side). `overlap` brings in entries that started before the range
   * and end inside it — the tail of one that ran past midnight is drawn on
   * the day it ended.
   */
  async function fetchRange() {
    loading.value = true
    try {
      entries.value = await requestFetch<EntryDto[]>('/api/entries', {
        query: { from: new Date(rangeStart.value).toISOString(), to: new Date(rangeEnd.value).toISOString(), overlap: '1' }
      })
    } finally {
      loading.value = false
    }
  }

  /** POST /api/entries (drag-to-create dialog). Keeps the new block in range. */
  async function create(payload: {
    name: string
    refType?: RefType
    refId?: string
    billable?: boolean
    start: string
    end: string
    tags?: string[]
  }) {
    const dto = await $fetch<EntryDto>('/api/entries', { method: 'POST', body: payload })
    if (inRange(dto)) entries.value.push(dto)
    return dto
  }

  /**
   * PATCH /api/entries/:id {start,end} after a drag-move / edge-resize.
   * Optimistic: the block paints at its new slot immediately; on failure the
   * snapshot is restored and the error rethrown for the caller to surface.
   */
  async function updateTimes(id: string, start: string, end: string) {
    const i = entries.value.findIndex(e => e.id === id)
    if (i < 0) return null
    const prevDto = entries.value[i]!
    const durationSec = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000)
    entries.value.splice(i, 1, { ...prevDto, start, end, durationSec })
    try {
      const dto = await $fetch<EntryDto>(`/api/entries/${id}`, { method: 'PATCH', body: { start, end } })
      const j = entries.value.findIndex(e => e.id === id)
      if (j >= 0) entries.value.splice(j, 1, dto)
      return dto
    } catch (err) {
      const j = entries.value.findIndex(e => e.id === id)
      if (j >= 0) entries.value.splice(j, 1, prevDto)
      throw err
    }
  }

  return {
    view,
    anchor,
    entries,
    loading,
    rangeStart,
    rangeEnd,
    dayCount,
    days,
    weekOffset,
    prev,
    next,
    today,
    setView,
    fetchRange,
    create,
    updateTimes
  }
})
