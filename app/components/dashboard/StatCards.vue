<script setup lang="ts">
// Four stat cards: Today / This week / Billable / Unbilled.
// "Today" ticks live while the timer runs (summary.todaySec excludes running
// entries — server entries with end IS NULL aren't summed). With several timers
// running it adds all of them: the card answers "how much have I tracked
// today", and every running timer is tracking.

const props = defineProps<{ summary: DashboardSummary }>()

const timer = useTimerStore()

const liveTodaySec = computed(() => props.summary.todaySec + timer.totalElapsedSec)

const stats = computed(() => {
  const s = props.summary
  return [
    {
      label: 'Today',
      value: dashDuration(liveTodaySec.value),
      meta: timer.count > 1
        ? `${timer.count} timers running`
        : timer.running
          ? 'timer running'
          : `${s.todayEntries} ${s.todayEntries === 1 ? 'entry' : 'entries'}`
    },
    {
      label: 'This week',
      value: dashDuration(s.weekSec),
      meta: 'of 30h target'
    },
    {
      label: 'Billable',
      value: dashDuration(s.weekBillableSec),
      meta: `${Math.round(s.billablePct)}% of tracked`
    },
    {
      label: 'Unbilled',
      // The summary's unbilled query is all-time (not this week like the cards
      // beside it), so the meta says so rather than implying a week window.
      value: dashMoney(s.unbilledAmount),
      meta: `across ${s.unbilledClients} ${s.unbilledClients === 1 ? 'client' : 'clients'} · all time`
    }
  ]
})
</script>

<template>
  <!-- Mobile: 2×2 (README §Mobile); wider screens auto-fit ≥170px -->
  <div class="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(170px,1fr))]">
    <UCard
      v-for="s in stats"
      :key="s.label"
      class="bg-elevated shadow-sm"
      :ui="{ body: 'flex flex-col gap-0.75 p-4 px-5 sm:p-4 sm:px-5' }"
    >
      <div class="text-[10px] font-medium uppercase tracking-widest text-primary">{{ s.label }}</div>
      <div class="tnum text-[26px] font-medium leading-[1.1] text-highlighted">{{ s.value }}</div>
      <div class="text-[11px] text-muted">{{ s.meta }}</div>
    </UCard>
  </div>
</template>
