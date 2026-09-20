<script setup lang="ts">
// Calendar grid — week (7 cols) or day (1 col) at 48px/hour. Base window
// 7am–7pm; it extends to cover entries outside and the body scrolls (capped
// at the 12h height). Mouse interactions: drag empty space → ghost block +
// emit('create') on release; drag a block → move (across days in week view);
// drag its top/bottom 6px edge → resize; everything snaps to 5 minutes;
// Esc cancels an active drag; click without dragging = start again.
// Touch (unified pointer events, touch-action: manipulation so one-finger
// scroll keeps working): long-press 300ms on empty space → drag-create (a
// default 30-min ghost appears; dragging extends the end); long-press a
// block → drag moves it, releasing also "arms" it with ≥44px resize handles
// at its top/bottom edges (immediate drag, no second long-press); tap = start
// again, as on desktop. While a touch drag is live, touchmove is prevented
// (non-passive) so the browser never steals the gesture for scrolling.
// Every running timer renders as a live non-interactive block growing to now
// (ticktimer/Tick#37 — there can be several). Two live blocks that overlap in
// time simply overlap on the grid, exactly as two ended entries already do.
import type { EntryDto, TimerState } from '#shared/types'
import { MAX_RUNNING_TIMERS } from '#shared/utils/timers'

const HOUR_PX = 48
const SNAP = 5
const EDGE_PX = 6
const CLICK_SLOP_PX = 4
const LONG_PRESS_MS = 300
const TOUCH_SLOP_PX = 8
const TOUCH_DEFAULT_MIN = 30
const MAX_BODY_PX = 12 * HOUR_PX + 1
/** Breathing room above/below the grid so the edge hour labels aren't clipped. */
const GUTTER_PAD = 8

const emit = defineEmits<{ create: [payload: { day: number, startMin: number, endMin: number }] }>()

const calendar = useCalendarStore()
const { timeZone } = useTimeZone()
const timer = useTimerStore()
const toast = useToast()
const ui = useUiStore()

const gridEl = useTemplateRef<HTMLElement>('gridEl')
const scrollEl = useTemplateRef<HTMLElement>('scrollEl')

const now = ref(Date.now())
let nowHandle: ReturnType<typeof setInterval> | null = null
/** Coarse pointer (touch device) → render resize handles for the armed block. */
const isCoarse = ref(false)
/**
 * The now line is client-only: its position is wall-clock and timezone
 * dependent, so a server render lands a minute (or the server's UTC offset)
 * away from the browser's — a hydration style mismatch Vue never patches.
 */
const nowReady = ref(false)
onMounted(() => {
  now.value = Date.now()
  nowReady.value = true
  nowHandle = setInterval(() => (now.value = Date.now()), 30_000)
  isCoarse.value = window.matchMedia('(pointer: coarse)').matches
})
onBeforeUnmount(() => {
  if (nowHandle) clearInterval(nowHandle)
  cancelPress()
  teardownDrag()
})

/** Start of the day `t` falls on, in the user's zone (ticktimer/Tick#7). */
function dayStartOf(t: number): number {
  return startOfDayInstant(t, timeZone.value)
}

const cols = computed(() => `52px repeat(${calendar.dayCount}, minmax(0, 1fr))`)

// ── Visible hour window: 7am–7pm, stretched to cover out-of-range entries ───
const hourBounds = computed(() => {
  let h0 = 7
  let h1 = 19
  const consider = (startTs: number, endTs: number) => {
    const dayTs = dayStartOf(startTs)
    if (!calendar.days.includes(dayTs)) return
    h0 = Math.min(h0, Math.floor((startTs - dayTs) / 3_600_000))
    h1 = Math.max(h1, Math.ceil(Math.min(endTs - dayTs, 86_400_000) / 3_600_000))
  }
  for (const e of calendar.entries) {
    const s = new Date(e.start).getTime()
    consider(s, s + e.durationSec * 1000)
  }
  for (const t of timer.timers) {
    consider(new Date(t.start).getTime(), now.value)
  }
  return { h0: Math.max(0, h0), h1: Math.min(24, h1) }
})

const bodyH = computed(() => (hourBounds.value.h1 - hourBounds.value.h0) * HOUR_PX + 1)

const hours = computed(() => {
  const { h0, h1 } = hourBounds.value
  return Array.from({ length: h1 - h0 + 1 }, (_, i) => {
    const h = h0 + i
    return { top: i * HOUR_PX, label: `${(h % 12) || 12}${h < 12 || h === 24 ? 'am' : 'pm'}` }
  })
})

// Keep 7am at the top of the scroll window when the range or bounds change
watch(
  () => [calendar.rangeStart, calendar.view, hourBounds.value.h0],
  async () => {
    await nextTick()
    scrollEl.value?.scrollTo({ top: (7 - hourBounds.value.h0) * HOUR_PX })
  },
  { immediate: true }
)

// ── Day headers ─────────────────────────────────────────────────────────────
const headerDays = computed(() => calendar.days.map((dayTs) => {
  // Display-only shift: the column header names the user's day, not the host's.
  const d = zonedDate(dayTs, timeZone.value)
  const totalSec = calendar.entries.reduce((acc, e) => {
    return dayStartOf(new Date(e.start).getTime()) === dayTs ? acc + e.durationSec : acc
  }, 0)
  return {
    dayTs,
    wd: d.toLocaleDateString('en-US', { weekday: 'short' }),
    num: d.getDate(),
    total: totalSec ? formatDuration(totalSec) : '',
    isToday: dayTs === dayStartOf(now.value),
    isWeekend: d.getDay() === 0 || d.getDay() === 6
  }
}))

// ── Drag state machine ──────────────────────────────────────────────────────
type DragKind = 'create' | 'move' | 'resize-top' | 'resize-bottom'

interface DragState {
  kind: DragKind
  entry: EntryDto | null
  dayIdx: number
  startMin: number
  endMin: number
  /** create: fixed anchor minute · move: pointer minute offset from block start */
  anchorMin: number
  originX: number
  originY: number
  moved: boolean
  /** Touch-initiated drag: scroll is suppressed, create extends end-only. */
  touch: boolean
}

const drag = ref<DragState | null>(null)
const suppressClick = ref(false)
/** Entry id whose touch resize handles are showing (last long-pressed block). */
const armedId = ref<string | null>(null)

const snap = (m: number) => Math.round(m / SNAP) * SNAP
const clampMin = (m: number) => Math.min(hourBounds.value.h1 * 60, Math.max(hourBounds.value.h0 * 60, m))

/** Pointer Y → minute-of-day inside the (scrolled) grid body. */
function minuteAt(clientY: number): number {
  const rect = gridEl.value!.getBoundingClientRect()
  return hourBounds.value.h0 * 60 + ((clientY - rect.top) / HOUR_PX) * 60
}

/** Pointer X → visible day index (clamped). */
function dayIdxAt(clientX: number): number {
  const rect = gridEl.value!.getBoundingClientRect()
  const w = (rect.width - 52) / calendar.dayCount
  return Math.min(calendar.dayCount - 1, Math.max(0, Math.floor((clientX - rect.left - 52) / w)))
}

/** Non-passive touchmove preventer: keeps the browser from starting a scroll
 *  (which would pointercancel the drag) while a touch drag is live. */
function preventTouchMove(e: TouchEvent) {
  e.preventDefault()
}

/** Long-press context menu (Android) would break the pointer stream. */
function preventContextMenu(e: Event) {
  e.preventDefault()
}

function beginDrag(state: DragState) {
  drag.value = state
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', onDragUp)
  window.addEventListener('pointercancel', cancelDrag)
  window.addEventListener('keydown', onDragKey)
  if (state.touch) {
    window.addEventListener('touchmove', preventTouchMove, { passive: false })
    window.addEventListener('contextmenu', preventContextMenu)
  }
}

function teardownDrag() {
  drag.value = null
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragUp)
  window.removeEventListener('pointercancel', cancelDrag)
  window.removeEventListener('keydown', onDragKey)
  window.removeEventListener('touchmove', preventTouchMove)
  window.removeEventListener('contextmenu', preventContextMenu)
}

// ── Long-press arming (touch) ───────────────────────────────────────────────
// A touch pointerdown only *arms* a drag: nothing is prevented, so a finger
// that moves within 300ms scrolls normally (the browser's scroll fires
// pointercancel → the press is cancelled). Holding still for 300ms begins
// the drag from the pressed spot.
let pendingPress: {
  x: number
  y: number
  timer: ReturnType<typeof setTimeout>
} | null = null

function armPress(e: PointerEvent, begin: () => void) {
  cancelPress()
  pendingPress = {
    x: e.clientX,
    y: e.clientY,
    timer: setTimeout(() => {
      cancelPress()
      begin()
    }, LONG_PRESS_MS)
  }
  window.addEventListener('pointermove', onPressMove)
  window.addEventListener('pointerup', cancelPress)
  window.addEventListener('pointercancel', cancelPress)
}

function onPressMove(e: PointerEvent) {
  if (!pendingPress) return
  if (Math.abs(e.clientX - pendingPress.x) + Math.abs(e.clientY - pendingPress.y) > TOUCH_SLOP_PX) {
    cancelPress()
  }
}

function cancelPress() {
  if (!pendingPress) return
  clearTimeout(pendingPress.timer)
  pendingPress = null
  window.removeEventListener('pointermove', onPressMove)
  window.removeEventListener('pointerup', cancelPress)
  window.removeEventListener('pointercancel', cancelPress)
}

function cancelDrag() {
  teardownDrag()
}

function onDragKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    cancelDrag()
  }
}

function onColumnDown(dayIdx: number, e: PointerEvent) {
  if (drag.value) return
  if (e.pointerType === 'touch') {
    armedId.value = null // tap empty space clears the armed block
    const { clientX, clientY } = e
    armPress(e, () => {
      // Long-press create: seed a default 30-min ghost so the press gives
      // instant feedback; releasing without dragging still opens the dialog.
      const m = snap(clampMin(minuteAt(clientY)))
      beginDrag({
        kind: 'create',
        entry: null,
        dayIdx,
        startMin: m,
        endMin: Math.min(hourBounds.value.h1 * 60, m + TOUCH_DEFAULT_MIN),
        anchorMin: m,
        originX: clientX,
        originY: clientY,
        moved: true,
        touch: true
      })
    })
    return
  }
  if (e.button !== 0) return
  e.preventDefault()
  const m = snap(clampMin(minuteAt(e.clientY)))
  beginDrag({
    kind: 'create',
    entry: null,
    dayIdx,
    startMin: m,
    endMin: m,
    anchorMin: m,
    originX: e.clientX,
    originY: e.clientY,
    moved: false,
    touch: false
  })
}

/** Minute bounds of an entry within its own day. */
function entryMinutes(entry: EntryDto): { startMin: number, endMin: number } {
  const startTs = new Date(entry.start).getTime()
  const dayTs = dayStartOf(startTs)
  const startMin = (startTs - dayTs) / 60_000
  return { startMin, endMin: Math.min(1440, startMin + entry.durationSec / 60) }
}

function onBlockDown(entry: EntryDto, dayIdx: number, e: PointerEvent) {
  if (drag.value) return
  if (e.pointerType === 'touch') {
    e.stopPropagation()
    const { clientX, clientY } = e
    armPress(e, () => {
      // Long-press a block → move; releasing (moved or not) arms its handles.
      const { startMin, endMin } = entryMinutes(entry)
      beginDrag({
        kind: 'move',
        entry,
        dayIdx,
        startMin,
        endMin,
        anchorMin: minuteAt(clientY) - startMin,
        originX: clientX,
        originY: clientY,
        moved: false,
        touch: true
      })
    })
    return
  }
  if (e.button !== 0) return
  e.preventDefault()
  e.stopPropagation()
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const rel = e.clientY - rect.top
  const kind: DragKind = rel <= EDGE_PX ? 'resize-top' : rel >= rect.height - EDGE_PX ? 'resize-bottom' : 'move'
  const { startMin, endMin } = entryMinutes(entry)
  beginDrag({
    kind,
    entry,
    dayIdx,
    startMin,
    endMin,
    anchorMin: minuteAt(e.clientY) - startMin,
    originX: e.clientX,
    originY: e.clientY,
    moved: false,
    touch: false
  })
}

/** Armed block's ≥44px touch handles: resize starts on contact (the handle
 *  itself is the explicit intent — no second long-press needed). */
function onHandleDown(entry: EntryDto, dayIdx: number, kind: 'resize-top' | 'resize-bottom', e: PointerEvent) {
  if (drag.value) return
  e.preventDefault()
  e.stopPropagation()
  const { startMin, endMin } = entryMinutes(entry)
  beginDrag({
    kind,
    entry,
    dayIdx,
    startMin,
    endMin,
    anchorMin: 0,
    originX: e.clientX,
    originY: e.clientY,
    moved: true,
    touch: true
  })
}

function onDragMove(e: PointerEvent) {
  const d = drag.value
  if (!d) return
  if (Math.abs(e.clientX - d.originX) + Math.abs(e.clientY - d.originY) > CLICK_SLOP_PX) d.moved = true
  const m = minuteAt(e.clientY)
  if (d.kind === 'create') {
    const cur = snap(clampMin(m))
    if (d.touch) {
      // Touch create keeps its start anchored and drags the end out — the
      // seeded 30-min block never collapses under finger jitter.
      d.endMin = Math.max(d.anchorMin + SNAP, cur)
    } else {
      d.startMin = Math.min(d.anchorMin, cur)
      d.endMin = Math.max(d.anchorMin, cur)
    }
  } else if (d.kind === 'move') {
    const dur = d.endMin - d.startMin
    const s = Math.min((hourBounds.value.h1 * 60) - dur, Math.max(hourBounds.value.h0 * 60, snap(m - d.anchorMin)))
    d.startMin = s
    d.endMin = s + dur
    if (calendar.view === 'week') d.dayIdx = dayIdxAt(e.clientX)
  } else if (d.kind === 'resize-top') {
    d.startMin = Math.min(d.endMin - SNAP, snap(clampMin(m)))
  } else {
    d.endMin = Math.max(d.startMin + SNAP, snap(clampMin(m)))
  }
}

function onDragUp() {
  const d = drag.value
  teardownDrag()
  if (!d) return
  if (d.kind === 'create') {
    if (d.moved && d.endMin - d.startMin >= SNAP) {
      emit('create', { day: calendar.days[d.dayIdx]!, startMin: d.startMin, endMin: d.endMin })
    }
    return
  }
  if (!d.entry) return
  if (d.touch) {
    // Releasing a long-pressed block arms its resize handles; suppress the
    // trailing click so the long-press doesn't also "start again".
    armedId.value = d.entry.id
  }
  if (!d.moved && !d.touch) return
  suppressClick.value = true
  setTimeout(() => (suppressClick.value = false), 0)
  if (!d.moved) return
  const dayTs = calendar.days[d.dayIdx]!
  let start: number
  let end: number
  if (d.kind === 'move') {
    // Preserve the exact duration; only the (snapped) start moves
    const durMs = new Date(d.entry.end ?? d.entry.start).getTime() - new Date(d.entry.start).getTime()
    start = dayTs + d.startMin * 60_000
    end = start + durMs
  } else {
    start = dayTs + d.startMin * 60_000
    end = dayTs + d.endMin * 60_000
  }
  calendar
    .updateTimes(d.entry.id, new Date(start).toISOString(), new Date(end).toISOString())
    .catch(() => {
      toast.add({ title: 'Couldn’t save the change', description: 'The entry was put back.', color: 'neutral', icon: 'i-lucide-undo-2' })
    })
}

// ── Clicking a block opens it for editing (the Time page's dialog, mounted by
//    the calendar page). Starting the timer is the block's play button only —
//    a bare surface that silently starts tracking is too easy to hit. ───────
function openEntry(entry: EntryDto) {
  if (suppressClick.value) return
  ui.openEdit(entry)
}

const busy = ref(false)

/** Starts an ADDITIONAL timer for this block; nothing already running stops. */
async function startAgain(entry: EntryDto) {
  if (suppressClick.value || busy.value) return
  busy.value = true
  try {
    await timer.start({
      name: entry.name,
      refType: entry.ref?.refType,
      refId: entry.ref?.refId,
      billable: entry.billable
    })
  } catch (err) {
    if (isTimerCapError(err)) {
      toast.add({
        title: timerCapMessage(err),
        description: `Stop one of the ${MAX_RUNNING_TIMERS} running timers before starting another.`,
        icon: 'i-lucide-alarm-clock-off',
        color: 'neutral'
      })
    } else {
      await timer.hydrate()
    }
  } finally {
    busy.value = false
  }
}

// ── Block layout ────────────────────────────────────────────────────────────
type Lane = ReturnType<typeof assignLanes>[number]

interface Block {
  id: string
  entry: EntryDto
  top: number
  h: number
  billable: boolean
  name: string
  sub: string
  title: string
  dragging: boolean
}

function topOf(min: number): number {
  return (min - hourBounds.value.h0 * 60) * (HOUR_PX / 60) + 1
}

function heightOf(startMin: number, endMin: number): number {
  return Math.max(22, (endMin - startMin) * (HOUR_PX / 60) - 2)
}

function subFor(e: EntryDto): string {
  const r = e.ref
  const first = r?.taskName ?? r?.projectName ?? r?.clientName
  if (first) {
    return r!.clientName && r!.clientName !== first ? `${first} · ${r!.clientName}` : first
  }
  return e.tags.length ? '#' + e.tags.join(' #') : 'No project'
}

const dayBlocks = computed<Block[][]>(() => {
  const d = drag.value
  const draggingId = d && d.kind !== 'create' && d.moved ? d.entry?.id : null
  const byDay: Block[][] = calendar.days.map(() => [])

  for (const e of calendar.entries) {
    if (e.id === draggingId) continue
    const startTs = new Date(e.start).getTime()
    const di = calendar.days.indexOf(dayStartOf(startTs))
    if (di < 0) continue
    const startMin = (startTs - dayStartOf(startTs)) / 60_000
    const endMin = Math.min(1440, startMin + e.durationSec / 60)
    byDay[di]!.push({
      id: e.id,
      entry: e,
      top: topOf(startMin),
      h: heightOf(startMin, endMin),
      billable: e.billable,
      name: e.name,
      sub: subFor(e),
      title: `${e.name} · ${formatRange(e.start, e.end ?? e.start, timeZone.value)} · ${formatDuration(e.durationSec)}`,
      dragging: false
    })
  }

  // The block being moved/resized paints at its drag position
  if (d && draggingId && d.entry) {
    const dayTs = calendar.days[d.dayIdx]!
    byDay[d.dayIdx]!.push({
      id: d.entry.id,
      entry: d.entry,
      top: topOf(d.startMin),
      h: heightOf(d.startMin, d.endMin),
      billable: d.entry.billable,
      name: d.entry.name,
      sub: formatRange(dayTs + d.startMin * 60_000, dayTs + d.endMin * 60_000, timeZone.value),
      title: '',
      dragging: true
    })
  }
  return byDay
})

/** Ghost block while drag-creating. */
const ghost = computed(() => {
  const d = drag.value
  if (!d || d.kind !== 'create' || !d.moved || d.endMin <= d.startMin) return null
  const dayTs = calendar.days[d.dayIdx]!
  return {
    dayIdx: d.dayIdx,
    top: topOf(d.startMin),
    h: heightOf(d.startMin, d.endMin),
    label: formatRange(dayTs + d.startMin * 60_000, dayTs + d.endMin * 60_000, timeZone.value)
  }
})

/** Live blocks, one per running timer (non-draggable, each growing to now). */
interface RunningBlock {
  id: string
  dayIdx: number
  top: number
  h: number
  billable: boolean
  name: string
  sub: string
}

function runningBlockOf(t: TimerState): RunningBlock | null {
  const startTs = new Date(t.start).getTime()
  const dayTs = dayStartOf(startTs)
  const di = calendar.days.indexOf(dayTs)
  if (di < 0) return null
  const startMin = (startTs - dayTs) / 60_000
  const endTs = startTs + timer.elapsedFor(t.entryId) * 1000
  const endMin = Math.min(1440, (endTs - dayTs) / 60_000)
  return {
    id: t.entryId,
    dayIdx: di,
    top: topOf(startMin),
    h: heightOf(startMin, endMin),
    billable: t.billable,
    name: t.name || 'Untitled entry',
    sub: `${formatTime(startTs, timeZone.value)} – now`
  }
}

const runningBlocks = computed<RunningBlock[]>(() =>
  timer.timers.map(runningBlockOf).filter((b): b is RunningBlock => b !== null)
)

// ── Lanes ───────────────────────────────────────────────────────────────────
// Blocks that overlap in time share the column side by side (app/utils/lanes).
// Ended entries and running timers are laid out TOGETHER, per day: they occupy
// the same column, and with several timers at once (ticktimer/Tick#37) a
// running block over an ended one is the normal case, not an edge. Running
// blocks grow every second, so a cluster can widen as one of them reaches the
// next entry — that reflow is the point. Keyed by block id.
const COL_PAD = 3 // px each side — what inset-x-[3px] used to give every block
const LANE_GAP = 2 // px between neighbours; none when a block has the column to itself

const laneById = computed<Map<string, Lane>>(() => {
  const m = new Map<string, Lane>()
  calendar.days.forEach((_, di) => {
    const items: Array<{ id: string, top: number, h: number }> = [
      ...(dayBlocks.value[di] ?? []),
      ...runningBlocks.value.filter(b => b.dayIdx === di)
    ]
    const lanes = assignLanes(items)
    items.forEach((it, k) => m.set(it.id, lanes[k]!))
  })
  return m
})

/** `left` for a block's lane, as a CSS calc on the column width. */
function laneLeft(id: string): string {
  const { lane, lanes } = laneById.value.get(id) ?? { lane: 0, lanes: 1 }
  return `calc(${COL_PAD}px + ${lane} * ((100% - ${COL_PAD * 2}px) / ${lanes}))`
}

/** `width` for a block's lane — the full column less padding when alone. */
function laneWidth(id: string): string {
  const { lanes } = laneById.value.get(id) ?? { lane: 0, lanes: 1 }
  return lanes === 1
    ? `calc(100% - ${COL_PAD * 2}px)`
    : `calc((100% - ${COL_PAD * 2}px) / ${lanes} - ${LANE_GAP}px)`
}

/** `right` for something anchored to a block's right edge (the play button). */
function laneRight(id: string, inset: number): string {
  const { lane, lanes } = laneById.value.get(id) ?? { lane: 0, lanes: 1 }
  return `calc(${COL_PAD + inset}px + ${lanes - 1 - lane} * ((100% - ${COL_PAD * 2}px) / ${lanes}))`
}

/** Accent "now" line on today (only when inside the visible window). */
const nowLine = computed(() => {
  const di = calendar.days.indexOf(dayStartOf(now.value))
  if (di < 0) return null
  const d = new Date(now.value)
  const min = d.getHours() * 60 + d.getMinutes()
  if (min < hourBounds.value.h0 * 60 || min > hourBounds.value.h1 * 60) return null
  return { dayIdx: di, top: topOf(min) }
})

function blockBg(billable: boolean): string {
  return billable
    ? 'color-mix(in srgb, var(--ui-primary) 16%, var(--ui-bg-elevated))'
    : 'color-mix(in srgb, var(--ui-color-neutral-400) 14%, var(--ui-bg-elevated))'
}

function blockEdge(billable: boolean): string {
  return billable ? 'var(--ui-primary)' : 'var(--ui-color-neutral-500)'
}
</script>

<template>
  <div class="overflow-hidden rounded-lg bg-elevated shadow-sm ring ring-default">
    <!-- Day headers -->
    <div class="grid border-b border-default" :style="{ gridTemplateColumns: cols }">
      <div />
      <div
        v-for="d in headerDays"
        :key="d.dayTs"
        class="flex flex-col gap-0.5 px-2 pt-2.5 pb-2"
        style="border-left: 1px solid color-mix(in srgb, var(--ui-text) 6%, transparent)"
      >
        <span
          class="text-[11px] uppercase tracking-[.06em]"
          :class="d.isToday ? 'text-primary' : 'text-muted'"
        >{{ d.wd }}</span>
        <span class="flex items-baseline gap-2">
          <span
            class="tnum -ml-1.5 grid size-7 place-items-center rounded-full text-lg font-medium"
            :class="d.isToday ? 'text-primary ring ring-inset ring-primary' : 'text-highlighted'"
          >{{ d.num }}</span>
          <span class="tnum text-[11px] text-muted">{{ d.total }}</span>
        </span>
      </div>
    </div>

    <!-- Body (scrolls when the hour window outgrows 12h).
         GUTTER_PAD block padding keeps the first/last hour labels (centred on
         their rule, so half of each sits outside the grid box) from being
         clipped by this scroller / the card's overflow-hidden. -->
    <div
      ref="scrollEl"
      class="overflow-y-auto"
      :style="{ maxHeight: MAX_BODY_PX + GUTTER_PAD * 2 + 'px', paddingBlock: GUTTER_PAD + 'px' }"
    >
      <div
        ref="gridEl"
        class="relative grid select-none"
        :style="{ gridTemplateColumns: cols, height: bodyH + 'px', touchAction: 'manipulation' }"
      >
        <!-- Hour gutter -->
        <div class="relative">
          <span
            v-for="h in hours"
            :key="h.label"
            class="tnum absolute right-2 -translate-y-1/2 text-[10px] text-muted"
            :style="{ top: h.top + 'px' }"
          >{{ h.label }}</span>
        </div>

        <!-- Day columns -->
        <div
          v-for="(d, di) in headerDays"
          :key="d.dayTs"
          class="relative"
          :style="{
            borderLeft: '1px solid color-mix(in srgb, var(--ui-text) 6%, transparent)',
            background: d.isWeekend ? 'color-mix(in srgb, var(--ui-text) 2%, transparent)' : 'transparent'
          }"
          @pointerdown="onColumnDown(di, $event)"
        >
          <!-- Hour rules -->
          <span
            v-for="h in hours"
            :key="h.top"
            class="pointer-events-none absolute inset-x-0 h-px"
            :style="{ top: h.top + 'px', background: 'color-mix(in srgb, var(--ui-text) 5%, transparent)' }"
          />

          <!-- Entry blocks -->
          <template v-for="b in dayBlocks[di]" :key="b.id">
            <button
              type="button"
              :title="b.title || undefined"
              :aria-label="b.title ? `${b.name} · ${d.wd} ${d.num}${b.title.slice(b.name.length)} · ${b.sub}` : undefined"
              class="absolute flex flex-col gap-px overflow-hidden rounded-sm py-1 pl-1.5 pr-7 text-left transition-[filter] hover:brightness-[1.12] focus-visible:z-10 focus-visible:outline-offset-1"
              :class="[
                b.dragging ? 'z-10 cursor-grabbing opacity-90 shadow-md' : 'cursor-grab',
                isCoarse && armedId === b.id && !b.dragging ? 'ring ring-primary/60' : ''
              ]"
              :style="{
                top: b.top + 'px',
                height: b.h + 'px',
                left: laneLeft(b.id),
                width: laneWidth(b.id),
                background: blockBg(b.billable),
                borderLeft: `2px solid ${blockEdge(b.billable)}`
              }"
              @pointerdown="onBlockDown(b.entry, di, $event)"
              @click="openEntry(b.entry)"
            >
              <span class="pointer-events-none absolute inset-x-0 top-0 h-[6px] cursor-ns-resize" />
              <span class="truncate text-[11px] font-medium leading-[1.25] text-highlighted">{{ b.name }}</span>
              <span class="tnum truncate text-[10px] text-toned">{{ b.sub }}</span>
              <span class="pointer-events-none absolute inset-x-0 bottom-0 h-[6px] cursor-ns-resize" />
            </button>

            <!-- Start again — the only way a block starts the timer. A sibling
                 of the block (buttons can't nest) positioned over its right
                 edge; pointerdown is swallowed so it never begins a drag. -->
            <button
              v-if="!b.dragging"
              type="button"
              :aria-label="`Start timer for ${b.name}`"
              :title="`Start timer for ${b.name}`"
              class="absolute z-20 grid place-items-center rounded-full bg-default/85 text-primary ring-1 ring-primary/50 backdrop-blur-[2px] transition hover:bg-default hover:ring-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ui-primary)]"
              :class="b.h >= 34 ? 'size-[22px]' : 'size-[18px]'"
              :style="{ top: (b.top + (b.h - (b.h >= 34 ? 22 : 18)) / 2) + 'px', right: laneRight(b.id, 2) }"
              @pointerdown.stop
              @click.stop="startAgain(b.entry)"
            >
              <UIcon name="i-lucide-play" :class="b.h >= 34 ? 'size-3' : 'size-2.5'" />
            </button>

            <!-- Touch resize handles (armed block only): 44px hit areas whose
                 dot centers on the block edge; drag starts on contact -->
            <template v-if="isCoarse && armedId === b.id && !b.dragging">
              <span
                class="absolute z-30 grid size-11 -translate-x-1/2 touch-none place-items-center"
                :style="{ top: (b.top - 22) + 'px', left: `calc(${laneLeft(b.id)} + ${laneWidth(b.id)} * 0.25)` }"
                aria-hidden="true"
                @pointerdown="onHandleDown(b.entry, di, 'resize-top', $event)"
              >
                <span class="size-3 rounded-full bg-default ring-2 ring-primary" />
              </span>
              <span
                class="absolute z-30 grid size-11 -translate-x-1/2 touch-none place-items-center"
                :style="{ top: (b.top + b.h - 22) + 'px', left: `calc(${laneLeft(b.id)} + ${laneWidth(b.id)} * 0.75)` }"
                aria-hidden="true"
                @pointerdown="onHandleDown(b.entry, di, 'resize-bottom', $event)"
              >
                <span class="size-3 rounded-full bg-default ring-2 ring-primary" />
              </span>
            </template>
          </template>

          <!-- Running timers: live, non-interactive. Several at once take
               lanes beside each other and beside any ended entry they overlap. -->
          <div
            v-for="rb in runningBlocks.filter(b => b.dayIdx === di)"
            :key="rb.id"
            :title="`${rb.name} · ${rb.sub}`"
            class="pointer-events-none absolute z-[5] flex flex-col gap-px overflow-hidden rounded-sm px-1.5 py-1"
            :style="{
              top: rb.top + 'px',
              height: rb.h + 'px',
              left: laneLeft(rb.id),
              width: laneWidth(rb.id),
              background: blockBg(rb.billable),
              borderLeft: '2px solid var(--ui-primary)',
              boxShadow: '0 0 8px color-mix(in srgb, var(--ui-primary) 45%, transparent)'
            }"
          >
            <span class="truncate text-[11px] font-medium leading-[1.25] text-highlighted">{{ rb.name }}</span>
            <span class="tnum truncate text-[10px] text-primary">{{ rb.sub }}</span>
          </div>

          <!-- Drag-to-create ghost -->
          <div
            v-if="ghost && ghost.dayIdx === di"
            class="pointer-events-none absolute inset-x-[3px] z-10 flex flex-col justify-start overflow-hidden rounded-sm px-1.5 py-1 ring ring-inset ring-primary/60"
            :style="{
              top: ghost.top + 'px',
              height: ghost.h + 'px',
              background: 'color-mix(in srgb, var(--ui-primary) 10%, transparent)'
            }"
          >
            <span class="tnum text-[10px] font-medium text-primary">{{ ghost.label }}</span>
          </div>

          <!-- Now line -->
          <span
            v-if="nowReady && nowLine && nowLine.dayIdx === di"
            class="pointer-events-none absolute inset-x-0 z-20 h-px bg-primary"
            :style="{ top: nowLine.top + 'px', boxShadow: '0 0 6px var(--ui-primary)' }"
          >
            <span class="absolute -left-[3px] -top-[2.5px] size-1.5 rounded-full bg-primary" />
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
