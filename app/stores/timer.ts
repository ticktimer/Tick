// Timer store — the server is the source of truth (a running timer is just a
// time_entries row with end IS NULL). Since ticktimer/Tick#37 a user may run up
// to MAX_RUNNING_TIMERS of them at once, so the state is a *list*:
// GET /api/timers hydrates it on app mount and every mutation addresses one row
// by id.
//
// Clocks are DERIVED, never stored. One interval for the whole app ticks
// `nowMs` once a second while anything runs; `elapsedFor(id)` /
// `activeElapsedSec` / `totalElapsedSec` compute from it. N timers must never
// mean N intervals — that is the whole reason elapsed seconds aren't state.
//
// Two things the bar can be showing: the *active* timer (the pinned one, else
// the newest) or the *draft* — the composer for the next timer, which survives
// a reload in localStorage. `composing` says which, and is forced true whenever
// nothing is running, so an empty app behaves exactly as it did before #37.
import { MAX_RUNNING_TIMERS } from '#shared/utils/timers'

interface TimerPatch {
  name?: string
  refType?: RefType
  refId?: string | null
  billable?: boolean
}

interface StartPayload {
  name?: string
  refType?: RefType
  refId?: string
  billable?: boolean
}

export const useTimerStore = defineStore('timer', () => {
  const session = useUserSession()

  /** Server truth, kept in the server's order: start ASC, id ASC. */
  const timers = ref<TimerState[]>([])

  /**
   * Which running timer sits in the bar. A per-device view preference (like the
   * theme), not a DB column — localStorage `tick-timer-pinned`, read after
   * mount by hydratePinned() so SSR and the first client render agree.
   */
  const pinnedId = ref<string | null>(null)

  /** The one shared clock source. Every elapsed figure in the app derives from it. */
  const nowMs = ref(Date.now())

  // Idle draft — what the timer bar shows before a timer exists server-side.
  // Persisted to localStorage so a typed name / attached chip survives a
  // reload; cleared once the draft is consumed (start).
  const draftName = ref('')
  const draftRef = ref<ChainRef | null>(null)
  const draftBillable = ref(true)

  const DRAFT_KEY = 'tick-timer-draft'
  const PINNED_KEY = 'tick-timer-pinned'
  let draftWatching = false
  let pinnedHydrated = false

  /**
   * Restore the saved idle draft and start persisting changes. Called from the
   * default layout's onMounted — i.e. after hydration, so the SSR'd empty
   * timer bar and the first client render still agree (no mismatch).
   */
  function hydrateDraft() {
    if (!import.meta.client || draftWatching) return
    try {
      const raw = localStorage.getItem(DRAFT_KEY)
      if (raw) {
        const d = JSON.parse(raw) as { name?: string, ref?: ChainRef | null, billable?: boolean }
        if (typeof d.name === 'string') draftName.value = d.name
        if (d.ref && typeof d.ref === 'object' && d.ref.refType && d.ref.refId) draftRef.value = d.ref
        if (typeof d.billable === 'boolean') draftBillable.value = d.billable
      }
    } catch { /* corrupt draft — start clean */ }

    draftWatching = true
    watch([draftName, draftRef, draftBillable], ([name, r, billable]) => {
      try {
        if (!name && !r && billable) localStorage.removeItem(DRAFT_KEY)
        else localStorage.setItem(DRAFT_KEY, JSON.stringify({ name, ref: r, billable }))
      } catch { /* storage unavailable */ }
    })
  }

  /**
   * Restore the pinned timer id. Same late-hydration contract as hydrateDraft:
   * client only, after mount, never during SSR. Writes go through setPinned(),
   * so there is no watcher to keep in sync.
   */
  function hydratePinned() {
    if (!import.meta.client || pinnedHydrated) return
    pinnedHydrated = true
    try {
      const raw = localStorage.getItem(PINNED_KEY)
      if (raw) pinnedId.value = raw
    } catch { /* storage unavailable — the newest timer just stays in the bar */ }
  }

  function setPinned(id: string | null) {
    pinnedId.value = id
    if (!import.meta.client) return
    try {
      if (id) localStorage.setItem(PINNED_KEY, id)
      else localStorage.removeItem(PINNED_KEY)
    } catch { /* storage unavailable — the pin just won't survive a reload */ }
  }

  function clearDraft() {
    draftName.value = ''
    draftRef.value = null
    draftBillable.value = true
    if (import.meta.client) {
      try {
        localStorage.removeItem(DRAFT_KEY)
      } catch { /* storage unavailable */ }
    }
  }

  // ── Running list disclosure ────────────────────────────────────────────────
  // Store state, not a ref in each bar: the desktop bar and the mobile dock
  // each mount a list (one is CSS-hidden) and must agree, and the moments that
  // should open it are not all button clicks in a bar. The rule is one
  // sentence — whenever a timer is about to leave the bar, open the list so it
  // lands somewhere visible. That happens on compose() and on any start while
  // something already runs, including a ▶ on an entry row or a calendar block.
  // With the list closed, the first timer simply looked like it had vanished
  // the moment "Add a timer" was pressed.
  const listOpen = ref(false)

  function openList() {
    listOpen.value = true
  }

  function closeList() {
    listOpen.value = false
  }

  function toggleList() {
    listOpen.value = !listOpen.value
  }

  // Nothing left to disclose — never leave an empty panel pinned open.
  watch(() => timers.value.length, (n) => {
    if (n === 0) listOpen.value = false
  })

  // ── Composer ───────────────────────────────────────────────────────────────
  // `composing` is derived rather than plain state so "forced true whenever
  // nothing runs" is structural: there is no reachable state where the bar
  // shows an active timer that doesn't exist.
  const composingRaw = ref(false)
  const composing = computed(() => composingRaw.value || timers.value.length === 0)

  function compose() {
    composingRaw.value = true
    // The running timer is leaving the bar for the list.
    listOpen.value = true
  }

  /** Cancel = discard: the draft goes too, so the next "Add a timer" is blank. */
  function cancelCompose() {
    composingRaw.value = false
    clearDraft()
  }

  // ── Getters ────────────────────────────────────────────────────────────────
  const running = computed(() => timers.value.length > 0)
  const count = computed(() => timers.value.length)
  const atCap = computed(() => count.value >= MAX_RUNNING_TIMERS)

  /** The timer the bar shows: the pinned one while it still runs, else the newest. */
  const activeTimer = computed<TimerState | null>(() => {
    if (!timers.value.length) return null
    if (pinnedId.value) {
      const pinned = timers.value.find(t => t.entryId === pinnedId.value)
      if (pinned) return pinned
    }
    // The list is kept in the server's start ASC, id ASC order, so the last
    // row is the greatest start — the same tiebreak the server would apply.
    return timers.value[timers.value.length - 1] ?? null
  })

  function elapsedOf(t: TimerState): number {
    return Math.max(0, Math.floor((nowMs.value - new Date(t.start).getTime()) / 1000))
  }

  /** Live seconds for one running timer; 0 for an id that isn't running. */
  function elapsedFor(id: string): number {
    const t = timers.value.find(x => x.entryId === id)
    return t ? elapsedOf(t) : 0
  }

  const activeElapsedSec = computed(() => activeTimer.value ? elapsedOf(activeTimer.value) : 0)

  /**
   * The clock the bar shows — the active timer's, or 00:00:00 while composing.
   * The bars used to read `activeElapsedSec` directly, so in compose mode the
   * digits kept counting the timer that had just left the bar: dimmed, with a
   * play button beside them, and it read as "a new timer started on its own,
   * already at 00:04:12". Nothing had started. The draft has no elapsed time.
   */
  const currentElapsedSec = computed(() => composing.value ? 0 : activeElapsedSec.value)

  /** Every running timer added together — what "Today" on the dashboard adds. */
  const totalElapsedSec = computed(() => timers.value.reduce((acc, t) => acc + elapsedOf(t), 0))

  /** Chain currently shown in the timer bar (active timer's ref, else the draft). */
  const currentRef = computed<ChainRef | null>(() =>
    composing.value ? draftRef.value : (activeTimer.value?.ref ?? null)
  )

  const currentName = computed(() =>
    composing.value ? draftName.value : (activeTimer.value?.name ?? '')
  )

  const billable = computed(() =>
    composing.value ? draftBillable.value : (activeTimer.value?.billable ?? true)
  )

  /** $/h shown in the timer bar. Running: server-resolved. Draft: display-only guess from catalog DTOs (server re-resolves on start). */
  const resolvedRate = computed<number | null>(() => {
    if (!composing.value && activeTimer.value) return activeTimer.value.resolvedRate
    const userRate = (session.user.value as SessionUser | null)?.defaultRate ?? null
    const r = draftRef.value
    if (!r) return userRate
    const catalog = useCatalogStore()
    if (r.refType === 'client') {
      const c = catalog.clients.find(x => x.id === r.refId)
      return c?.rate ?? userRate
    }
    const projectId = r.refType === 'project' ? r.refId : r.projectId
    if (projectId) {
      const p = catalog.projects.find(x => x.id === projectId)
      if (p) return p.resolvedRate ?? userRate
    }
    return userRate
  })

  // ── The one interval ───────────────────────────────────────────────────────
  let tickHandle: ReturnType<typeof setInterval> | null = null

  function startTicking() {
    nowMs.value = Date.now()
    if (tickHandle || !import.meta.client) return
    tickHandle = setInterval(() => (nowMs.value = Date.now()), 1000)
  }

  function stopTicking() {
    if (!tickHandle) return
    clearInterval(tickHandle)
    tickHandle = null
  }

  /** One interval for the whole app: on while anything runs, off otherwise. */
  function syncTicking() {
    if (timers.value.length) startTicking()
    else stopTicking()
  }

  /** Restore the server's order (start ASC, id ASC) after a local insert. */
  function sortTimers() {
    timers.value.sort((a, b) => {
      const d = new Date(a.start).getTime() - new Date(b.start).getTime()
      if (d !== 0) return d
      return a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0
    })
  }

  /**
   * Which timer an action addresses. Three-way on purpose:
   *   a string    → that timer,
   *   null        → the draft, explicitly,
   *   undefined   → work it out now (active timer, or the draft while composing).
   *
   * null and undefined are NOT the same answer. The picker names its target
   * when it opens — including `null` for "the draft" — precisely so that a
   * background re-hydrate can't move the target while the dialog is open.
   * Collapsing null to undefined here would re-resolve at pick time and PATCH
   * the ref onto whichever timer happened to arrive in the meantime.
   */
  function targetFor(id?: string | null): string | null {
    if (id !== undefined) return id
    if (composing.value) return null
    return activeTimer.value?.entryId ?? null
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  /** GET /api/timers — call once on app mount (default layout). Survives reloads. */
  let lastHydrateAt = 0

  async function hydrate() {
    lastHydrateAt = Date.now()
    let next: TimerState[]
    try {
      next = await $fetch<TimerState[]>('/api/timers') ?? []
    } catch (err) {
      // Only a 401 is an *answer* — "not signed in, nothing is running". Every
      // other failure (offline, server restart, 502) is the request not
      // arriving, and says nothing at all about the timers. Treating those as
      // an empty list took every clock on screen down until the next hydrate,
      // and, worse, the reconciliation below then read that empty list as "the
      // pinned timer is gone" and deleted tick-timer-pinned from localStorage.
      // The blanking healed itself on the next poll; the erased preference
      // never did. So: keep what we have, and never reconcile the pin against
      // a list that never arrived.
      if (errorStatus(err) === 401) {
        timers.value = []
        stopTicking()
      }
      return
    }
    timers.value = next
    sortTimers()
    // Drop a pin whose timer is gone (stopped on another device, say) so the
    // saved preference can't outlive the row. Only ever against a list the
    // server really returned, and only once hydratePinned() has run: it is
    // synchronous in the same onMounted tick, so it always has by the time this
    // fetch resolves — but a pin must never be cleared before it has been read.
    if (pinnedHydrated && pinnedId.value && !timers.value.some(t => t.entryId === pinnedId.value)) {
      setPinned(null)
    }
    syncTicking()
  }

  /** Re-hydrate on tab refocus (visibilitychange/focus), at most every `minMs`. */
  async function hydrateIfStale(minMs = 5000) {
    if (Date.now() - lastHydrateAt < minMs) return
    await hydrate()
  }

  /**
   * POST /api/timers. Starts an *additional* timer; nothing is stopped. Throws
   * 409 at the cap (callers surface it; `atCap` disables the affordances that
   * can predict it).
   *
   * A payload, when given, is AUTHORITATIVE — it is not merged field-by-field
   * with the draft. A play button on an entry with no client/project/task
   * passes no refType/refId, and that means "this has no chain", not "use
   * whatever the composer happens to have attached". Merging made a ref-less
   * "start again" inherit the draft's project and silently track (and bill)
   * against it. Only the bar's own no-payload start() consumes the draft.
   */
  async function start(payload?: StartPayload) {
    const src: StartPayload = payload ?? {
      name: draftName.value,
      billable: draftBillable.value,
      refType: draftRef.value?.refType,
      refId: draftRef.value?.refId
    }
    const body: Record<string, unknown> = { name: src.name ?? '' }
    // Omitted rather than defaulted: the server then applies the project's
    // billable_default (Rule 2) instead of us guessing on its behalf.
    if (src.billable !== undefined) body.billable = src.billable
    if (src.refType && src.refId) {
      body.refType = src.refType
      body.refId = src.refId
    }
    // Whether this start bumps a timer out of the bar (the previous newest, or
    // the one just started when a pin holds the bar). Either way something is
    // about to be on screen only in the list — open it.
    const bumped = timers.value.length > 0
    const created = await $fetch<TimerState>('/api/timers', { method: 'POST', body })
    timers.value = [...timers.value.filter(t => t.entryId !== created.entryId), created]
    sortTimers()
    composingRaw.value = false
    clearDraft() // consumed — the running timer is now the source of truth
    // A start made *here* is deliberate: you pressed play, you want to see it.
    // It becomes the selection, so the bar shows it now and keeps showing it
    // if a timer started elsewhere (another tab, your phone) arrives through
    // hydrate() — that one goes to the list. Which is the whole reason the
    // selection exists: the bar moves when you move it, never on its own.
    setPinned(created.entryId)
    if (bumped) listOpen.value = true
    syncTicking()
    return created
  }

  /**
   * POST /api/timers/:id/stop → EntryDto | null (null = <1s elapsed, discarded
   * server-side). Defaults to the active timer; the others keep running.
   * The draft is deliberately left alone — it is the composer for the *next*
   * timer, and stopping one is not a reason to throw away typed-out work.
   */
  async function stop(id?: string): Promise<EntryDto | null> {
    const targetId = id ?? activeTimer.value?.entryId
    if (!targetId) return null
    const dto = await $fetch<EntryDto | null>(`/api/timers/${targetId}/stop`, { method: 'POST' })
    timers.value = timers.value.filter(t => t.entryId !== targetId)
    if (pinnedId.value === targetId) setPinned(null)
    syncTicking()
    return dto ?? null
  }

  /** PATCH /api/timers/:id; merges into the idle draft when the bar is composing. */
  async function update(patch: TimerPatch, id?: string | null) {
    const targetId = targetFor(id)
    if (targetId) {
      const next = await $fetch<TimerState>(`/api/timers/${targetId}`, { method: 'PATCH', body: patch })
      const i = timers.value.findIndex(t => t.entryId === targetId)
      if (i >= 0) timers.value[i] = next
      else {
        // A 200 for an id we don't have locally: the row is running
        // server-side and our list had drifted (a 401 hydrate emptied it, say).
        // Adding it back without syncTicking() left a running timer with a dead
        // clock — `nowMs` frozen wherever the last tick left it.
        timers.value.push(next)
        sortTimers()
      }
      syncTicking()
      return next
    }
    if (patch.name !== undefined) draftName.value = patch.name
    if (patch.billable !== undefined) draftBillable.value = patch.billable
    if (patch.refId === null) draftRef.value = null
    else if (patch.refType && patch.refId) draftRef.value = buildDraftChain(patch.refType, patch.refId)
    return null
  }

  function setName(name: string, id?: string | null) {
    const targetId = targetFor(id)
    if (!targetId) {
      draftName.value = name
      return
    }
    const current = timers.value.find(t => t.entryId === targetId)
    if (current && name !== current.name) update({ name }, targetId).catch(() => {})
  }

  async function attach(refType: RefType, refId: string, id?: string | null) {
    const targetId = targetFor(id)
    if (targetId) return update({ refType, refId }, targetId)
    draftRef.value = buildDraftChain(refType, refId)
    return null
  }

  async function detach(id?: string | null) {
    const targetId = targetFor(id)
    if (targetId) return update({ refId: null }, targetId)
    draftRef.value = null
    return null
  }

  async function toggleBillable(id?: string | null) {
    const targetId = targetFor(id)
    if (!targetId) {
      draftBillable.value = !draftBillable.value
      return null
    }
    const current = timers.value.find(t => t.entryId === targetId)
    if (!current) return null
    return update({ billable: !current.billable }, targetId)
  }

  /** Keep this timer in the bar even when a newer one starts. */
  function pin(id: string) {
    setPinned(id)
  }

  /** Back to "the newest running timer sits in the bar". */
  function unpin() {
    setPinned(null)
  }

  /** Display-only chain for the idle draft, resolved from catalog DTOs (Rule 1 lives server-side). */
  function buildDraftChain(refType: RefType, refId: string): ChainRef {
    const catalog = useCatalogStore()
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

  return {
    // state
    timers,
    pinnedId,
    nowMs,
    draftName,
    draftRef,
    draftBillable,
    // getters
    composing,
    running,
    count,
    atCap,
    activeTimer,
    elapsedFor,
    activeElapsedSec,
    currentElapsedSec,
    listOpen,
    openList,
    closeList,
    toggleList,
    totalElapsedSec,
    currentRef,
    currentName,
    billable,
    resolvedRate,
    // actions
    hydrate,
    hydrateIfStale,
    hydrateDraft,
    hydratePinned,
    start,
    stop,
    update,
    setName,
    attach,
    detach,
    toggleBillable,
    pin,
    unpin,
    compose,
    cancelCompose
  }
})

/**
 * HTTP status behind a rejected `$fetch`, whatever shape it arrives in —
 * `statusCode` is what ofetch sets; the other two cover a plain
 * Response-shaped rejection. `undefined` means it never reached the server
 * (offline, DNS, connection reset), which is a different thing from any status.
 */
function errorStatus(err: unknown): number | undefined {
  const e = err as { statusCode?: number, status?: number, response?: { status?: number } } | null
  return e?.statusCode ?? e?.status ?? e?.response?.status
}

/**
 * True when a rejected start() is the server's 409 at MAX_RUNNING_TIMERS rather
 * than a real failure. The cap is an expected refusal — callers toast it instead
 * of re-syncing as if something had gone wrong.
 */
export function isTimerCapError(err: unknown): boolean {
  return errorStatus(err) === 409
}

/** The server's own message for a 409, e.g. "Timer limit reached (10 running)." */
export function timerCapMessage(err: unknown): string {
  const e = err as { data?: { message?: string } } | null
  return e?.data?.message ?? `Timer limit reached (${MAX_RUNNING_TIMERS} running).`
}
