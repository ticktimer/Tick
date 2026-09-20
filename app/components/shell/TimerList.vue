<script setup lang="ts">
// The running list (ticktimer/Tick#37) — one row per running timer, shared by
// the desktop bar's disclosure and the mobile dock's overlay. Rows are rendered
// in the server's order (start ASC, id ASC) and are never re-sorted on the
// client, so a row can't jump under the finger when another timer starts.
//
// Tapping a row selects it: the selected timer is the one the bar shows, and
// it stays there when a newer one starts (the store calls that the pin; the
// list never says the word). The selected row is *marked*, not moved:
// aria-current="true" for screen readers, a primary ring for everyone else.
// Without a selection the bar follows the newest timer, as before.
//
// The mark is an edge, not a fill. A bg-primary/10 wash put the row's accent
// clock at 1.72:1 in Daylight and left the passing cases a hair over the line;
// it also broke "accent never a large fill" ten rows over. An unfilled ring
// marks one row just as clearly and leaves every text token on the surface it
// was measured against.
//
// Every clock here reads the store's single shared `nowMs`. Ten rows are ten
// derived values, not ten intervals.
import type { TimerState } from '#shared/types'

defineProps<{
  /** id of the <ul>, referenced by the opener's aria-controls. Two instances of
   *  this component are mounted at once (desktop bar + mobile dock, one of them
   *  CSS-hidden), so the id has to come from outside — it can't be a literal. */
  listId: string
}>()

const timer = useTimerStore()
const entries = useEntriesStore()
const calendar = useCalendarStore()
const route = useRoute()

/** Deepest-first chain, same reading order as the bar's chip and the entry rows. */
function chainLabel(t: TimerState): string {
  const r = t.ref
  if (!r) return ''
  return [r.taskName, r.projectName, r.clientName].filter(Boolean).join(' · ')
}

function displayName(t: TimerState): string {
  return t.name || 'Untitled'
}

/** One stop in flight at a time — a double tap must not fire two of them. */
const stopping = ref<string | null>(null)

async function stopOne(t: TimerState) {
  if (stopping.value) return
  stopping.value = t.entryId
  try {
    const dto = await timer.stop(t.entryId)
    // <1s elapsed returns null (discarded server-side); otherwise the row lands
    // at the top of Today. No navigation — stopping one of several timers from
    // a list is not a reason to leave the page you are on, unlike the bar's
    // single stop, which is the end of the thing you were doing.
    if (dto) {
      entries.applyStoppedEntry(dto)
      // The grid doesn't read the entries store, so on /calendar the live block
      // would just vanish until something else refetched the range.
      if (route.path === '/calendar') calendar.fetchRange().catch(() => {})
    }
  } catch {
    // 404 (already stopped elsewhere) and friends: let the server win.
    await timer.hydrate()
  } finally {
    stopping.value = null
  }
}

/**
 * Tap-to-select — always a pin, even for the row already in the bar. "Already
 * in the bar" may only mean "newest"; tapping it is what makes it *stay* there
 * when the next timer starts. Skipping the pin in that case looked like a
 * no-op and silently wasn't one.
 */
function select(t: TimerState) {
  timer.pin(t.entryId)
}
</script>

<template>
  <ul :id="listId" class="flex flex-col gap-px" aria-label="Running timers">
    <li
      v-for="t in timer.timers"
      :key="t.entryId"
      :aria-current="timer.activeTimer?.entryId === t.entryId ? 'true' : undefined"
      class="flex items-center gap-2 rounded-md py-1.5 pr-1 pl-2.5"
      :class="timer.activeTimer?.entryId === t.entryId
        ? 'ring-1 ring-primary/60 ring-inset'
        : 'hover:bg-[color-mix(in_srgb,var(--ui-text)_5%,transparent)]'"
    >
      <!-- The row's body is the select control — everything but the stop
           button. Name with the chain underneath: the same dot + muted text as
           an entry row, because ten accent chips stacked down a list would
           out-shout the selected-row ring, and the bar is meant to stay the
           accented surface. 44px tall under lg, so it is a real touch target. -->
      <button
        type="button"
        :aria-label="`Show ${displayName(t)} in the timer bar`"
        :title="timer.activeTimer?.entryId === t.entryId ? 'Shown in the timer bar' : 'Show in the timer bar'"
        class="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-1 focus-visible:ring-primary lg:min-h-[30px]"
        @click="select(t)"
      >
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="truncate text-[13px] text-highlighted">{{ displayName(t) }}</span>
          <span v-if="chainLabel(t)" class="flex min-w-0 items-center gap-1.5 text-[11px] text-muted">
            <span class="size-[6px] shrink-0 rounded-full" :style="{ background: clientColorVar(t.ref?.clientColor) }" />
            <span class="truncate">{{ chainLabel(t) }}</span>
          </span>
        </span>

        <span
          class="tnum shrink-0 pr-1 text-[13px] font-medium tracking-[0.01em]"
          :class="timer.activeTimer?.entryId === t.entryId ? 'text-primary dark:text-primary-300' : 'text-toned'"
        >{{ formatClock(timer.elapsedFor(t.entryId)) }}</span>
      </button>

      <UButton
        icon="i-lucide-square"
        color="primary"
        variant="outline"
        square
        :loading="stopping === t.entryId"
        :aria-label="`Stop ${displayName(t)}`"
        :title="`Stop ${displayName(t)}`"
        class="size-11 shrink-0 justify-center rounded-full lg:size-[30px]"
        :ui="{ leadingIcon: 'size-[13px]' }"
        @click="stopOne(t)"
      />
    </li>
  </ul>
</template>
