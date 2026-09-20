<script setup lang="ts">
// Client / Project / Task picker (520px dialog, 12vh from the top).
// Serves the timer bar, the Manual-entry dialog and SelectionBar's "Move to…":
// reads uiStore.pickerTarget — 'timer' → timerStore.attach(type, id, whichever
// running timer uiStore.pickerTimerId named when the dialog opened, null = the
// draft/composer (ticktimer/Tick#37: "the timer" is no longer a single thing);
// 'manual' → writes uiStore.pickerResult for the dialog to consume;
// 'bulk' → entriesStore.bulkReassign on the selection (plus a "No client /
// project / task" row that clears refs) with an Undo toast.
// Done tasks are hidden; no match → dashed "Create" row (via catalog store);
// keyboard ↑↓ ↵ esc; list paginates at 50 with an "n more…" row.
import type { ChainRef, RefType, SessionUser } from '#shared/types'

const ui = useUiStore()
const timer = useTimerStore()
const catalog = useCatalogStore()
const entriesStore = useEntriesStore()
const toast = useToast()
const { user } = useUserSession()

const open = computed({
  get: () => ui.pickerOpen,
  set: (v: boolean) => {
    if (!v) ui.closePicker()
  }
})

const PAGE = 50

const tab = ref<RefType>('task')
const search = ref('')
const highlighted = ref(0)
const limit = ref(PAGE)
const creating = ref(false)

const searchInput = useTemplateRef<{ inputRef?: HTMLInputElement }>('searchInput')
const listEl = useTemplateRef<HTMLElement>('listEl')

// ── Focus return + screen-reader announcements ─────────────────────────────
// The trigger is remembered on open. When it no longer exists at close (the
// "+" dropdown's menu item unmounts; "Move to…" goes when the selection
// clears) focus lands on the visible "+" (timer target) or <main>, never body.
let returnFocus: HTMLElement | null = null
const announcement = ref('')

watch(() => ui.pickerOpen, (v) => {
  if (!v) return
  if (import.meta.client) returnFocus = document.activeElement as HTMLElement | null
  announcement.value = ''
  tab.value = ui.pickerTab
  search.value = ''
  highlighted.value = 0
  limit.value = PAGE
})

watch([tab, search], () => {
  highlighted.value = 0
  limit.value = PAGE
})

watch(highlighted, async (i) => {
  await nextTick()
  listEl.value?.children[i]?.scrollIntoView?.({ block: 'nearest' })
})

const userRate = computed(() => (user.value as SessionUser | null)?.defaultRate ?? null)

const tabs: { value: RefType, label: string }[] = [
  { value: 'client', label: 'Client' },
  { value: 'project', label: 'Project' },
  { value: 'task', label: 'Task' }
]

interface PickerItem {
  id: string
  name: string
  sub: string
  meta: string
  dot: string | null
}

const allItems = computed<PickerItem[]>(() => {
  const q = search.value.trim().toLowerCase()
  const match = (name: string) => !q || name.toLowerCase().includes(q)

  if (tab.value === 'client') {
    return catalog.clients.filter(c => match(c.name)).map(c => ({
      id: c.id,
      name: c.name,
      sub: `${c.projectCount} project${c.projectCount === 1 ? '' : 's'}`,
      meta: c.rate != null ? `$${c.rate}/h` : userRate.value != null ? `default $${userRate.value}/h` : '',
      dot: c.color
    }))
  }

  if (tab.value === 'project') {
    return catalog.projects.filter(p => !p.archived && match(p.name)).map(p => ({
      id: p.id,
      name: p.name,
      sub: p.clientName ?? 'No client',
      meta: p.estimateMinutes ? `${formatEstimate(p.estimateMinutes)} est.` : '',
      dot: p.clientColor
    }))
  }

  // Tasks — completed ones are hidden
  return catalog.openTasks.filter(t => match(t.name)).map(t => ({
    id: t.id,
    name: t.name,
    sub: t.projectName ? `${t.projectName}${t.clientName ? ' · ' + t.clientName : ''}` : 'Standalone task',
    meta: [
      t.rate != null ? `$${t.rate}/h` : null,
      t.estimateMinutes ? `${formatEstimate(t.estimateMinutes)} est.` : null
    ].filter(Boolean).join(' · '),
    dot: (t.projectId && catalog.projects.find(p => p.id === t.projectId)?.clientColor) || null
  }))
})

const visible = computed(() => allItems.value.slice(0, limit.value))
const moreCount = computed(() => allItems.value.length - visible.value.length)
const showCreate = computed(() => search.value.trim().length > 0 && allItems.value.length === 0)

const placeholder = computed(() =>
  tab.value === 'task' ? 'Search open tasks…' : tab.value === 'client' ? 'Search clients…' : 'Search projects…'
)

/** Display-only chain for pickerResult (server re-resolves per Rule 1). */
function buildChain(refType: RefType, refId: string): ChainRef {
  const chain: ChainRef = { refType, refId }
  if (refType === 'task') {
    const t = catalog.tasks.find(x => x.id === refId)
    if (t) {
      chain.taskId = t.id
      chain.taskName = t.name
      if (t.projectId) {
        chain.projectId = t.projectId
        chain.projectName = t.projectName ?? undefined
        chain.clientName = t.clientName ?? undefined
        chain.clientColor = catalog.projects.find(p => p.id === t.projectId)?.clientColor ?? undefined
      }
    }
  } else if (refType === 'project') {
    const p = catalog.projects.find(x => x.id === refId)
    if (p) {
      chain.projectId = p.id
      chain.projectName = p.name
      chain.clientId = p.clientId ?? undefined
      chain.clientName = p.clientName ?? undefined
      chain.clientColor = p.clientColor ?? undefined
    }
  } else {
    const c = catalog.clients.find(x => x.id === refId)
    if (c) {
      chain.clientId = c.id
      chain.clientName = c.name
      chain.clientColor = c.color
    }
  }
  return chain
}

function pick(refType: RefType, refId: string) {
  if (ui.pickerTarget === 'timer') {
    // pickerTimerId is passed straight through, `null` included: null means
    // "the draft", which is a decision already made when the dialog opened.
    // Collapsing it to undefined would make the store work the target out again
    // now — and "now" can be after a refocus hydrate pulled in a timer started
    // on another device, which would land this ref on that timer instead of on
    // the draft the user was actually filling in.
    //
    // A rejection here is a 404: the timer was stopped from the running list or
    // on another device while the dialog sat open. Re-sync and let the server
    // win, like every other 4xx path — silently swallowing it left the picker
    // looking like it had worked and the store believing in a timer that had
    // already ended.
    timer.attach(refType, refId, ui.pickerTimerId).catch(() => timer.hydrate())
  } else if (ui.pickerTarget === 'bulk') {
    const chain = buildChain(refType, refId)
    void bulkMove(refType, refId, chain.taskName ?? chain.projectName ?? chain.clientName ?? 'target')
    return
  } else {
    ui.pickerResult = buildChain(refType, refId)
  }
  ui.closePicker()
}

// ── Bulk reassign ("Move to…"): move the selection, toast with Undo ─────────
const moving = ref(false)

async function bulkMove(refType: RefType | null, refId: string | null, name: string) {
  if (moving.value) return
  moving.value = true
  try {
    const res = await entriesStore.bulkReassign(refType, refId)
    ui.closePicker()
    if (!res) return
    const n = res.dtos.length
    toast.add({
      title: `${n} ${n === 1 ? 'entry' : 'entries'} moved to ${name}`,
      icon: 'i-lucide-folder-input',
      color: 'neutral',
      duration: ui.undoSeconds * 1000, // Rule 4: 3–30s, Settings → Profile
      actions: [{
        label: 'Undo',
        color: 'primary',
        variant: 'outline',
        onClick: () => {
          entriesStore.undoReassign(res.prev).catch(() => {})
        }
      }]
    })
  } catch {
    // reassign failed — keep the picker open so the user can retry
  } finally {
    moving.value = false
  }
}

async function createFromSearch() {
  const name = search.value.trim()
  if (!name || creating.value) return
  creating.value = true
  try {
    if (tab.value === 'client') {
      const dto = await catalog.createClient({ name })
      pick('client', dto.id)
    } else if (tab.value === 'project') {
      const dto = await catalog.createProject({ name })
      pick('project', dto.id)
    } else {
      const dto = await catalog.createTask({ name })
      if (dto) pick('task', dto.id)
    }
  } catch {
    // creation failed — keep the picker open so the user can retry
  } finally {
    creating.value = false
  }
}

// Result count after typing (not on every arrow move)
watch([search, tab], () => {
  if (!ui.pickerOpen) return
  const n = allItems.value.length
  announcement.value = n
    ? `${n} ${n === 1 ? 'result' : 'results'}`
    : search.value.trim() ? `No matches — press Enter to create “${search.value.trim()}”` : 'Nothing here yet'
})

function onKeydown(e: KeyboardEvent) {
  const count = visible.value.length
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (count) highlighted.value = (highlighted.value + 1) % count
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (count) highlighted.value = (highlighted.value - 1 + count) % count
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const it = visible.value[highlighted.value]
    if (it) pick(tab.value, it.id)
    else if (showCreate.value) createFromSearch()
  }
}

// ── ARIA combobox/listbox wiring ─────────────────────────────────────────
// Each option gets a stable id (`picker-option-<catalog id>`); the input
// references the highlighted one via aria-activedescendant so screen readers
// announce it as arrow keys move — which is also why the old polite
// `announceHighlighted()` status line was dropped above: with
// aria-activedescendant wired up, announcing the same text again on every
// arrow press would just be a duplicate. The result-count announcement above
// (after typing/switching tabs) stays, since activedescendant says nothing
// about how many results there are.
function optionId(id: string): string {
  return `picker-option-${id}`
}

const activeDescendant = computed(() => {
  const it = visible.value[highlighted.value]
  return it ? optionId(it.id) : undefined
})

const listboxLabel = computed(() => {
  const noun = tab.value === 'task' ? 'Tasks' : tab.value === 'client' ? 'Clients' : 'Projects'
  return `${noun} matching search`
})

// ── Tablist keyboard model (APG Tabs, automatic activation) ─────────────────
// Roving tabindex: only the active tab is in the Tab sequence (wired via
// `:tabindex` below); Left/Right (wrapping) and Home/End move both the
// selection and focus together, since switching tabs here just re-filters
// the same panel and costs nothing to activate immediately.
function onTabsKeydown(e: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
  e.preventDefault()
  const i = tabs.findIndex(t => t.value === tab.value)
  const last = tabs.length - 1
  const next = e.key === 'Home'
    ? 0
    : e.key === 'End'
      ? last
      : e.key === 'ArrowRight'
        ? (i + 1) % tabs.length
        : (i - 1 + tabs.length) % tabs.length
  tab.value = tabs[next]!.value
  nextTick(() => {
    (e.currentTarget as HTMLElement)?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus()
  })
}

/** Keep the dialog from focusing the first tab button; focus the search instead. */
function onOpenAutoFocus(e: Event) {
  e.preventDefault()
  nextTick(() => searchInput.value?.inputRef?.focus())
}

function onCloseAutoFocus(e: Event) {
  const el = returnFocus
  returnFocus = null
  let target: HTMLElement | null = el?.isConnected && !el.closest('[role="menu"]') ? el : null
  if (!target && ui.pickerTarget === 'timer') {
    target = [...document.querySelectorAll<HTMLElement>('button[aria-label="Add client, project or task"]')]
      .find(b => b.offsetParent !== null) ?? null
  }
  target ??= document.getElementById('main')
  if (!target) return
  e.preventDefault()
  target.focus()
}
</script>

<template>
  <!-- z-20 keeps the picker above the Manual-entry dialog (modal slots are
       z-auto, so DOM order would otherwise decide); toasts sit at z-[100].
       <640px the dialog docks to the bottom edge as a sheet (grab handle,
       full width, top corners only). -->
  <UModal
    v-model:open="open"
    :ui="{
      overlay: 'z-20',
      content: 'top-[12vh] translate-y-0 max-w-[520px] z-20 max-sm:top-auto max-sm:bottom-0 max-sm:left-0 max-sm:translate-x-0 max-sm:w-full max-sm:max-w-full max-sm:rounded-b-none'
    }"
    :content="{ onOpenAutoFocus, onCloseAutoFocus }"
    title="Pick a client, project or task"
    description="Type to search, arrow keys to move, Enter to pick, Escape to close."
  >
    <template #content>
      <!-- Grab handle (bottom sheet only) -->
      <div class="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-accented sm:hidden" aria-hidden="true" />
      <div class="flex flex-col gap-3 p-4 max-sm:pb-[max(16px,env(safe-area-inset-bottom))]">
        <!-- Tabs: a real tabpanel below (id="picker-panel") is what
             aria-controls points at — the panel holds the search input, the
             bulk-clear row and the results, all of which change with `tab`.
             The combobox's own aria-controls points at the results listbox
             separately; a tablist with no tabpanel at all (as if aria-controls
             referenced the listbox here too) leaves screen readers announcing
             "tab, 1 of 3" with nothing to go to. Roving tabindex (only the
             active tab is a Tab stop) plus onTabsKeydown's Left/Right/Home/End
             give it the rest of the APG Tabs keyboard model. -->
        <div class="flex gap-1" role="tablist" aria-label="Pick type" @keydown="onTabsKeydown">
          <UButton
            v-for="t in tabs"
            :id="`picker-tab-${t.value}`"
            :key="t.value"
            :label="t.label"
            size="sm"
            variant="outline"
            :color="tab === t.value ? 'primary' : 'neutral'"
            :class="[tab === t.value ? '' : 'text-toned', 'max-sm:min-h-11 max-sm:px-4']"
            role="tab"
            :aria-selected="tab === t.value"
            :tabindex="tab === t.value ? 0 : -1"
            aria-controls="picker-panel"
            @click="tab = t.value"
          />
        </div>

        <div id="picker-panel" role="tabpanel" :aria-labelledby="`picker-tab-${tab}`" class="flex flex-col gap-3">
          <!-- Search: ARIA combobox wired to the results listbox below -->
          <UInput
            ref="searchInput"
            v-model="search"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls="picker-results"
            :aria-activedescendant="activeDescendant"
            icon="i-lucide-search"
            :placeholder="placeholder"
            :aria-label="placeholder"
            size="lg"
            class="w-full"
            @keydown="onKeydown"
          />

          <!-- Bulk mode: clear the selection's refs -->
          <button
            v-if="ui.pickerTarget === 'bulk'"
            type="button"
            class="focus-visible:outline-offset-[-2px] flex items-center gap-3 rounded-md px-2.5 py-[9px] text-left hover:bg-[color-mix(in_srgb,var(--ui-text)_7%,transparent)] max-sm:min-h-12"
            :disabled="moving"
            @click="bulkMove(null, null, 'No client / project / task')"
          >
            <span class="size-2 shrink-0 rounded-full border border-dashed border-accented" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm text-highlighted">No client / project / task</span>
              <span class="block truncate text-xs text-muted">Clear the assignment on the selected entries</span>
            </span>
          </button>

          <!-- Results -->
          <!-- Arrow-key position / result count, read out politely -->
          <div role="status" class="sr-only">{{ announcement }}</div>

          <!-- The listbox is the scroll container itself (not a wrapper div
               around it): axe's scrollable-region-focusable wants a scroller
               with either a focusable descendant or a combobox pointed at it
               (this one has both — the options, and the search input above
               via aria-controls). "Show more"/"Create…" are real buttons kept
               OUTSIDE the scroll area so they can't be scrolled out of reach
               and are never mistaken for the thing that needs to satisfy
               that rule. Options are div/li, not buttons, so they're never
               separate tab stops (focus stays in the search input; ↑↓↵esc
               still drive it). -->
          <div class="flex flex-col gap-px">
            <div
              id="picker-results"
              ref="listEl"
              role="listbox"
              :aria-label="listboxLabel"
              class="flex max-h-[340px] flex-col gap-px overflow-y-auto max-sm:max-h-[45vh]"
            >
              <div
                v-for="(it, i) in visible"
                :id="optionId(it.id)"
                :key="it.id"
                role="option"
                :aria-selected="i === highlighted"
                class="flex cursor-pointer items-center gap-3 rounded-md px-2.5 py-[9px] text-left max-sm:min-h-12"
                :class="i === highlighted
                  ? 'bg-[color-mix(in_srgb,var(--ui-text)_7%,transparent)]'
                  : 'hover:bg-[color-mix(in_srgb,var(--ui-text)_7%,transparent)]'"
                @mousemove="highlighted = i"
                @click="pick(tab, it.id)"
              >
                <span class="size-2 shrink-0 rounded-full" :style="{ background: clientColorVar(it.dot) }" />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm text-highlighted">{{ it.name }}</span>
                  <span v-if="it.sub" class="block truncate text-xs text-muted">{{ it.sub }}</span>
                </span>
                <span class="tnum shrink-0 text-xs text-muted">{{ it.meta }}</span>
              </div>
            </div>

            <button
              v-if="moreCount > 0"
              type="button"
              class="focus-visible:outline-offset-[-2px] flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-primary hover:bg-[color-mix(in_srgb,var(--ui-text)_7%,transparent)] max-sm:min-h-11"
              @click="limit += PAGE"
            >
              <UIcon name="i-lucide-chevron-down" class="size-3.5 shrink-0" />
              Show {{ moreCount }} more
            </button>

            <button
              v-if="showCreate"
              type="button"
              class="focus-visible:outline-offset-[-2px] flex items-center gap-3 rounded-md border border-dashed border-default px-2.5 py-[9px] text-left text-sm text-primary hover:bg-[color-mix(in_srgb,var(--ui-text)_7%,transparent)] max-sm:min-h-12"
              :disabled="creating"
              @click="createFromSearch"
            >
              <UIcon name="i-lucide-plus" class="size-3.5 shrink-0" />
              <span class="truncate">Create “{{ search.trim() }}”</span>
            </button>

            <div v-if="!visible.length && !showCreate" class="px-2.5 py-3 text-[13px] text-muted">
              Nothing here yet — type a name to create one.
            </div>
          </div>
        </div>

        <!-- Footer hint -->
        <p class="text-[11px] text-muted">
          Picking a task brings its project and client along. ↑↓ move · ↵ pick · esc close
        </p>
      </div>
    </template>
  </UModal>
</template>
