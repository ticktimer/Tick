<script setup lang="ts">
// Social card for every docs route, rendered at build time by satori.
//
// The `.satori.vue` suffix picks the renderer: satori is pure JS, so the cards
// are produced during `nuxt generate` with no headless browser. Its CSS support
// is a subset — flexbox only, no grid, no CSS variables, no `gap` shorthand
// inheritance — so the palette below is literal hex rather than Nuxt UI tokens,
// and every element that holds more than one child declares `display: flex`.
//
// 1200x600 (2:1) is deliberate: it is the ratio X/Twitter's summary_large_image
// expects, and a taller card gets centre-cropped there. The layout is what makes
// that ratio read as a banner rather than an empty strip — text is capped to a
// column on the left and the dial fills the right, so a one-word title like
// "About" does not leave half the card blank.
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
    class="w-full h-full flex flex-col"
    style="position: relative; background-color: #09090b; background-image: radial-gradient(circle at 15% 0%, #2e1065 0%, #09090b 55%); padding: 56px 60px; font-family: Inter"
  >
    <!--
      Decorative dial, bleeding off the right edge. Concentric rings and four
      cardinal ticks — the Tick mark abstracted to shapes satori renders exactly.
      The mark's own SVG is too dense for satori's partial SVG support, and a
      silent mis-render would ship in every unfurl.
    -->
    <div style="position: absolute; top: 66px; right: -74px; width: 468px; height: 468px; border: 2px solid #3f2d6b; border-radius: 9999px; display: flex" />
    <div style="position: absolute; top: 132px; right: -8px; width: 336px; height: 336px; border: 2px solid #34275a; border-radius: 9999px; display: flex" />
    <!--
      Both rings are concentric on (1040, 300) in card space: 1200 - right -
      width/2, top + height/2. The hands anchor to that same point and stop
      there rather than crossing it, or they read as a stray crosshair. The
      centre sits 160px in from the edge so the dial is not cropped to a sliver.
    -->
    <div style="position: absolute; top: 298px; right: 160px; width: 62px; height: 3px; background-color: #8b5cf6; border-radius: 9999px" />
    <div style="position: absolute; top: 228px; right: 158px; width: 3px; height: 72px; background-color: #6d4fb8; border-radius: 9999px" />
    <div style="position: absolute; top: 296px; right: 156px; width: 9px; height: 9px; background-color: #8b5cf6; border-radius: 9999px" />

    <div class="flex items-center" style="gap: 16px">
      <div
        class="flex items-center justify-center"
        style="width: 46px; height: 46px; border: 4px solid #8b5cf6; border-radius: 9999px"
      >
        <div style="width: 9px; height: 9px; background-color: #8b5cf6; border-radius: 9999px" />
      </div>
      <div class="flex items-center" style="gap: 9px">
        <span style="font-size: 33px; color: #fafafa">Tick</span>
        <span style="font-size: 33px; color: #a1a1aa">docs</span>
      </div>
    </div>

    <!--
      flexGrow fills the card; the width cap keeps text clear of the dial and
      stops a long title from running the full 1200px, which is what made the
      old card read as a strip.
    -->
    <div class="flex flex-col justify-center" style="flex-grow: 1; gap: 20px; padding: 24px 0; width: 700px">
      <!-- Weight 500 is Tick's type rule for headings (see main.css). -->
      <span style="font-size: 78px; font-weight: 500; color: #fafafa; line-height: 1.06; letter-spacing: -0.02em">{{ title }}</span>
      <span v-if="description" style="font-size: 30px; color: #a1a1aa; line-height: 1.35">{{ description }}</span>
    </div>

    <div class="flex items-center" style="gap: 14px">
      <div style="width: 34px; height: 4px; background-color: #8b5cf6; border-radius: 9999px" />
      <span style="font-size: 24px; color: #71717a">ticktimerapp.netlify.app</span>
    </div>
  </div>
</template>
