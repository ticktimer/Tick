<script setup lang="ts">
// Calendar's create dialog — the Manual-entry dialog pattern (same fields,
// interpretEntry() reading and picker wiring), opened by drag-to-create with
// Start date/Start/End prefilled from the dragged slot. Local open state (the
// shared ui store's manual dialog belongs to the Time page); saves via
// calendarStore.create so the new block lands in the visible range immediately.
import type { ChainRef, SessionUser } from '#shared/types'

const props = defineProps<{
  /** Free-text field values from the dragged slot ("2026-09-11", "10:00am"…). */
  prefill: { date: string, start: string, end: string } | null
}>()

const open = defineModel<boolean>('open', { required: true })

const ui = useUiStore()
const calendar = useCalendarStore()
const catalog = useCatalogStore()
const { user } = useUserSession()

const desc = ref('')
const refChain = ref<ChainRef | null>(null)
const billable = ref(true)
const dateInput = ref('')
const startInput = ref('')
const endInput = ref('')
const endDateInput = ref('')
const durInput = ref('')
const tagsInput = ref('')
const saving = ref(false)
/** Date/Start/End/Duration inputs point at the live interpretation line. */
const interpId = useId()

const descInput = useTemplateRef<{ inputRef?: HTMLInputElement }>('descInput')

// Fresh fields on every open, date/times prefilled from the drag
watch(open, (v) => {
  if (!v) return
  desc.value = ''
  refChain.value = null
  billable.value = true
  dateInput.value = props.prefill?.date ?? ''
  startInput.value = props.prefill?.start ?? ''
  endInput.value = props.prefill?.end ?? ''
  endDateInput.value = ''
  durInput.value = ''
  tagsInput.value = ''
  saving.value = false
  ui.pickerResult = null
})

// Adopt what the picker chose (target 'manual' — the Time page's dialog isn't
// mounted here, so this dialog is the sole consumer), then clear it.
watch(() => ui.pickerResult, (r) => {
  if (!r || !open.value || ui.pickerTarget !== 'manual') return
  refChain.value = r
  ui.pickerResult = null
  const projectId = r.refType === 'project' ? r.refId : r.projectId
  if (projectId) {
    const p = catalog.projects.find(x => x.id === projectId)
    if (p) billable.value = p.billableDefault
  }
})

const refLabel = computed(() => {
  const r = refChain.value
  if (!r) return 'None — simple entry'
  return [r.taskName, r.projectName, r.clientName].filter(Boolean).join(' · ') || 'None — simple entry'
})

/** Client-side rate estimate (server re-resolves per Rule 2). */
const resolvedRate = computed<number | null>(() => {
  const fallback = (user.value as SessionUser | null)?.defaultRate ?? null
  const r = refChain.value
  if (!r) return fallback
  if (r.refType === 'client') {
    return catalog.clients.find(c => c.id === r.refId)?.rate ?? fallback
  }
  const projectId = r.refType === 'project' ? r.refId : r.projectId
  if (projectId) {
    const p = catalog.projects.find(x => x.id === projectId)
    if (p) return p.resolvedRate ?? fallback
  }
  return fallback
})

const rateLabel = computed(() => {
  if (!billable.value) return 'Not billable'
  return resolvedRate.value != null ? `$${resolvedRate.value}/h` : 'Billable'
})

/** Live interpretation of the date/time fields (blank date = today, blank end date = same day). */
const parsed = computed(() => interpretEntry({
  date: dateInput.value,
  endDate: endDateInput.value,
  start: startInput.value,
  end: endInput.value,
  duration: durInput.value
}))

const tags = computed(() =>
  tagsInput.value
    .split(',')
    .map(t => t.trim().replace(/^#/, '').toLowerCase())
    .filter(Boolean)
)

async function submit() {
  if (!parsed.value.valid || saving.value) return
  saving.value = true
  try {
    await calendar.create({
      name: desc.value.trim() || 'Untitled entry',
      refType: refChain.value?.refType,
      refId: refChain.value?.refId,
      billable: billable.value,
      start: parsed.value.start!.toISOString(),
      end: parsed.value.end!.toISOString(),
      tags: tags.value
    })
    open.value = false
  } catch {
    saving.value = false
    return
  }
  saving.value = false
}

function onOpenAutoFocus(e: Event) {
  e.preventDefault()
  nextTick(() => descInput.value?.inputRef?.focus())
}
</script>

<template>
  <UModal
    v-model:open="open"
    :ui="{ content: 'max-w-[560px]' }"
    :content="{ onOpenAutoFocus }"
    title="New entry"
  >
    <template #content>
      <div class="flex flex-col gap-4 p-5">
        <!-- Dialog name comes from :title (Nuxt UI's aria-hidden DialogTitle); this is the visible heading -->
        <h2 class="text-[17px] font-medium text-highlighted">New entry</h2>

        <UFormField label="What did you work on?">
          <UInput
            ref="descInput"
            v-model="desc"
            placeholder="e.g. Invoice reconciliation"
            class="w-full"
            @keydown.enter.prevent="submit"
          />
        </UFormField>

        <!-- Ref picker (button styled as input) + billable toggle -->
        <div class="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2.5">
          <UFormField label="Client, project or task">
            <!-- Clear sits beside the picker button (not nested in it) -->
            <div class="relative">
              <button
                type="button"
                class="flex h-8 w-full items-center gap-2 rounded-md bg-default px-2.5 text-left text-sm ring ring-inset ring-accented transition-colors hover:bg-[color-mix(in_srgb,var(--ui-text)_4%,transparent)]"
                :class="refChain ? 'pr-9' : ''"
                :aria-label="`Client, project or task: ${refLabel}`"
                aria-haspopup="dialog"
                @click="ui.openPicker('manual', 'task')"
              >
                <span class="min-w-0 flex-1 truncate" :class="refChain ? 'text-highlighted' : 'text-muted'">
                  {{ refLabel }}
                </span>
                <UIcon v-if="!refChain" name="i-lucide-search" class="size-3.5 shrink-0 opacity-60" />
              </button>
              <button
                v-if="refChain"
                type="button"
                aria-label="Clear client, project or task"
                class="absolute top-1/2 right-2.5 flex size-[18px] -translate-y-1/2 items-center justify-center rounded-xs text-muted hover:text-highlighted"
                @click="refChain = null"
              >
                <UIcon name="i-lucide-x" class="size-3.5" />
              </button>
            </div>
          </UFormField>
          <UButton
            variant="outline"
            :color="billable ? 'primary' : 'neutral'"
            icon="i-lucide-dollar-sign"
            :aria-pressed="billable"
            :aria-label="billable ? `Billable, ${rateLabel}` : 'Billable'"
            class="h-8"
            :class="billable ? '' : 'text-dimmed'"
            @click="billable = !billable"
          >
            <span class="tnum">{{ rateLabel }}</span>
          </UButton>
        </div>

        <!-- Start date / Start over End date / End / or Duration — same shape as
             the Manual-entry dialog; a blank End date means the start day -->
        <div class="grid grid-cols-2 gap-2.5 sm:grid-cols-[minmax(0,1.3fr)_1fr_1fr]">
          <UFormField label="Start date — type it any way">
            <UInput v-model="dateInput" :aria-describedby="interpId" placeholder="2025-03-14, mar 14, last tue…" class="tnum w-full" />
          </UFormField>
          <UFormField label="Start">
            <UInput v-model="startInput" :aria-describedby="interpId" placeholder="9:00" class="tnum w-full" />
          </UFormField>
          <div class="hidden sm:block" aria-hidden="true" />
          <UFormField label="End date">
            <UInput v-model="endDateInput" :aria-describedby="interpId" placeholder="same day" class="tnum w-full" />
          </UFormField>
          <UFormField label="End">
            <UInput v-model="endInput" :aria-describedby="interpId" placeholder="11:30" class="tnum w-full" />
          </UFormField>
          <UFormField label="or Duration" class="col-span-2 sm:col-span-1">
            <UInput v-model="durInput" :aria-describedby="interpId" placeholder="2h 30m" class="tnum w-full" />
          </UFormField>
        </div>

        <!-- Live interpretation -->
        <div
          class="flex items-center gap-2 rounded-md bg-elevated px-2.5 py-2 text-xs"
          :class="parsed.valid ? 'text-primary' : 'text-muted'"
          :id="interpId"
          aria-live="polite"
        >
          <UIcon name="i-lucide-calendar" class="size-3.5 shrink-0" />
          <span class="tnum">{{ parsed.text }}</span>
        </div>

        <UFormField label="Tags">
          <UInput v-model="tagsInput" placeholder="design, qa" class="w-full" @keydown.enter.prevent="submit" />
        </UFormField>

        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="outline" label="Cancel" @click="open = false" />
          <UButton
            color="primary"
            variant="outline"
            label="Add entry"
            :disabled="!parsed.valid"
            :loading="saving"
            @click="submit"
          />
        </div>
      </div>
    </template>
  </UModal>
</template>
