<script setup lang="ts">
// App shell: 224px sticky sidebar + main column (sticky timer bar, page content).
// <1024px the sidebar + timer bar hide and a fixed dock takes over: docked
// timer card above a bottom tab bar (More sheet holds the manage pages).
// The picker modal mounts here (after the slot) so the docked timer's +
// works on every screen; teleport order keeps it above ManualEntryDialog.
// On mount: hydrate the running timer from the server and load the catalog
// (timer-bar counts + picker data). Pages own their content padding/max-width.
const timer = useTimerStore()
const catalog = useCatalogStore()
const ui = useUiStore()

// Refocusing the tab (visibilitychange → visible, window focus) re-hydrates
// the timer so a timer started elsewhere (another tab/device) appears without
// a reload; hydrateIfStale debounces to at most once per 5s.
function onRefocus() {
  if (document.visibilityState !== 'visible') return
  timer.hydrateIfStale().catch(() => {})
}

onMounted(() => {
  timer.hydrate()
  timer.hydrateDraft()
  // Both read localStorage, and both do it *after* mount so the SSR'd shell and
  // the first client render agree. hydratePinned() runs synchronously here,
  // i.e. before hydrate()'s fetch resolves, so a saved pin is always in place
  // before the list it points into arrives.
  timer.hydratePinned()
  catalog.fetchAll().catch(() => {})
  ui.hydratePrefs()
  window.addEventListener('focus', onRefocus)
  document.addEventListener('visibilitychange', onRefocus)
})

onBeforeUnmount(() => {
  window.removeEventListener('focus', onRefocus)
  document.removeEventListener('visibilitychange', onRefocus)
})
</script>

<template>
  <div class="flex min-h-screen bg-default text-default">
    <!-- Skip link: first tab stop, visible only while focused -->
    <a
      href="#main"
      class="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:top-2 focus-visible:left-2 focus-visible:z-50 focus-visible:rounded-md focus-visible:bg-elevated focus-visible:px-3 focus-visible:py-2 focus-visible:text-sm focus-visible:text-highlighted focus-visible:shadow-md"
    >Skip to main content</a>
    <ShellAppSidebar class="max-lg:hidden" />
    <main
      id="main"
      tabindex="-1"
      class="flex min-w-0 flex-1 flex-col outline-none max-lg:pb-[calc(150px+env(safe-area-inset-bottom))]"
    >
      <ShellDemoBanner />
      <ShellTimerBar class="max-lg:hidden" />
      <slot />
    </main>

    <!-- Mobile dock: timer card above the tab bar, on every screen -->
    <div
      class="fixed inset-x-0 bottom-0 z-20 flex flex-col gap-2 pt-4 lg:hidden"
      :style="{
        background: 'linear-gradient(180deg, transparent, var(--ui-bg) 28%)',
        paddingBottom: 'env(safe-area-inset-bottom)'
      }"
    >
      <ShellMobileTimerCard />
      <ShellMobileTabBar />
    </div>

    <!-- Shared picker (timer bar, docked timer, manual entry, bulk move) -->
    <TimePickerModal />
  </div>
</template>
