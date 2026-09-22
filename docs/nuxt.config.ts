// Tick documentation site — separate Nuxt app (docs/), Nuxt UI + Nuxt Content.
// Visually kin to the main app: dark default, violet primary, Inter.
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: false },
  modules: ['@nuxt/ui', '@nuxt/content', '@nuxtjs/seo'],
  css: ['~/assets/css/main.css'],

  // Canonical origin for canonical links, og:url, robots.txt and sitemap.xml.
  // Hardcoded rather than left to nuxt-site-config's Netlify env detection:
  // that reads $URL/$DEPLOY_PRIME_URL, so a deploy preview would advertise its
  // own ephemeral host as canonical. Previews are noindex'd by Netlify anyway,
  // and pointing their canonical at production is the behaviour we want.
  site: {
    url: 'https://ticktimerapp.netlify.app',
    name: 'Tick docs',
    description: 'Tick is a self-hosted, MIT-licensed time tracker for freelancers and small teams.'
  },

  colorMode: {
    preference: 'dark',
    fallback: 'dark',
    // localStorage, not cookie: this is a static host with no SSR to read a
    // cookie server-side. localStorage persists (the module default); the
    // cookie option here also hit Nuxt's cookieAttrs `maxAge` bug (module
    // passes `max-age`, useCookie expects `maxAge`), making it a session
    // cookie that's lost as soon as the browser closes.
    storage: 'localStorage'
  },
  icon: {
    // Bundles frontmatter icons (nav/page icons from content) into the client
    // build. Without this, the search dialog fetches them from
    // api.iconify.design at runtime — an avoidable external request.
    clientBundle: { scan: true }
  },

  ogImage: {
    // Every route is prerendered, so each card is rendered at build time and
    // written to dist. zeroRuntime drops the satori/resvg runtime from the
    // bundle — a static host has nothing to render on demand anyway.
    zeroRuntime: true
  },

  // Dev-only crawler. It walks prose links and warns on 404s/redirects; noisy
  // enough during content edits that it stays off until deliberately run.
  linkChecker: { enabled: false },

  nitro: {
    prerender: {
      // Without this, Nitro writes about/index.html; Netlify's Pretty URLs
      // then 301 /about -> /about/, and the page renders blank post-hydration
      // because [...slug].vue looks up the route with the trailing slash and
      // finds nothing. With this false, it writes about.html instead: /about
      // is 200, and /about/ / /about.html redirect to /about.
      autoSubfolderIndex: false
    }
  },
  fonts: {
    families: [{ name: 'Inter', provider: 'google' }]
  },
  app: {
    head: {
      title: 'Tick docs',
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }]
    }
  }
})
