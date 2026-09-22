<script setup lang="ts">
// Docs page renderer — left navigation, page body, right table of contents.
import type { ContentNavigationItem } from '@nuxt/content'

const route = useRoute()

// Netlify's Pretty URLs redirect /about -> /about/, but content paths are
// stored without a trailing slash; a raw route.path lookup finds nothing at
// "/about/" and the page renders blank post-hydration with no console error.
const path = computed(() => route.path.replace(/\/+$/, '') || '/')

const navigation = inject<Ref<ContentNavigationItem[]>>('navigation')

const { data: page } = await useAsyncData(path.value, () => {
  return queryCollection('docs').path(path.value).first()
})
if (!page.value) {
  throw createError({ statusCode: 404, statusMessage: 'Page not found', fatal: true })
}

const { data: surround } = await useAsyncData(`${path.value}-surround`, () => {
  return queryCollectionItemSurroundings('docs', path.value, {
    fields: ['description']
  })
})

useSeoMeta({
  title: page.value.title,
  description: page.value.description
})

// Social card. Rendered at build time into dist by satori; `title`/`description`
// are passed explicitly rather than inferred so the card text always matches the
// frontmatter that produced the <title> above.
defineOgImageComponent('Tick', {
  title: page.value.title,
  description: page.value.description
})

// Breadcrumb JSON-LD. The WebSite/WebPage nodes come from nuxt-schema-org's
// defaults; the trail is the part that needs the navigation tree. Content sits
// one or two levels deep (/about, /guide/import), so it reads Docs > section >
// page, with each ancestor's label taken from the nav tree when it has one.
function navTitle(items: ContentNavigationItem[], target: string): string | undefined {
  for (const item of items) {
    if (item.path === target) return item.title
    const nested = item.children ? navTitle(item.children, target) : undefined
    if (nested) return nested
  }
}

// Built once at setup rather than as a computed: with SSR on and dev off,
// nuxt-schema-org renders the graph a single time, and a client-side route
// change mounts a fresh instance of this page anyway. This also matches how
// `path.value` is already read eagerly above.
const breadcrumbs = path.value.split('/').filter(Boolean).reduce((trail, segment, index, segments) => {
  const item = `/${segments.slice(0, index + 1).join('/')}`
  const last = index === segments.length - 1
  // Section directories (/guide) have no page of their own, so the nav tree
  // may not name them; fall back to the de-slugified segment.
  const fallback = segment.replace(/-/g, ' ').replace(/^\w/, c => c.toUpperCase())
  trail.push({
    name: (last ? page.value?.title : navTitle(navigation?.value ?? [], item)) ?? fallback,
    item
  })
  return trail
}, [{ name: 'Docs', item: '/' }])

useSchemaOrg([defineBreadcrumb({ itemListElement: breadcrumbs })])
</script>

<template>
  <UContainer>
    <UPage v-if="page">
      <template #left>
        <UPageAside>
          <UContentNavigation :navigation="navigation" highlight />
        </UPageAside>
      </template>

      <UPageHeader :title="page.title" :description="page.description" />

      <UPageBody>
        <ContentRenderer v-if="page.body" :value="page" />
        <USeparator v-if="surround?.length" />
        <UContentSurround :surround="surround" />
      </UPageBody>

      <template v-if="page?.body?.toc?.links?.length" #right>
        <UContentToc :links="page.body.toc.links" title="On this page" />
      </template>
    </UPage>
  </UContainer>
</template>
