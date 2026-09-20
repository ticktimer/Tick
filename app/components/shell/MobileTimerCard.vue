<script setup lang="ts">
// Mobile docked timer card — sits above the tab bar on every screen (<1024px),
// replacing the desktop TimerBar. Row 1: description input, 22px tnum clock,
// 44px circular start/stop. Row 2: running-count chip, chain chip, rate chip,
// "add a timer" and + (opens the picker sheet). Same store wiring as
// ShellTimerBar.
//
// The dock's HEIGHT IS FIXED: app/layouts/default.vue reserves
// pb-[calc(150px+env(safe-area-inset-bottom))] for it, so #37's running list
// renders as an overlay floating *above* the card (absolute, bottom-full), not
// as a third row. Row 2's new controls are the same 30px as the + already
// there, so the card measures exactly what it did before.
import { MAX_RUNNING_TIMERS } from '#shared/utils/timers'

const timer = useTimerStore()
const entries = useEntriesStore()
const ui = useUiStore()
const router = useRouter()
const toast = useToast()

/** Literal, not useId(): the desktop bar mounts a second list at the same time
 *  (one of the two is CSS-hidden) and the two ids must not collide. */
const LIST_ID = 'timer-list-mobile'

const inputEl = ref<HTMLInputElement | null>(null)

// ── Description input (debounced while running, same as TimerBar) ──────────
const nameLocal = ref(timer.currentName)

watch(() => timer.currentName, (v) => {
  if (v !== nameLocal.value) nameLocal.value = v
})

// The debounced rename captures BOTH which timer it is renaming and what to
// call it, at the keystroke that armed it. Resolving either 800ms later loses
// the edit: a refocus hydrate can pull in a newer timer started elsewhere,
// `activeTimer` moves to it, the currentName watcher rewrites the input, and
// the pending rename then reads that box and writes the new timer's own name
// back to itself. The typed text reaches nothing and vanishes mid-edit.
let nameDebounce: ReturnType<typeof setTimeout> | null = null
let pendingName: { id: string | null, text: string } | null = null

function armName(text: string) {
  pendingName = { id: timer.activeTimer?.entryId ?? null, text }
  if (nameDebounce) clearTimeout(nameDebounce)
  nameDebounce = setTimeout(commitName, 800)
}

function commitName() {
  if (nameDebounce) {
    clearTimeout(nameDebounce)
    nameDebounce = null
  }
  const pending = pendingName
  pendingName = null
  if (pending) timer.setName(pending.text, pending.id)
}

function onNameInput(e: Event) {
  nameLocal.value = (e.target as HTMLInputElement).value
  // Composing edits the draft, which has no id and no round trip to debounce.
  if (timer.composing) {
    timer.setName(nameLocal.value, null)
    return
  }
  armName(nameLocal.value)
}

/** Commit a pending rename now (blur, and before a stop). */
function flushName() {
  commitName()
}

// ── Floating dock surface (ticktimer/Tick#34) ──────────────────────────────
// The card used bg-elevated + border-default + shadow-md, which is exactly the
// entry cards it sits on top of: it read as the last row of the list rather
// than as something floating over it.
//
// What separates it is an edge, not a fill. On light the dock goes white against
// the grey cards (bg-default); on dark it keeps bg-elevated, because the step
// further (bg-accented) drops the muted clock and chips to 3.98:1 against their
// own background and fails the axe sweep at WCAG AA. So the lift comes from a
// real drop shadow plus a primary hairline that is always present — the dock is
// the one primary-tinted surface on the screen — and brightens into a halo while
// the timer runs. The *pulsing* glow belongs to the play button; a whole pulsing
// card would be too much.
//
// #37's running-list overlay reuses that reasoning rather than restating it: it
// takes the same bg-default / dark:bg-elevated fill and the same lift shadow, so
// every text token on it keeps the contrast it was measured at, and (since the
// light-mode pass) the dock's own idle edge — see listShadow below.
const lift = '0 12px 32px -10px color-mix(in srgb, var(--ui-bg-inverted) 55%, transparent)'
const idleEdge = '0 0 0 1px color-mix(in srgb, var(--ui-primary) 45%, transparent), 0 0 18px -8px color-mix(in srgb, var(--ui-primary) 30%, transparent)'
const runningEdge = '0 0 0 1px var(--ui-primary), 0 0 22px -6px color-mix(in srgb, var(--ui-primary) 55%, transparent)'

const dockShadow = computed(() => `${lift}, ${timer.running ? runningEdge : idleEdge}`)

// The list first shipped with a neutral hairline, on the theory that the
// primary edge is what identifies the dock. In light mode that hairline all
// but disappeared against the entry cards the overlay floats over. The list
// is the dock's own disclosure, so it takes the dock's idle edge — the 45%
// hairline and the soft glow — never the brighter running edge, which is the
// play button's signal, not a panel's.
const listShadow = `${lift}, ${idleEdge}`

// ── Chips ──────────────────────────────────────────────────────────────────
const chainLabel = computed(() => {
  const r = timer.currentRef
  if (!r) return ''
  return [r.taskName, r.projectName, r.clientName].filter(Boolean).join(' · ')
})

const rateLabel = computed(() => {
  if (!timer.billable) return 'Not billable'
  return timer.resolvedRate != null ? `$${timer.resolvedRate}/h` : 'Billable'
})

/** The count chip prints just the digit at this width; the label carries the
 *  rest, and "2" is a substring of it, so speech input still matches. */
const countLabel = computed(() =>
  `${timer.count} ${timer.count === 1 ? 'timer' : 'timers'} running`
)

// ── Picker target ──────────────────────────────────────────────────────────
// Named up front so a background re-hydrate can't move "the timer" while the
// sheet is open (see the ui store's pickerTimerId).
function pickerTarget(): string | null {
  return timer.composing ? null : (timer.activeTimer?.entryId ?? null)
}

// ── Clock — derived from the store's single shared `nowMs` ─────────────────
// `currentElapsedSec`: 00:00:00 while composing — the draft has no elapsed
// time, and the bumped timer's digits must not keep counting under a play button.
const clock = computed(() => formatClock(timer.currentElapsedSec))

// ── Add a timer ────────────────────────────────────────────────────────────
const capReached = computed(() => timer.atCap && !timer.composing)

const addTitle = computed(() =>
  capReached.value ? `Timer limit reached (${MAX_RUNNING_TIMERS} running)` : 'Add a timer'
)

// While composing, the same slot is a ✕ — "Cancel new timer" — because a
// pressed-looking "Add a timer" told nobody it was the way back out. Cancel
// discards the draft and hands the card back to the pinned (else newest) timer.
function toggleCompose() {
  if (timer.composing) {
    timer.cancelCompose()
    return
  }
  timer.compose() // also opens the running list, so the bumped timer stays in view
  nextTick(() => inputEl.value?.focus())
}

function capToast(err: unknown) {
  toast.add({
    title: timerCapMessage(err),
    description: `Stop one of the ${MAX_RUNNING_TIMERS} running timers before starting another.`,
    icon: 'i-lucide-alarm-clock-off',
    color: 'neutral'
  })
}

// ── Start / stop ───────────────────────────────────────────────────────────
const busy = ref(false)

async function toggle() {
  if (busy.value) return
  busy.value = true
  try {
    if (timer.composing) {
      timer.setName(nameLocal.value, null)
      await timer.start() // the store opens the list when this bumps a timer out of the card
    } else {
      flushName()
      const dto = await timer.stop()
      if (dto) {
        entries.applyStoppedEntry(dto)
        router.push('/time')
      }
    }
  } catch (err) {
    if (isTimerCapError(err)) capToast(err)
    else await timer.hydrate()
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div
    role="region"
    aria-label="Timer"
    class="relative mx-3 flex flex-col gap-2 rounded-xl border border-accented bg-default py-2.5 dark:bg-elevated pr-2.5 pl-3.5 has-[input:focus-visible]:border-primary has-[input:focus-visible]:ring-1 has-[input:focus-visible]:ring-primary"
    :style="{ boxShadow: dockShadow }"
  >
    <!-- Running list: an overlay ABOVE the dock, never a row inside it — the
         layout reserves a fixed 150px for this card and that must not move. -->
    <div
      v-if="timer.listOpen && timer.count >= 1"
      class="tick-rise absolute inset-x-0 bottom-full z-10 mb-2 flex max-h-[min(50vh,300px)] flex-col rounded-xl bg-default p-1 dark:bg-elevated"
      :style="{ boxShadow: listShadow }"
    >
      <!-- A way out that isn't the chip it floated up from: the chip sits in
           the dock *below* the overlay, so closing meant reaching back past
           the list to the thing that opened it. 36px, extended to 44 for touch. -->
      <div class="flex shrink-0 items-center justify-between pl-2.5">
        <span class="text-[11px] text-muted">Running timers</span>
        <UButton
          icon="i-lucide-x"
          color="neutral"
          variant="ghost"
          square
          aria-label="Close the running timers"
          class="relative size-9 justify-center after:absolute after:-inset-1 after:content-['']"
          :ui="{ leadingIcon: 'size-4' }"
          @click="timer.closeList()"
        />
      </div>
      <div class="min-h-0 overflow-y-auto">
        <ShellTimerList :list-id="LIST_ID" />
      </div>
    </div>

    <!-- Row 1: description · clock · start/stop -->
    <div class="flex items-center gap-2">
      <input
        ref="inputEl"
        :value="nameLocal"
        type="text"
        placeholder="What are you working on?"
        aria-label="What are you working on?"
        class="min-h-11 min-w-0 flex-1 bg-transparent text-[15px] text-highlighted outline-none placeholder:text-dimmed"
        @input="onNameInput"
        @change="flushName"
        @keydown.enter.prevent="toggle"
        @keydown.esc="timer.composing && timer.count ? timer.cancelCompose() : undefined"
      >
      <!-- text-primary, not text-primary-400 — see the note on TimerBar's
           clock: main.css steps light mode's --ui-primary to primary-700 so
           accent text clears AA, and a hard-coded shade opts out of it. -->
      <span
        class="tnum shrink-0 text-[22px] font-medium tracking-[0.01em]"
        :class="timer.composing ? 'text-muted' : 'text-primary dark:text-primary-300'"
      >
        {{ clock }}
      </span>
      <UButton
        color="primary"
        variant="outline"
        square
        :icon="timer.composing ? 'i-lucide-play' : 'i-lucide-square'"
        :aria-label="timer.composing ? 'Start' : 'Stop'"
        class="size-11 shrink-0 justify-center rounded-full"
        :class="timer.composing ? '' : 'tick-glow text-primary dark:text-primary-300'"
        @click="toggle"
      />
    </div>

    <!-- Row 2: count chip · chain chip · rate chip · add a timer · + -->
    <div class="flex min-w-0 items-center gap-1.5">
      <!-- Count chip leads the row: it summarises everything running, rather
           than saying anything about the timer the card is showing. Neutral
           outlined, like the two buttons at the other end of the row — as a
           primary-tinted chip it failed the contrast sweep, and the dock is
           already the one primary-tinted surface on the screen (#34).
           h-[30px] matches those buttons, which is what sets this row's
           height, so the dock still measures exactly what it did. -->
      <UButton
        v-if="timer.count >= 1"
        icon="i-lucide-timer"
        trailing-icon="i-lucide-chevron-down"
        color="neutral"
        variant="outline"
        :aria-label="countLabel"
        :aria-expanded="timer.listOpen"
        :aria-controls="LIST_ID"
        class="relative h-[30px] shrink-0 gap-1 px-1.5 text-[11px] after:absolute after:-inset-1.5 after:content-['']"
        :ui="{
          leadingIcon: 'size-3',
          trailingIcon: `size-3 transition-transform ${timer.listOpen ? 'rotate-180' : ''}`
        }"
        @click="timer.toggleList()"
      >
        <span class="tnum">{{ timer.count }}</span>
      </UButton>

      <!-- "+" leads the attachment, right beside what it attaches to — the
           chain chip, or the "No client, project or task" it replaces. It used
           to sit in the far corner, where it read as a generic add. -->
      <UButton
        icon="i-lucide-plus"
        color="neutral"
        variant="outline"
        square
        aria-label="Add client, project or task"
        class="relative size-[30px] shrink-0 justify-center after:absolute after:-inset-1.5 after:content-['']"
        :ui="{ leadingIcon: 'size-3.5' }"
        @click="ui.openPicker('timer', 'task', pickerTarget())"
      />

      <!-- flex-1 so the rate badge and "Add a timer" keep their places at the
           right whether or not anything is attached. -->
      <div class="flex min-w-0 flex-1 items-center">
        <span
          v-if="chainLabel"
          class="flex min-w-0 items-center gap-1.5 rounded-sm bg-primary/10 py-1 pr-[5px] pl-2.5 text-[11px] text-primary ring-1 ring-primary/25 ring-inset"
        >
          <span class="truncate">{{ chainLabel }}</span>
          <button
            type="button"
            aria-label="Remove client, project or task"
            class="relative flex size-[18px] shrink-0 items-center justify-center rounded-xs bg-primary/20 after:absolute after:-inset-3 after:content-['']"
            @click="timer.detach()"
          >
            <UIcon name="i-lucide-x" class="size-2.5" />
          </button>
        </span>
        <span v-else class="min-w-0 truncate text-[11px] text-muted">No client, project or task</span>
      </div>

      <UBadge
        color="neutral"
        variant="outline"
        class="tnum shrink-0 cursor-pointer px-2 py-0.5 text-[11px]"
        :class="timer.billable ? 'text-primary ring-primary/40' : 'text-dimmed'"
        role="button"
        tabindex="0"
        :aria-pressed="timer.billable"
        :aria-label="timer.billable ? 'Billable — tap to make non-billable' : 'Not billable — tap to make billable'"
        as="button"
        @click="timer.toggleBillable()"
      >
        {{ rateLabel }}
      </UBadge>

      <!-- Add a timer / Cancel new timer: the right corner. Adding is the one
           primary control in this row — outlined, like the play button above
           it. While composing the slot turns into a neutral ✕: cancel must not
           be the accent, and a label that changes says more than aria-pressed
           did. Still 30px — this row's height is what the dock's fixed 150px
           was measured against, so prominence comes from colour, not size. -->
      <UButton
        v-if="timer.count >= 1"
        :icon="timer.composing ? 'i-lucide-x' : 'i-lucide-alarm-clock-plus'"
        :color="timer.composing ? 'neutral' : 'primary'"
        variant="outline"
        square
        :aria-label="timer.composing ? 'Cancel new timer' : 'Add a timer'"
        :disabled="capReached"
        :title="timer.composing ? 'Cancel new timer' : addTitle"
        class="relative ml-auto size-[30px] shrink-0 justify-center after:absolute after:-inset-1.5 after:content-['']"
        :ui="{ leadingIcon: 'size-4' }"
        @click="toggleCompose"
      />
    </div>
  </div>
</template>
