// UI store — cross-component dialog state.
// PickerModal (time agent) reads pickerOpen/pickerTarget/pickerTab and writes pickerResult
// for the manual-entry dialog; the timer bar and pages only flip this state.
// pickerTarget 'bulk' = SelectionBar's "Move to…" (picker reassigns the selection itself).
// pickerTarget 'timer' also carries pickerTimerId: since ticktimer/Tick#37 several
// timers can run at once, so "the timer" is not a thing the picker can work out
// for itself — the opener names the row it means.

export type PickerTarget = 'timer' | 'manual' | 'bulk'

export const useUiStore = defineStore('ui', () => {
  const pickerOpen = ref(false)
  const pickerTarget = ref<PickerTarget>('timer')
  /** Which tab the picker opens on (set by the timer bar's + menu). */
  const pickerTab = ref<RefType>('task')
  /**
   * Target 'timer' only: which running timer the pick attaches to. null means
   * the draft/composer. Captured when the picker opens so a background
   * re-hydrate (another device starting a timer) can't move the target while
   * the dialog is open.
   */
  const pickerTimerId = ref<string | null>(null)
  /** Set by PickerModal when target is 'manual'; ManualEntryDialog consumes + clears it. */
  const pickerResult = ref<ChainRef | null>(null)

  const manualOpen = ref(false)
  /** When set, ManualEntryDialog opens prefilled in edit mode for this entry. */
  const editEntry = ref<EntryDto | null>(null)

  const cascade = ref<{ open: boolean, kind: 'client' | 'project', id: string | null }>({
    open: false,
    kind: 'client',
    id: null
  })

  // ── Undo window preference (Rule 4: default 8s, configurable 3–30s) ───────
  // Every undo toast (entry delete, bulk, cascade, tag delete, bulk move)
  // reads this. localStorage-backed; hydrated client-side after mount (same
  // pattern as useDashboardCards) so SSR/hydration never disagree.
  const UNDO_KEY = 'tick-undo-seconds'
  const undoSeconds = ref(8)

  const clampUndo = (n: number) => Math.min(30, Math.max(3, Math.round(n)))

  /** Read saved prefs on the client after hydration (default layout calls this). */
  function hydratePrefs() {
    if (!import.meta.client) return
    try {
      const raw = localStorage.getItem(UNDO_KEY)
      if (raw != null && Number.isFinite(Number(raw))) undoSeconds.value = clampUndo(Number(raw))
    } catch { /* corrupt prefs — keep the default */ }
  }

  function setUndoSeconds(n: number) {
    undoSeconds.value = clampUndo(n)
    try {
      localStorage.setItem(UNDO_KEY, String(undoSeconds.value))
    } catch { /* storage unavailable — pref just won't persist */ }
  }

  function openPicker(target: PickerTarget, tab: RefType = 'task', timerId: string | null = null) {
    pickerTarget.value = target
    pickerTab.value = tab
    pickerTimerId.value = timerId
    pickerOpen.value = true
  }

  function closePicker() {
    pickerOpen.value = false
    pickerTimerId.value = null
  }

  function openManual() {
    editEntry.value = null
    manualOpen.value = true
  }

  function openEdit(entry: EntryDto) {
    editEntry.value = entry
    manualOpen.value = true
  }

  function closeManual() {
    manualOpen.value = false
    editEntry.value = null
  }

  function openCascade(kind: 'client' | 'project', id: string) {
    cascade.value = { open: true, kind, id }
  }

  function closeCascade() {
    cascade.value = { ...cascade.value, open: false, id: null }
  }

  return {
    pickerOpen,
    pickerTarget,
    pickerTab,
    pickerTimerId,
    pickerResult,
    manualOpen,
    editEntry,
    cascade,
    undoSeconds,
    hydratePrefs,
    setUndoSeconds,
    openPicker,
    closePicker,
    openManual,
    openEdit,
    closeManual,
    openCascade,
    closeCascade
  }
})
