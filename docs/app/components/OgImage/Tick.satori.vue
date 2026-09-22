<script setup lang="ts">
// Social card for every docs route, rendered at build time by satori.
//
// The `.satori.vue` suffix picks the renderer: satori is pure JS, so the cards
// are produced during `nuxt generate` with no headless browser. Its CSS support
// is a subset — flexbox only, no grid, no CSS variables, no `gap` shorthand
// inheritance — so the palette below is literal hex rather than Nuxt UI tokens,
// and every element that holds more than one child declares `display: flex`.
withDefaults(defineProps<{
  title?: string
  description?: string
}>(), {
  title: 'Tick docs',
  description: ''
})
</script>

<template>
  <div
    class="w-full h-full flex flex-col justify-between"
    style="background-color: #09090b; background-image: radial-gradient(circle at 15% 0%, #2e1065 0%, #09090b 55%); padding: 72px; font-family: Inter"
  >
    <div class="flex items-center" style="gap: 18px">
      <!--
        The Tick mark is a fairly dense SVG; satori's SVG support is partial and
        a silent mis-render would ship in every unfurl. A plain ring reads as the
        dial at card scale and cannot fail.
      -->
      <div
        class="flex items-center justify-center"
        style="width: 54px; height: 54px; border: 4px solid #8b5cf6; border-radius: 9999px"
      >
        <div style="width: 10px; height: 10px; background-color: #8b5cf6; border-radius: 9999px" />
      </div>
      <div class="flex items-center" style="gap: 10px">
        <span style="font-size: 38px; color: #fafafa">Tick</span>
        <span style="font-size: 38px; color: #a1a1aa">docs</span>
      </div>
    </div>

    <div class="flex flex-col" style="gap: 24px">
      <!--
        Weight 500 is Tick's type rule for headings (see main.css). Long content
        titles wrap; the card is 1200x600 so three lines still clear the footer.
      -->
      <span style="font-size: 68px; font-weight: 500; color: #fafafa; line-height: 1.15">{{ title }}</span>
      <span v-if="description" style="font-size: 30px; color: #a1a1aa; line-height: 1.4">{{ description }}</span>
    </div>

    <div class="flex items-center" style="gap: 16px">
      <div style="width: 40px; height: 4px; background-color: #8b5cf6; border-radius: 9999px" />
      <span style="font-size: 26px; color: #71717a">ticktimerapp.netlify.app</span>
    </div>
  </div>
</template>
