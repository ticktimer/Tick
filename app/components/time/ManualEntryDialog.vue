<script setup lang="ts">
// Manual entry dialog (560px). Free-text Start date / Start / End date / End /
// or Duration read by interpretEntry() into a live interpretation line (a blank
// End date means the start day; a later one carries the entry past midnight);
// picker-trigger styled as an input; billable
// toggle showing the client-side rate estimate (server re-resolves per Rule 2).
// Submits via entriesStore.addManual — the saved entry sorts into its day group.
// Doubles as "Edit entry" when ui.editEntry is set: opens prefilled and saves
// via entriesStore.updateEntry (the row re-sorts into its day group).
// Edit mode's Delete emits `delete`; the host page runs removal + undo toast.
import type { ChainRef, EntryDto, SessionUser } from '#shared/types'

const ui = useUiStore()
const entriesStore = useEntriesStore()
const catalog = useCatalogStore()
const { user } = useUserSession()

const emit = defineEmits<{ delete: [entry: EntryDto] }>()

const open = computed({
  get: () => ui.manualOpen,
  set: (v: boolean) => {
    if (!v) ui.closeManual()
  }
})

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

/** Captured on open so the title/labels stay stable through the close animation. */
const editing = ref<EntryDto | null>(null)

/** ISO timestamp → local "YYYY-MM-DD" for the free-text date field. */
function toDateInput(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Fresh fields every time the dialog opens — prefilled when editing an entry
watch(() => ui.manualOpen, (v) => {
  if (!v) return
  const e = ui.editEntry
  editing.value = e
  desc.value = e?.name ?? ''
  refChain.value = e?.ref ? { ...e.ref } : null
  billable.value = e?.billable ?? true
  dateInput.value = e ? toDateInput(e.start) : ''
  startInput.value = e ? formatTime(e.start) : ''
  endInput.value = e?.end ? formatTime(e.end) : ''
  // Only an entry that ends on a later day shows its end date; blank = same day
  endDateInput.value = e?.end && toDateInput(e.end) !== toDateInput(e.start) ? toDateInput(e.end) : ''
  durInput.value = ''
  tagsInput.value = e ? e.tags.join(', ') : ''
  saving.value = false
  ui.pickerResult = null
})

// Adopt what the picker chose for us (target 'manual'), then clear it.
// Billable defaults from the resolved project (Rule 2) when one is in the chain.
watch(() => ui.pickerResult, (r) => {
  if (!r || !ui.manualOpen || ui.pickerTarget !== 'manual') return
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

/** Client-side rate estimate: client rate / project resolvedRate / user default. */
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
    if (editing.value) {
      // Edit mode — PATCH; null ref fields clear a removed chain
      await entriesStore.updateEntry(editing.value.id, {
        name: desc.value.trim() || 'Untitled entry',
        refType: refChain.value?.refType ?? null,
        refId: refChain.value?.refId ?? null,
        billable: billable.value,
        start: parsed.value.start!.toISOString(),
        end: parsed.value.end!.toISOString(),
        tags: tags.value
      })
    } else {
      await entriesStore.addManual({
        name: desc.value.trim() || 'Untitled entry',
        refType: refChain.value?.refType,
        refId: refChain.value?.refId,
        billable: billable.value,
        start: parsed.value.start!.toISOString(),
        end: parsed.value.end!.toISOString(),
        tags: tags.value
      })
    }
    ui.closeManual()
  } catch {
    saving.value = false
    return
  }
  saving.value = false
}

/** Edit mode's Delete: close now, let the host page run the real delete flow. */
function requestDelete() {
  if (!editing.value) return
  const entry = editing.value
  ui.closeManual()
  emit('delete', entry)
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
    :title="editing ? 'Edit entry' : 'Manual entry'"
  >
    <template #content>
      <div class="flex flex-col gap-4 p-5">
        <!-- Dialog name comes from :title (Nuxt UI's aria-hidden DialogTitle); this is the visible heading -->
        <h2 class="text-[17px] font-medium text-highlighted">{{ editing ? 'Edit entry' : 'Manual entry' }}</h2>

        <UFormField label="What did you work on?">
          <UInput
            ref="descInput"
            v-model="desc"
            placeholder="e.g. Invoice reconciliation"
            class="w-full"
            @keydown.enter.prevent="submit"
          />
        </UFormField>

        <!-- Ref picker (button styled as input) + billable toggle — stacks <640px -->
        <div class="grid grid-cols-1 items-end gap-2.5 sm:grid-cols-[minmax(0,1fr)_auto]">
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

        <!-- Start date / Start over End date / End / or Duration — the end
             date stays blank for a same-day entry; ≥640px the duration sits
             beside End, below it takes its own full row -->
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

        <div class="flex items-center gap-2">
          <UButton
            v-if="editing"
            color="error"
            variant="ghost"
            size="sm"
            icon="i-lucide-trash-2"
            label="Delete entry"
            @click="requestDelete"
          />
          <div class="ml-auto flex gap-2">
            <UButton color="neutral" variant="outline" label="Cancel" @click="ui.closeManual()" />
            <UButton
              color="primary"
              variant="outline"
              :label="editing ? 'Save' : 'Add entry'"
              :disabled="!parsed.valid"
              :loading="saving"
              @click="submit"
            />
          </div>
        </div>
      </div>
    </template>
  </UModal>
</template>
