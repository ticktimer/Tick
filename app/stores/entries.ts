// Entries store — list for the Time page plus selection / filter / undo state.
// The `filtered` getter implements the free-text filter: `#tag`, `@name` (chain), plain text (name).

export interface ManualEntryPayload {
  name: string
  refType?: RefType
  refId?: string
  billable?: boolean
  rateOverride?: number | null
  start: string
  end: string
  tags?: string[]
}

/** PATCH payload — like ManualEntryPayload but ref fields accept null to clear the ref. */
export type EntryPatch = Partial<Omit<ManualEntryPayload, 'refType' | 'refId'>> & {
  refType?: RefType | null
  refId?: string | null
}

/** Per-entry ref snapshot taken before a bulk reassign, for undo. */
export interface ReassignPrev {
  id: string
  refType: RefType | null
  refId: string | null
}

export const useEntriesStore = defineStore('entries', () => {
  // SSR-safe fetch: forwards the request's cookies when a page fetches during
  // server render (plain $fetch would hit the API unauthenticated). On the
  // client this is just $fetch.
  const requestFetch = useRequestFetch()

  const entries = ref<EntryDto[]>([])
  const selection = ref<Set<string>>(new Set())
  const filter = ref('')
  const groupBy = ref<'day' | 'project'>('day')
  const undoStack = ref<DeleteResult[]>([])
  const lastRange = ref<{ from: string, to: string } | null>(null)

  /** Entries passing the free-text filter. Tokens: `#tag` matches tags, `@name` matches chain names, else name/tags/chain. */
  const filtered = computed<EntryDto[]>(() => {
    const q = filter.value.trim().toLowerCase()
    if (!q) return entries.value
    const tokens = q.split(/\s+/)
    return entries.value.filter((e) => {
      const name = e.name.toLowerCase()
      const tags = e.tags.map(t => t.toLowerCase())
      const chain = [e.ref?.taskName, e.ref?.projectName, e.ref?.clientName]
        .filter((s): s is string => !!s)
        .map(s => s.toLowerCase())
      return tokens.every((t) => {
        if (t.startsWith('#')) {
          const tag = t.slice(1)
          return !tag || tags.some(x => x.includes(tag))
        }
        if (t.startsWith('@')) {
          const n = t.slice(1)
          return !n || chain.some(x => x.includes(n))
        }
        return name.includes(t) || tags.some(x => x.includes(t)) || chain.some(x => x.includes(t))
      })
    })
  })

  const selectedIds = computed(() => [...selection.value])
  const hasSelection = computed(() => selection.value.size > 0)

  function sortDesc() {
    entries.value.sort((a, b) => new Date(b.start).getTime() - new Date(a.start).getTime())
  }

  /** GET /api/entries?from&to (ISO). Excludes running + trashed server-side. */
  async function fetchRange(from: string, to: string) {
    lastRange.value = { from, to }
    entries.value = await requestFetch<EntryDto[]>('/api/entries', { query: { from, to } })
    return entries.value
  }

  async function refresh() {
    if (lastRange.value) await fetchRange(lastRange.value.from, lastRange.value.to)
  }

  /** POST /api/entries — saved entry sorts into its day group. */
  async function addManual(payload: ManualEntryPayload) {
    const dto = await $fetch<EntryDto>('/api/entries', { method: 'POST', body: payload })
    entries.value.push(dto)
    sortDesc()
    return dto
  }

  /** PATCH /api/entries/:id (partial fields, e.g. { billable }). Re-sorts so date edits regroup. */
  async function updateEntry(id: string, patch: EntryPatch) {
    const dto = await $fetch<EntryDto>(`/api/entries/${id}`, { method: 'PATCH', body: patch })
    const i = entries.value.findIndex(e => e.id === id)
    if (i >= 0) entries.value.splice(i, 1, dto)
    sortDesc()
    return dto
  }

  /** DELETE /api/entries/:id — soft delete (Rule 4); result pushed on undoStack. */
  async function remove(id: string) {
    const result = await $fetch<DeleteResult>(`/api/entries/${id}`, { method: 'DELETE' })
    entries.value = entries.value.filter(e => e.id !== id)
    selection.value.delete(id)
    selection.value = new Set(selection.value)
    undoStack.value.push(result)
    return result
  }

  /** POST /api/entries/bulk {action:'delete'} on the current selection. */
  async function bulkDelete() {
    const ids = [...selection.value]
    if (!ids.length) return null
    const result = await $fetch<DeleteResult>('/api/entries/bulk', {
      method: 'POST',
      body: { ids, action: 'delete' }
    })
    entries.value = entries.value.filter(e => !selection.value.has(e.id))
    selection.value = new Set()
    undoStack.value.push(result)
    return result
  }

  /** POST /api/entries/bulk {action:'billable'} on the current selection, then refetch (amounts resolve server-side). */
  async function bulkBillable(billable: boolean) {
    const ids = [...selection.value]
    if (!ids.length) return 0
    const count = await $fetch<number>('/api/entries/bulk', {
      method: 'POST',
      body: { ids, action: 'billable', billable }
    })
    selection.value = new Set()
    await refresh()
    return count
  }

  /**
   * POST /api/entries/bulk {action:'reassign'} — moves entries to the deepest
   * ref (Rule 1); null refType/refId clears the ref. Defaults to the current
   * selection (and clears it); pass `ids` to act on explicit rows (undo path).
   * Returns the updated dtos plus a prior-ref snapshot for undo.
   */
  async function bulkReassign(refType: RefType | null, refId: string | null, ids?: string[]) {
    const targetIds = ids ?? [...selection.value]
    if (!targetIds.length) return null
    const idSet = new Set(targetIds)
    const prev: ReassignPrev[] = entries.value
      .filter(e => idSet.has(e.id))
      .map(e => ({ id: e.id, refType: e.ref?.refType ?? null, refId: e.ref?.refId ?? null }))
    const dtos = await $fetch<EntryDto[]>('/api/entries/bulk', {
      method: 'POST',
      body: { ids: targetIds, action: 'reassign', refType, refId }
    })
    const byId = new Map(dtos.map(d => [d.id, d]))
    entries.value = entries.value.map(e => byId.get(e.id) ?? e)
    if (!ids) selection.value = new Set()
    return { dtos, prev }
  }

  /** Undo a bulkReassign: restore each entry's previous ref, one call per prior target. */
  async function undoReassign(prev: ReassignPrev[]) {
    const groups = new Map<string, { refType: RefType | null, refId: string | null, ids: string[] }>()
    for (const p of prev) {
      const key = `${p.refType ?? ''}:${p.refId ?? ''}`
      const g = groups.get(key)
      if (g) g.ids.push(p.id)
      else groups.set(key, { refType: p.refType, refId: p.refId, ids: [p.id] })
    }
    for (const g of groups.values()) await bulkReassign(g.refType, g.refId, g.ids)
  }

  /** POST /api/restore with a DeleteResult snapshot (undo toast). */
  async function restore(deleted: DeleteResult) {
    await $fetch('/api/restore', { method: 'POST', body: { deleted: deleted.deleted } })
    const i = undoStack.value.indexOf(deleted)
    if (i >= 0) undoStack.value.splice(i, 1)
    await refresh()
  }

  /** Insert the EntryDto returned by POST /api/timers/:id/stop at the top of Today. */
  function applyStoppedEntry(dto: EntryDto) {
    entries.value = entries.value.filter(e => e.id !== dto.id)
    entries.value.unshift(dto)
    sortDesc()
  }

  function toggleSelect(id: string) {
    const next = new Set(selection.value)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    selection.value = next
  }

  function clearSelection() {
    selection.value = new Set()
  }

  return {
    entries,
    selection,
    filter,
    groupBy,
    undoStack,
    lastRange,
    filtered,
    selectedIds,
    hasSelection,
    fetchRange,
    refresh,
    addManual,
    updateEntry,
    remove,
    bulkDelete,
    bulkBillable,
    bulkReassign,
    undoReassign,
    restore,
    applyStoppedEntry,
    toggleSelect,
    clearSelection
  }
})
