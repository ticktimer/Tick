<script setup lang="ts">
// One entry row on the Time page.
// Desktop grid: checkbox | name + chain | time range | $ toggle | duration +
// amount | actions. Selection + billable talk to the entries store directly;
// delete bubbles up so the page can show the undo toast (Rule 4); ▶ copies
// name/ref/billable onto a NEW timer alongside whatever is already running
// (ticktimer/Tick#37 — it used to stop the running one first); ✎ (and clicking
// the name) opens the Manual-entry dialog in edit mode via ui.openEdit.
// Mobile (<1024px) the row collapses to name+chain | duration+range | …,
// and touch swipes take over: swipe LEFT reveals a 72px Delete action, swipe
// RIGHT starts the entry again. Gestures are touch-only (desktop hover
// actions untouched) with a horizontal-intent threshold so vertical
// scrolling never fights the swipe (touch-action: pan-y). Gestures aren't
// discoverable, so mobile also gets one visible "…" menu with all three row
// actions; separate icons there leave the name column no room at 390px.
import type { DropdownMenuItem } from '@nuxt/ui'
import type { EntryDto } from '#shared/types'
import { MAX_RUNNING_TIMERS } from '#shared/utils/timers'

const props = withDefaults(
  defineProps<{
    entry: EntryDto
    /** First row of its card — skips the inset separator line. */
    first?: boolean
    /** Preference: show the $ amount under the duration. */
    showAmounts?: boolean
    /** Mobile (<1024px) "Select" mode: shows the checkbox and disables swipe. */
    selectMode?: boolean
  }>(),
  { first: false, showAmounts: true, selectMode: false }
)

const emit = defineEmits<{ delete: [] }>()

const entriesStore = useEntriesStore()
const timer = useTimerStore()
const ui = useUiStore()
const toast = useToast()
// Times print in the browser's zone on both renders (ticktimer/Tick#7).
const { timeZone } = useTimeZone()

const selected = computed(() => entriesStore.selection.has(props.entry.id))

/** Chain parts, deepest first: Task · Project · Client (client in accent). */
const chainParts = computed(() => {
  const r = props.entry.ref
  if (!r) return []
  const parts: { label: string, cls: string }[] = []
  if (r.taskName) parts.push({ label: r.taskName, cls: 'text-toned' })
  if (r.projectName) parts.push({ label: r.projectName, cls: r.taskName ? 'text-muted' : 'text-toned' })
  if (r.clientName) parts.push({ label: r.clientName, cls: 'text-primary' })
  return parts
})

const billTitle = computed(() => {
  if (!props.entry.billable) return 'Not billable'
  return props.entry.resolvedRate != null ? `Billable at $${props.entry.resolvedRate}/h` : 'Billable'
})

/** Mobile-only "…" menu (Entry actions). */
const entryActionItems = computed<DropdownMenuItem[]>(() => [
  { label: 'Start again', icon: 'i-lucide-play', onSelect: () => startAgain() },
  { label: 'Edit entry', icon: 'i-lucide-pencil', onSelect: () => ui.openEdit(props.entry) },
  { label: 'Delete entry', icon: 'i-lucide-trash-2', color: 'error', onSelect: () => emit('delete') }
])

const busy = ref(false)

async function toggleBillable() {
  if (busy.value) return
  busy.value = true
  try {
    await entriesStore.updateEntry(props.entry.id, { billable: !props.entry.billable })
  } catch {
    // leave as-is; server state wins
  } finally {
    busy.value = false
  }
}

/**
 * ▶ Start again — starts an additional timer with this entry's
 * name/ref/billable. Nothing is stopped: running several at once is the
 * feature (ticktimer/Tick#37). The one refusal is the cap, which is an
 * expected answer rather than a failure, so it gets a toast instead of a
 * silent re-sync.
 */
async function startAgain() {
  if (busy.value) return
  busy.value = true
  try {
    await timer.start({
      name: props.entry.name,
      refType: props.entry.ref?.refType,
      refId: props.entry.ref?.refId,
      billable: props.entry.billable
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

// ── Touch swipe (mobile): left = reveal Delete (72px), right = start again ──
const DELETE_W = 72
const MAX_PULL = 96
const REVEAL_AT = 36 // px left before settling open
const START_AT = 60 // px right to trigger start-again

const offset = ref(0)
const dragging = ref(false)

let startX = 0
let startY = 0
let baseOffset = 0
let tracking = false
let horizontal = false

// Select mode turns off swipe entirely — a checkbox tap must never be read
// as the start of a swipe — and any row left mid-swipe snaps shut.
watch(() => props.selectMode, (on) => {
  if (on) offset.value = 0
})

function onPointerDown(e: PointerEvent) {
  if (e.pointerType !== 'touch' || props.selectMode) return
  tracking = true
  horizontal = false
  startX = e.clientX
  startY = e.clientY
  baseOffset = offset.value
}

function onPointerMove(e: PointerEvent) {
  if (!tracking) return
  const dx = e.clientX - startX
  const dy = e.clientY - startY
  if (!horizontal) {
    // Horizontal intent: clearly more sideways than vertical, past a threshold
    if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
      tracking = false // vertical scroll wins
      return
    }
    if (Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(dy) * 1.4) return
    horizontal = true
    dragging.value = true
    ;(e.currentTarget as Element | null)?.setPointerCapture?.(e.pointerId)
  }
  offset.value = Math.max(-MAX_PULL, Math.min(MAX_PULL, baseOffset + dx))
}

function onPointerEnd() {
  if (!tracking) return
  tracking = false
  if (!horizontal) return
  dragging.value = false
  if (offset.value <= -REVEAL_AT) {
    offset.value = -DELETE_W // settle open on the Delete action
  } else if (offset.value >= START_AT) {
    offset.value = 0
    startAgain()
  } else {
    offset.value = 0
  }
}

/** Tap anywhere on a revealed row closes it (and swallows the click). */
function onContentClickCapture(e: MouseEvent) {
  if (offset.value !== 0) {
    e.preventDefault()
    e.stopPropagation()
    offset.value = 0
  }
}

function onDeleteAction() {
  offset.value = 0
  emit('delete')
}

const swipeActive = computed(() => dragging.value || offset.value !== 0)
</script>

<template>
  <div
    class="relative overflow-hidden"
    :data-entry-id="entry.id"
    :style="first ? undefined : { boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--ui-text) 6%, transparent)' }"
  >
    <!-- Swipe action layers (touch reveal only) -->
    <template v-if="swipeActive">
      <!-- Right side: Delete (72px, accent-900 per mock) -->
      <button
        type="button"
        class="absolute inset-y-0 right-0 flex w-[72px] flex-col items-center justify-center gap-1 bg-primary-900 text-[11px] font-medium text-primary-100 lg:hidden"
        aria-label="Delete entry"
        @click="onDeleteAction"
      >
        <UIcon name="i-lucide-trash-2" class="size-4" />
        Delete
      </button>
      <!-- Left side: start-again hint -->
      <div class="absolute inset-y-0 left-0 flex w-[96px] items-center justify-start pl-5 text-primary lg:hidden" aria-hidden="true">
        <UIcon name="i-lucide-play" class="size-4" />
      </div>
    </template>

    <!-- Row content (translates under the swipe) -->
    <div
      class="group grid items-center gap-[11px] py-[9px] pr-2 pl-3.5 lg:grid-cols-[30px_minmax(0,1fr)_auto_auto_auto_94px] lg:pl-1.5"
      :class="[
        selectMode ? 'grid-cols-[auto_minmax(0,1fr)_auto_auto]' : 'grid-cols-[minmax(0,1fr)_auto_auto]',
        selected ? 'bg-primary/10' : swipeActive ? 'bg-elevated' : 'hover:bg-[color-mix(in_srgb,var(--ui-text)_4%,transparent)]',
        dragging ? '' : 'transition-transform duration-200'
      ]"
      :style="{ transform: offset ? `translateX(${offset}px)` : undefined, touchAction: 'pan-y' }"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerEnd"
      @pointercancel="onPointerEnd"
      @click.capture="onContentClickCapture"
    >
      <!-- Select — always visible on desktop; on mobile only while Select mode is on -->
      <UCheckbox
        :model-value="selected"
        aria-label="Select entry"
        :class="selectMode ? 'ml-1.5' : 'ml-1.5 max-lg:hidden'"
        :ui="{ base: 'size-[18px] rounded-sm' }"
        @update:model-value="entriesStore.toggleSelect(entry.id)"
      />

      <!-- Name + tags, chain beneath -->
      <div class="flex min-w-0 flex-col gap-0.5">
        <div class="flex min-w-0 items-center gap-2">
          <button
            type="button"
            class="min-w-0 cursor-pointer truncate text-left text-sm text-highlighted hover:underline"
            title="Edit entry"
            data-entry-name
            @click="ui.openEdit(entry)"
          >
            {{ entry.name }}
          </button>
          <!-- Select mode adds a leading checkbox column on mobile, and
               shrink-0 tags would otherwise take that space from the name
               (already truncated) rather than giving any up themselves,
               shrinking names to 3-4 characters — exactly the identifying
               info Select mode needs. Tags stay visible everywhere else. -->
          <UBadge
            v-for="t in entry.tags"
            :key="t"
            color="neutral"
            variant="soft"
            class="shrink-0 px-[7px] py-px text-[10px]"
            :class="selectMode ? 'max-lg:hidden' : ''"
          >
            #{{ t }}
          </UBadge>
        </div>
        <!-- Chain: wraps on desktop, single clipped line on mobile (per mock) -->
        <div v-if="chainParts.length" class="flex items-center gap-1.5 text-xs text-muted max-lg:overflow-hidden lg:flex-wrap">
          <span
            class="size-[7px] shrink-0 rounded-full"
            :style="{ background: clientColorVar(entry.ref?.clientColor) }"
          />
          <template v-for="(part, i) in chainParts" :key="i">
            <span class="whitespace-nowrap" :class="part.cls">{{ part.label }}</span>
            <span v-if="i < chainParts.length - 1" class="opacity-40">·</span>
          </template>
        </div>
      </div>

      <!-- Time range (desktop; mobile shows it under the duration) -->
      <span class="tnum whitespace-nowrap text-xs text-muted max-lg:hidden">
        {{ formatRange(entry.start, entry.end ?? entry.start, timeZone) }}
      </span>

      <!-- Billable toggle (26px square, outlined $) — desktop only -->
      <UTooltip :text="billTitle" class="max-lg:hidden">
        <UButton
          square
          variant="outline"
          :color="entry.billable ? 'primary' : 'neutral'"
          icon="i-lucide-dollar-sign"
          :aria-pressed="entry.billable"
          :aria-label="billTitle"
          class="size-[26px] justify-center"
          :class="entry.billable ? '' : 'text-dimmed'"
          :ui="{ leadingIcon: 'size-[13px]' }"
          @click="toggleBillable"
        />
      </UTooltip>

      <!-- Duration + amount (desktop) / duration + range (mobile) -->
      <div class="min-w-[84px] text-right">
        <div class="tnum text-sm font-medium text-highlighted">{{ formatDuration(entry.durationSec) }}</div>
        <div v-if="showAmounts" class="tnum text-[11px] text-muted max-lg:hidden">
          {{ entry.billable && entry.amount != null ? formatMoney(entry.amount) : '—' }}
        </div>
        <div class="tnum text-[11px] text-muted lg:hidden">
          {{ formatRange(entry.start, entry.end ?? entry.start, timeZone) }}
        </div>
      </div>

      <!-- Row actions: separate icons at ≥1024px, one "…" menu below. -->
      <div class="flex gap-0.5">
        <UButton
          icon="i-lucide-play"
          color="neutral"
          variant="ghost"
          square
          title="Start again"
          aria-label="Start again"
          class="size-[30px] justify-center max-lg:hidden"
          :ui="{ leadingIcon: 'size-[13px]' }"
          @click="startAgain"
        />
        <UDropdownMenu :items="entryActionItems" :content="{ align: 'end' }" :ui="{ content: 'min-w-40' }" class="lg:hidden">
          <UButton
            icon="i-lucide-ellipsis"
            color="neutral"
            variant="ghost"
            square
            aria-label="Entry actions"
            class="size-11 justify-center"
            :ui="{ leadingIcon: 'size-[13px]' }"
          />
        </UDropdownMenu>
        <UButton
          icon="i-lucide-pencil"
          color="neutral"
          variant="ghost"
          square
          title="Edit entry"
          aria-label="Edit entry"
          class="size-[30px] justify-center max-lg:hidden"
          :ui="{ leadingIcon: 'size-[13px]' }"
          @click="ui.openEdit(entry)"
        />
        <UButton
          icon="i-lucide-trash-2"
          color="neutral"
          variant="ghost"
          square
          title="Delete (undo available)"
          aria-label="Delete entry"
          class="size-[30px] justify-center text-dimmed hover:text-primary max-lg:hidden"
          :ui="{ leadingIcon: 'size-3.5' }"
          @click="emit('delete')"
        />
      </div>
    </div>
  </div>
</template>
