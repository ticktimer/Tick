<script setup lang="ts">
// One task row — used inside a project card and in the Standalone tasks card.
// >=sm grid: done radio | name | entry count | tracked | ▶ start. Below sm the
// entry-count/tracked/rate columns collapse into one secondary line under the
// name, which otherwise gets no width next to the fixed columns.

import { MAX_RUNNING_TIMERS } from '#shared/utils/timers'

const props = defineProps<{ task: TaskDto }>()
const emit = defineEmits<{ edit: [] }>()

const timer = useTimerStore()
const catalog = useCatalogStore()
const router = useRouter()
const toast = useToast()

const entriesLabel = computed(() => {
  const n = props.task.entryCount
  return n ? `${n} ${n === 1 ? 'entry' : 'entries'}` : 'no entries'
})

const tracked = computed(() => props.task.trackedSec ? formatDuration(props.task.trackedSec) : '—')

// Mobile-only secondary line: entries + tracked time + the task's own rate
// (that trio lives in separate grid columns at sm+; the name's own rate span
// covers it there instead).
const secondaryLine = computed(() => {
  const parts = [entriesLabel.value]
  if (props.task.trackedSec) parts.push(tracked.value)
  if (props.task.rate != null) parts.push(`$${props.task.rate}/h`)
  return parts.join(' · ')
})

async function toggleDone() {
  try {
    await catalog.updateTask(props.task.id, { done: !props.task.done })
  } catch { /* refetch happens inside the store on success; ignore transient errors */ }
}

// ▶ — starts an ADDITIONAL timer on this task; anything already running keeps
// running (ticktimer/Tick#37). Only the cap refuses, and that is an expected
// answer, so it gets a toast rather than a silent re-sync.
const starting = ref(false)

async function start() {
  if (starting.value) return
  starting.value = true
  try {
    const billable = props.task.projectId
      ? (catalog.projects.find(p => p.id === props.task.projectId)?.billableDefault ?? true)
      : true
    await timer.start({ name: props.task.name, refType: 'task', refId: props.task.id, billable })
    router.push('/time')
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
    starting.value = false
  }
}
</script>

<template>
  <div class="flex items-center gap-[11px] py-[7px] pl-2 sm:grid sm:grid-cols-[22px_minmax(0,1fr)_110px_80px_30px]">
    <!-- Done radio: accent when done -->
    <button
      type="button"
      :aria-label="task.done ? 'Reopen task' : 'Mark complete'"
      class="grid size-4 shrink-0 cursor-pointer place-items-center rounded-full border-[1.5px] transition-colors"
      :class="task.done ? 'border-primary bg-primary text-inverted' : 'border-accented hover:border-primary'"
      @click="toggleDone"
    >
      <UIcon v-if="task.done" name="i-lucide-check" class="size-2.5" />
    </button>

    <!-- Name block: name (still the edit button) on top; below sm a smaller
         secondary line carries entries/tracked/rate instead of the fixed
         columns those get at sm+. `sm:contents` un-boxes this wrapper at
         sm+ so its children rejoin the row's own grid columns. -->
    <div class="flex min-w-0 flex-1 flex-col gap-0.5 sm:contents">
      <button
        type="button"
        class="flex min-w-0 items-baseline gap-1.5 text-left text-[13px] decoration-dotted underline-offset-2 hover:underline"
        :class="task.done ? 'text-muted line-through' : 'text-default'"
        @click="emit('edit')"
      >
        <span class="truncate">{{ task.name }}</span>
        <span v-if="task.rate != null" class="tnum hidden shrink-0 text-xs text-muted sm:inline">${{ task.rate }}/h</span>
      </button>

      <span class="tnum truncate text-xs text-muted sm:hidden">{{ secondaryLine }}</span>
    </div>

    <span class="hidden text-xs text-muted sm:block">{{ entriesLabel }}</span>

    <span class="hidden tnum text-right text-xs text-toned sm:block">{{ tracked }}</span>

    <UButton
      icon="i-lucide-play"
      color="neutral"
      variant="ghost"
      square
      :loading="starting"
      title="Start timer on this task"
      aria-label="Start timer on this task"
      class="size-11 shrink-0 justify-center sm:size-7"
      @click="start"
    />
  </div>
</template>
