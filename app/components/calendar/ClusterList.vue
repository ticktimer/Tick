<script setup lang="ts">
// The fold's list (ticktimer/Tick#37) — the popover body that opens from a
// folded calendar block: one row per overlapping entry, with its full name,
// chain and time range, so you read which entry you are restarting before you
// press its ▶. The rows are shell/TimerList.vue's recipe — that component
// renders timer.timers unconditionally, so the row is copied, not the
// component: the same body button and 44px/30px sizing, the same trailing
// figure, and for a member that is a running timer the same live clock off
// the store's one shared `nowMs`, the same tap-to-select, and the same
// aria-current + primary ring when it is the bar's active timer.
//
// This list decides nothing. An ended row's body emits `edit`, its ▶ emits
// `start`, a running row's body emits `show`; Grid.vue owns the handlers
// (ui.openEdit, startAgain, timer.pin + timer.openList) and closes the popover
// as it goes. A running member gets no ▶ (it is running) and no stop — stop
// keeps its one home, the bar's running list.
import type { ClusterListEmits, Fold, FoldMember } from '~/utils/calendar-fold'

defineProps<{
  fold: Fold
  /** The column's header, e.g. "Sat 12", so the list says which day it is. */
  dayLabel: string
}>()

const emit = defineEmits<ClusterListEmits>()

const timer = useTimerStore()

/** Both kinds key by the entry's id — a running timer's id IS its entry id. */
function keyOf(m: FoldMember): string {
  return m.kind === 'timer' ? m.id : m.entry.id
}

/** The running member the bar is showing, marked exactly as TimerList marks it. */
function isActive(m: FoldMember): boolean {
  return m.kind === 'timer' && timer.activeTimer?.entryId === m.id
}

function bodyLabel(m: FoldMember): string {
  return m.kind === 'entry' ? `Edit ${m.name}, ${m.range}` : `Show ${m.name} in the timer bar`
}

function press(m: FoldMember) {
  if (m.kind === 'entry') emit('edit', m.entry)
  else emit('show', m.id)
}

/**
 * One start in flight at a time, as TimerList guards its stops — a double tap
 * must not emit twice. Grid closes the popover on `start`, which unmounts this
 * instance, so the mark never needs clearing here; the next open starts clean.
 */
const starting = ref<string | null>(null)

function start(m: FoldMember) {
  if (m.kind !== 'entry' || starting.value) return
  starting.value = m.entry.id
  emit('start', m.entry)
}
</script>

<template>
  <div class="flex flex-col gap-1">
    <p class="tnum truncate px-2.5 pt-1 text-[11px] text-muted">
      {{ dayLabel }} · {{ fold.rangeText }} · {{ fold.count }} entries<template v-if="fold.running"> · {{ fold.running }} running</template>
    </p>

    <ul aria-label="Overlapping entries" class="flex max-h-[min(50vh,340px)] flex-col gap-px overflow-y-auto">
      <li
        v-for="m in fold.members"
        :key="keyOf(m)"
        :aria-current="isActive(m) ? 'true' : undefined"
        class="flex items-center gap-2 rounded-md py-1.5 pr-1 pl-2.5"
        :class="isActive(m)
          ? 'ring-1 ring-primary/60 ring-inset'
          : 'hover:bg-[color-mix(in_srgb,var(--ui-text)_5%,transparent)]'"
      >
        <!-- The row's body: everything but the trailing control. Ended → the
             edit dialog; running → select it into the bar, as a TimerList row
             does. Name with range and chain underneath — the same dot + muted
             text as an entry row. 44px tall under lg, a real touch target. -->
        <button
          type="button"
          :aria-label="bodyLabel(m)"
          :title="m.kind === 'entry' ? 'Edit entry' : (isActive(m) ? 'Shown in the timer bar' : 'Show in the timer bar')"
          class="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-1 focus-visible:ring-primary lg:min-h-[30px]"
          @click="press(m)"
        >
          <span class="flex min-w-0 flex-1 flex-col gap-0.5">
            <span class="truncate text-[13px] text-highlighted">{{ m.name }}</span>
            <span class="flex min-w-0 items-center gap-1.5 text-[11px] text-muted">
              <span class="size-[6px] shrink-0 rounded-full" :style="{ background: clientColorVar(m.clientColor) }" />
              <span class="truncate">
                <span class="tnum">{{ m.range }}</span><template v-if="m.sub"> · {{ m.sub }}</template>
              </span>
            </span>
          </span>

          <span
            class="tnum shrink-0 pr-1 text-[13px] font-medium tracking-[0.01em]"
            :class="m.kind === 'timer' ? 'text-primary dark:text-primary-300' : 'text-toned'"
          >{{ m.kind === 'timer' ? formatClock(timer.elapsedFor(m.id)) : m.duration }}</span>
        </button>

        <!-- Ended: start again, with the same accessible name as the block's
             own ▶. Running: a spacer with a primary dot, so the figures above
             stay aligned down the list. -->
        <UButton
          v-if="m.kind === 'entry'"
          icon="i-lucide-play"
          color="primary"
          variant="outline"
          square
          :loading="starting === m.entry.id"
          :aria-label="`Start timer for ${m.name}`"
          :title="`Start timer for ${m.name}`"
          class="size-11 shrink-0 justify-center rounded-full lg:size-[30px]"
          :ui="{ leadingIcon: 'size-[13px]' }"
          @click="start(m)"
        />
        <span
          v-else
          class="grid size-11 shrink-0 place-items-center lg:size-[30px]"
          title="Running"
          aria-hidden="true"
        >
          <span class="size-[6px] rounded-full bg-primary" />
        </span>
      </li>
    </ul>
  </div>
</template>
