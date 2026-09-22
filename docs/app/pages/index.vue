<script setup lang="ts">
// Landing page — hero with the Tick mark, quick-start command blocks,
// and feature cards linking into the docs.
useSeoMeta({
  title: 'Self-hosted time tracking',
  description: 'Tick is a self-hosted, MIT-licensed time tracker for freelancers and small teams.'
})

defineOgImageComponent('Tick', {
  title: 'Self-hosted time tracking',
  description: 'A fast timer, a better entries list, safer deletion and a real theme editor.'
})

// The landing page is what search engines treat as the project's entry, so the
// software itself is described here rather than on any guide page. Free and
// self-hosted, hence offer price 0 — the alternative is omitting `offers`, which
// loses the "free" signal entirely.
useSchemaOrg([
  defineSoftwareApp({
    name: 'Tick',
    description: 'Self-hosted, MIT-licensed time tracking for freelancers and small teams.',
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Docker, Linux, macOS, Windows',
    license: 'https://opensource.org/licenses/MIT',
    offers: { '@type': 'Offer', price: 0, priceCurrency: 'USD' }
  })
])

const quickstart = `git clone https://github.com/ticktimer/Tick.git tick && cd tick
cp .env.example .env          # set NUXT_SESSION_PASSWORD: openssl rand -base64 36
docker compose up -d          # app + Postgres on :3000`

const features = [
  {
    title: 'One-keystroke timer',
    description: 'A sticky timer bar on every page. Type what you are doing, hit Enter, get back to work.',
    icon: 'i-lucide-timer',
    to: '/guide/timer-and-entries'
  },
  {
    title: 'Typed dates',
    description: 'Manual entries take free-text dates and durations — "last tue", "2pm", "1.5h" all parse.',
    icon: 'i-lucide-calendar-days',
    to: '/guide/timer-and-entries#manual-entries'
  },
  {
    title: 'Open-ended structure',
    description: 'Clients, projects and tasks are optional. Entries store one reference; the chain is derived.',
    icon: 'i-lucide-git-branch',
    to: '/guide/projects-clients-tasks'
  },
  {
    title: 'Rate inheritance',
    description: 'Set rates where they make sense — entry, project, client, member or user — first non-null wins.',
    icon: 'i-lucide-circle-dollar-sign',
    to: '/guide/projects-clients-tasks#rule-2-rate-inheritance'
  },
  {
    title: 'Safe deletion',
    description: 'Everything soft-deletes into a 30-day trash. Cascade dialogs spell out exactly what happens.',
    icon: 'i-lucide-trash-2',
    to: '/guide/projects-clients-tasks#rule-3-cascade-delete'
  },
  {
    title: 'Theme editor',
    description: 'Presets, 17 primaries, 9 neutrals, radius, fonts and a starfield — live, no save button.',
    icon: 'i-lucide-palette',
    to: '/guide/theme-editor'
  }
]
</script>

<template>
  <div>
    <UPageHero
      title="Time tracking that stays out of the way"
      description="Tick is a self-hosted, MIT-licensed time tracker for freelancers and small teams — a fast timer, a better entries list, safer deletion, typed dates and a real theme editor."
      orientation="vertical"
    >
      <template #top>
        <div class="flex justify-center pt-8">
          <TickLogo :size="96" glow />
        </div>
      </template>

      <template #links>
        <UButton to="/getting-started" size="lg" color="primary" variant="outline" trailing-icon="i-lucide-arrow-right">
          Get started
        </UButton>
        <UButton to="/installation" size="lg" color="neutral" variant="ghost">
          Installation
        </UButton>
      </template>

      <div class="mx-auto flex w-full max-w-2xl flex-col gap-3">
        <ProsePre language="bash" filename="Quick start" :code="quickstart">{{ quickstart }}</ProsePre>
        <p class="tnum text-center text-sm text-muted">
          Seeded demo login: <code>mara@example.com</code> / <code>tick-demo</code>
        </p>
      </div>
    </UPageHero>

    <UPageSection
      title="What's in the box"
      description="Everything runs from one Nuxt app and one Postgres database."
    >
      <UPageGrid>
        <UPageCard
          v-for="f in features"
          :key="f.title"
          v-bind="f"
          spotlight
        />
      </UPageGrid>
    </UPageSection>
  </div>
</template>
