<script setup lang="ts">
// Desktop timer bar. Row composition is unchanged from before #37 — description,
// chain chip, + menu, billable, clock, start/stop — and when nothing is running
// the bar is byte-for-byte what it always was.
//
// What multiple timers add (only once something runs, so the resting bar never
// grows): a count chip that discloses ShellTimerList inside the same sticky
// region, and an "Add a timer" toggle that swaps the bar over to the draft so a
// second timer can be described without stopping the first. Whether the list
// is open lives in the store, because the events that must open it — compose,
// a start while something already runs — don't all happen in this component.
import type { DropdownMenuItem } from '@nuxt/ui'
import { MAX_RUNNING_TIMERS } from '#shared/utils/timers'

const timer = useTimerStore()
const entries = useEntriesStore()
const catalog = useCatalogStore()
const ui = useUiStore()
const router = useRouter()
const toast = useToast()

/** Literal, not useId(): the mobile dock mounts a second list at the same time
 *  (one of the two is CSS-hidden) and the two ids must not collide. */
const LIST_ID = 'timer-list-desktop'

const inputEl = ref<HTMLInputElement | null>(null)

// ── Description input ──────────────────────────────────────────────────────
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

// ── Chain chip ─────────────────────────────────────────────────────────────
const chainLabel = computed(() => {
  const r = timer.currentRef
  if (!r) return ''
  return [r.taskName, r.projectName, r.clientName].filter(Boolean).join(' · ')
})

// ── "+" menu (opens PickerModal via ui store) ──────────────────────────────
// The picker is told *which* timer it is attaching to up front: with several
// running, "the timer" would otherwise be re-resolved at pick time and a
// background re-hydrate could move it out from under the dialog.
function pickerTarget(): string | null {
  return timer.composing ? null : (timer.activeTimer?.entryId ?? null)
}

type PlusItem = DropdownMenuItem & { count?: string }

const plusItems = computed<PlusItem[][]>(() => [[
  {
    label: 'Client',
    icon: 'i-lucide-user',
    count: String(catalog.clients.length),
    onSelect: () => ui.openPicker('timer', 'client', pickerTarget())
  },
  {
    label: 'Project',
    icon: 'i-lucide-folder',
    count: String(catalog.projects.length),
    onSelect: () => ui.openPicker('timer', 'project', pickerTarget())
  },
  {
    label: 'Task',
    icon: 'i-lucide-circle-check',
    count: `${catalog.openTasks.length} open`,
    onSelect: () => ui.openPicker('timer', 'task', pickerTarget())
  }
]])

// ── Billable / rate ────────────────────────────────────────────────────────
const rateLabel = computed(() => {
  if (!timer.billable) return 'Not billable'
  return timer.resolvedRate != null ? `$${timer.resolvedRate}/h` : 'Billable'
})

// ── Clock — derived from the store's single shared `nowMs` ─────────────────
// `currentElapsedSec`, not `activeElapsedSec`: while composing, the bar's clock
// is the draft's, and a draft has no elapsed time. Reading the active timer's
// here kept its digits counting under a play button after "Add a timer".
const clock = computed(() => formatClock(timer.currentElapsedSec))

// ── Add a timer / Cancel new timer ─────────────────────────────────────────
// One slot, two buttons. While composing it is a ✕ labelled "Cancel new timer":
// a pressed-looking "Add a timer" told nobody it was the way back out, and a
// label that changes says more than aria-pressed did. Cancel discards the
// draft and hands the bar back to the pinned (else newest) timer; Esc in the
// field does the same. At the cap only *adding* is disabled, so nobody can get
// stuck in the composer.
const capReached = computed(() => timer.atCap && !timer.composing)

const addTitle = computed(() =>
  capReached.value ? `Timer limit reached (${MAX_RUNNING_TIMERS} running)` : 'Add a timer'
)

function toggleCompose() {
  if (timer.composing) {
    timer.cancelCompose()
    return
  }
  timer.compose()
  // The whole point of the press is to type a description — put the cursor
  // there. (The store has already opened the running list, so the timer that
  // just left the bar is right below.)
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
      // The store opens the list itself when this start bumps a timer out of
      // the bar (the previous newest, or this one when a pin holds the bar).
      await timer.start()
    } else {
      flushName()
      const dto = await timer.stop()
      if (dto) {
        // <1s elapsed returns null (discarded); otherwise insert at top of Today
        entries.applyStoppedEntry(dto)
        router.push('/time')
      }
    }
  } catch (err) {
    if (isTimerCapError(err)) capToast(err)
    else await timer.hydrate() // let the server win
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div
    role="region"
    aria-label="Timer"
    class="sticky top-0 z-20 border-b border-default px-[22px] py-[11px] backdrop-blur-[12px]"
    :style="{ background: 'color-mix(in srgb, var(--ui-bg) 86%, transparent)' }"
  >
    <!-- The borderless description input shows keyboard focus on the bar itself -->
    <div class="flex items-center gap-2 rounded-lg border border-default bg-elevated py-1.5 pr-1.5 pl-3.5 shadow-sm has-[>input:focus-visible]:border-primary has-[>input:focus-visible]:ring-1 has-[>input:focus-visible]:ring-primary">
      <!-- Description -->
      <input
        ref="inputEl"
        :value="nameLocal"
        type="text"
        placeholder="What are you working on?"
        aria-label="What are you working on?"
        class="min-h-10 min-w-0 flex-1 bg-transparent text-[15px] text-highlighted outline-none placeholder:text-dimmed"
        @input="onNameInput"
        @change="flushName"
        @keydown.enter.prevent="toggle"
        @keydown.esc="timer.composing && timer.count ? timer.cancelCompose() : undefined"
      >

      <!-- Chain chip: Task · Project · Client, one removable unit -->
      <span
        v-if="chainLabel"
        class="flex max-w-[360px] items-center gap-1.5 rounded-sm bg-primary/10 py-1 pr-[5px] pl-2.5 text-xs text-primary ring-1 ring-primary/25 ring-inset"
      >
        <span class="truncate">{{ chainLabel }}</span>
        <button
          type="button"
          aria-label="Remove client, project or task"
          class="flex size-[18px] shrink-0 items-center justify-center rounded-xs bg-primary/20 transition-colors hover:bg-primary/30"
          @click="timer.detach()"
        >
          <UIcon name="i-lucide-x" class="size-2.5" />
        </button>
      </span>

      <!-- Running count — the disclosure for the list below. A neutral outlined
           button, the same recipe as the "+" and the billable toggle beside it:
           it started life as a primary-tinted chip, which measured 3.76 (dark)
           and 3.98 (light) against its own wash and failed the axe sweep. The
           count is not an accent-worthy state anyway — the bar is already the
           one primary-tinted surface on the screen.

           No aria-label: the accessible name is the visible text ("2 running"),
           which is what axe's label-in-name rule (wcag21a, in the sweep's tag
           set) wants. One span holds both parts so the space between the digit
           and the word is a real text node — Vue's whitespace condensing drops
           it between two sibling elements. -->
      <UButton
        v-if="timer.count >= 1"
        icon="i-lucide-timer"
        trailing-icon="i-lucide-chevron-down"
        color="neutral"
        variant="outline"
        :aria-expanded="timer.listOpen"
        :aria-controls="LIST_ID"
        :title="timer.listOpen ? 'Hide the running timers' : 'Show the running timers'"
        class="h-[34px] shrink-0 gap-1.5 px-2.5 text-[13px]"
        :ui="{
          leadingIcon: 'size-3.5',
          trailingIcon: `size-3 transition-transform ${timer.listOpen ? 'rotate-180' : ''}`
        }"
        @click="timer.toggleList()"
      >
        <span class="whitespace-nowrap"><span class="tnum">{{ timer.count }}</span> running</span>
      </UButton>

      <!-- Add a timer, or — while the bar is the draft — Cancel new timer -->
      <UButton
        v-if="timer.count >= 1"
        :icon="timer.composing ? 'i-lucide-x' : 'i-lucide-alarm-clock-plus'"
        color="neutral"
        variant="outline"
        square
        :aria-label="timer.composing ? 'Cancel new timer' : 'Add a timer'"
        :disabled="capReached"
        :title="timer.composing ? 'Cancel new timer' : addTitle"
        class="size-[34px] shrink-0 justify-center"
        @click="toggleCompose"
      />

      <!-- + menu -->
      <UDropdownMenu :items="plusItems" :content="{ align: 'end' }" :ui="{ content: 'min-w-[230px]' }">
        <UButton
          icon="i-lucide-plus"
          color="neutral"
          variant="outline"
          square
          aria-label="Add client, project or task"
          class="size-[34px] justify-center"
        />
        <template #item-trailing="{ item }">
          <span class="text-[11px] text-dimmed tnum">{{ item.count }}</span>
        </template>
        <template #content-bottom>
          <div class="mt-0.5 border-t border-default px-2.5 py-1.5 text-[11px] text-muted">
            Type <b class="font-medium text-toned">#</b> for tags, <b class="font-medium text-toned">@</b> for projects
          </div>
        </template>
      </UDropdownMenu>

      <!-- Billable toggle -->
      <UButton
        :color="timer.billable ? 'primary' : 'neutral'"
        variant="outline"
        icon="i-lucide-dollar-sign"
        :aria-pressed="timer.billable"
        :aria-label="timer.billable ? `Billable, ${rateLabel}` : 'Billable'"
        :title="timer.billable ? 'Billable' : 'Not billable'"
        :class="timer.billable ? '' : 'text-dimmed'"
        class="h-[34px] gap-1.5 px-2.5 text-[13px]"
        @click="timer.toggleBillable()"
      >
        <span class="tnum">{{ rateLabel }}</span>
      </UButton>

      <!-- Clock. `text-primary`, not `text-primary-400`: main.css already steps
           light mode's --ui-primary to primary-700 precisely so accent text
           clears AA on white and on elevated cards, and a hard-coded shade
           opts out of that. primary-400 on bg-elevated measured 1.98:1 in
           Daylight — and worse in the six other light presets. Dark keeps
           primary-300 exactly as before. -->
      <div
        class="tnum min-w-[118px] pr-1.5 text-right text-2xl font-medium tracking-[0.01em]"
        :class="timer.composing ? 'text-dimmed' : 'text-primary dark:text-primary-300'"
      >
        {{ clock }}
      </div>

      <!-- Start / stop: 40px circle, always outlined -->
      <UButton
        color="primary"
        variant="outline"
        square
        :icon="timer.composing ? 'i-lucide-play' : 'i-lucide-square'"
        :aria-label="timer.composing ? 'Start' : 'Stop'"
        class="size-10 justify-center rounded-full"
        :class="timer.composing ? '' : 'tick-glow text-primary dark:text-primary-300'"
        @click="toggle"
      />
    </div>

    <!-- Running list: a disclosure inside the same sticky region, so the bar's
         resting height is untouched and only an opened list adds any. -->
    <div
      v-if="timer.listOpen && timer.count >= 1"
      class="tick-rise mt-1.5 max-h-[min(50vh,340px)] overflow-y-auto rounded-lg border border-default bg-elevated p-1 shadow-sm"
    >
      <ShellTimerList :list-id="LIST_ID" />
    </div>
  </div>
</template>
