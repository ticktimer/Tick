// The calendar's "fold" — one block standing in for a cluster of overlapping
// entries whose lanes would be too narrow to carry a name (ticktimer/Tick#37).
// Types only; Grid.vue builds folds from app/utils/lanes.ts's cluster spans,
// CalendarClusterList renders one. Kept here so both sides share one shape.

import type { EntryDto } from '#shared/types'

/** An ended entry inside a fold: editable, restartable. */
export interface FoldEntryMember {
  kind: 'entry'
  entry: EntryDto
  name: string
  /** Chain or tags, as subFor() prints under a block. */
  sub: string
  /** "3:00pm – 5:00pm", in the browser's zone. */
  range: string
  /** "2h 00m". */
  duration: string
  clientColor?: string
}

/** A running timer inside a fold: display-only here, tap-to-select in the list. */
export interface FoldTimerMember {
  kind: 'timer'
  /** The running entry's id (TimerState.entryId). */
  id: string
  name: string
  sub: string
  /** "9:05am – now". */
  range: string
  clientColor?: string
}

export type FoldMember = FoldEntryMember | FoldTimerMember

export interface Fold {
  /** `${dayTs}:${cluster}` — stable while the cluster exists. */
  id: string
  /** Index into calendar.days. */
  dayIdx: number
  /** Px from the top of the day column, as topOf() gives a block. */
  top: number
  /** Px; never under the 22px block minimum. */
  h: number
  /** Members sorted start ASC, then id ASC. */
  members: FoldMember[]
  count: number
  /** How many members are running timers. */
  running: number
  /** True only when every member is billable — drives blockBg/blockEdge. */
  billable: boolean
  /** "9:05am – 11:20am" (or "– now" when a timer runs), the cluster's envelope. */
  rangeText: string
}

/**
 * CalendarClusterList (app/components/calendar/ClusterList.vue) — the popover
 * body that opens from a fold. Contract:
 *
 *   props:  { fold: Fold, dayLabel: string }      // dayLabel e.g. "Sat 12"
 *   emits:  edit(entry: EntryDto)                 // an ended row's body was pressed
 *           start(entry: EntryDto)                // an ended row's ▶ was pressed
 *           show(timerId: string)                 // a running row's body was pressed
 *
 * The list never starts, edits or selects anything itself; Grid.vue owns those
 * handlers (startAgain, ui.openEdit, timer.pin + timer.openList).
 */
export type ClusterListEmits = {
  edit: [entry: EntryDto]
  start: [entry: EntryDto]
  show: [timerId: string]
}
