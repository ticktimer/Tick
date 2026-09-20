# Tick

Tick is a self-hosted, MIT-licensed time tracker for freelancers and small teams. It pairs a persistent one-click timer with a fast entries list, an open-ended client → project → task model, safe deletion everywhere (soft delete, cascade previews, 30-day trash, undo), server-resolved billable rates, and a built-in theme editor — all in a single small app you run with Docker or plain Node.

**Features**

- Sticky timer bar: start typing, attach a client/project/task later, run several timers at once (up to 10)
- Time page: entries grouped by day or project, `#tag` / `@name` / free-text filtering, bulk actions
- Manual entries with forgiving natural-language date, time and duration parsing ("yesterday", "9a–11.20", "1h30")
- Dashboard with hours, billable amounts and per-project breakdowns
- Clients, projects, tasks and tags with inline create from the picker
- Deletion that never surprises: downward-cascade checkboxes with an outcome preview, everything soft-deleted with 30-day trash and instant undo
- Rates resolve server-side (entry override → task → project → client → org default), money and time always in tabular numerals
- Theme editor: presets, primary/neutral palette, radius, font, light/dark, starfield background
- Session auth (register/login) with scrypt password hashing; multi-user orgs

**Screenshots**: [Time](screenshots/01-time.png) · [Dashboard](screenshots/02-dashboard.png) · [Calendar](screenshots/03-calendar.png) · [Reports](screenshots/04-reports.png) · [Projects & tasks](screenshots/05-projects-tasks.png) · [Clients](screenshots/06-clients.png) · [Tags](screenshots/07-tags.png) · [Theme editor](screenshots/08-settings-appearance.png) · [Manual entry](screenshots/09-manual-entry-dialog.png) · [Cascade delete](screenshots/10-cascade-delete-dialog.png) · [Mobile](screenshots/11-mobile.png)

## Quickstart (Docker Compose)

Runs the app plus a bundled Postgres 17 with a persistent volume. Migrations apply automatically on startup.

```sh
git clone https://github.com/ticktimer/Tick.git tick && cd tick
cp .env.example .env
# edit .env: set NUXT_SESSION_PASSWORD (openssl rand -base64 36)
docker compose up -d
```

Open http://localhost:3000 and register your first account.

### Docker run (bring your own Postgres)

```sh
docker run -d --name tick -p 3000:3000 \
  -e NUXT_DATABASE_URL='postgresql://tick:password@db-host:5432/tick' \
  -e NUXT_SESSION_PASSWORD="$(openssl rand -base64 36)" \
  ghcr.io/ticktimer/tick:latest
```

Multi-arch images (`linux/amd64`, `linux/arm64`) are published to GHCR by CI on pushes to `main` (`latest`, `sha-…`) and on `v*` tags (semver). The package is public, so `docker pull ghcr.io/ticktimer/tick:latest` works without `docker login`.

## Native (Node + PM2)

Requires Node 22+ and a reachable Postgres.

```sh
npm ci
npm run build
export NUXT_DATABASE_URL='postgresql://tick:password@localhost:5432/tick'
export NUXT_SESSION_PASSWORD="$(openssl rand -base64 36)"   # keep it stable across restarts
node .output/server/index.mjs        # or:
pm2 start ecosystem.config.cjs       # see the file for env docs
```

The built server applies pending SQL migrations on startup (set `NUXT_AUTO_MIGRATE=false` to opt out). PM2 inherits your shell environment; for a persistent setup put the `NUXT_*` vars in your service manager's env file.

## Reverse proxy

For real deployments put nginx or Caddy in front of the app for TLS, compression and security headers. Ready-made configs live in [`deploy/`](deploy/) — [`nginx.conf.example`](deploy/nginx.conf.example) (public-TLS and internal plain-HTTP variants) and [`Caddyfile.example`](deploy/Caddyfile.example) (auto-TLS). Both pass the `X-Forwarded-*` headers Tick needs, allow 8 MB CSV imports, and keep the PWA service worker uncached so installed clients update promptly. See [`deploy/README.md`](deploy/README.md). Reaching Tick over plain HTTP instead — no TLS at all — needs `NUXT_SESSION_COOKIE_SECURE=false`; without it, login returns success but the sign-in page reports that the browser refused the cookie. See "Plain HTTP and the Secure flag" in [`docs/content/4.reference/4.security.md`](docs/content/4.reference/4.security.md).

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `NUXT_DATABASE_URL` | yes | — | Postgres connection string, e.g. `postgresql://tick:password@localhost:5432/tick` |
| `NUXT_SESSION_PASSWORD` | yes | — | Session cookie encryption secret, 32+ chars. Generate: `openssl rand -base64 36`. Changing it logs everyone out |
| `NUXT_AUTO_MIGRATE` | no | `true` | Apply pending SQL migrations on production startup; `false` to run them out-of-band (`npx drizzle-kit migrate`) |
| `NUXT_MIGRATIONS_DIR` | no | `<cwd>/server/db/migrations` | Override the migrations folder location |
| `NUXT_PUBLIC_REGISTRATION` | no | `open` | Who may sign up themselves: `open` (anyone), `invite` (a valid invite link is required), `closed` (nobody). See "Registration modes" in [`docs/content/2.installation.md`](docs/content/2.installation.md) |
| `NUXT_AUTH_RATE_LIMIT` | no | `10` | Max POSTs per IP per minute to each auth endpoint (login/register/forgot/reset); `0` disables it |
| `NUXT_SESSION_COOKIE_SECURE` | no | `true` | Secure flag on the session cookie. `false`/`0` only for plain-HTTP access on a trusted network; otherwise login "succeeds" but the browser drops the cookie. An empty or unrecognized value stops startup |
| `NUXT_SMTP_HOST` | no | — | SMTP server for outgoing mail. **Mail is off until this and `NUXT_MAIL_FROM` are both set** |
| `NUXT_SMTP_PORT` | no | `465` when secure, else `587` | SMTP port |
| `NUXT_SMTP_USER` | no | — | SMTP username; when unset the connection is unauthenticated |
| `NUXT_SMTP_PASS` | no | — | SMTP password / app password |
| `NUXT_SMTP_SECURE` | no | `false` | `true` = implicit TLS (usually port 465). Leave unset for STARTTLS on 587 |
| `NUXT_MAIL_FROM` | no | — | From address, e.g. `Tick <tick@example.com>`. Required together with `NUXT_SMTP_HOST` for any mail to go out |
| `NUXT_DEMO_MODE` | no | `false` | Public-demo hardening: reseeds the demo org every 24h and returns `403` for destructive operations (password change, org rename, member removal, invite create/revoke, import commit, permanent trash deletion) |
| `NUXT_PUBLIC_DEMO_MODE` | no | `false` | Shows the "Demo — data resets nightly" banner in the app shell |
| `NITRO_HOST` | no | `0.0.0.0` (image) | Bind address of the production server |
| `NITRO_PORT` | no | `3000` | Port of the production server |
| `POSTGRES_PASSWORD` | no | `tick` | docker-compose only: password for the bundled Postgres |
| `TICK_PORT` | no | `3000` | docker-compose only: host port the app is published on |
| `TICK_IP` | no | `0.0.0.0` | docker-compose only: host IP the published port binds to — `127.0.0.1` behind a same-host reverse proxy (Docker bypasses ufw/firewalld) |

## Development

```sh
npm i
cp .env.example .env      # point NUXT_DATABASE_URL at a local Postgres
npm run db:push           # create the schema (dev uses push, not migrations)
npm run db:seed           # demo org + ~3 weeks of entries
npm run dev
```

Seed credentials: **mara@example.com** / **tick-demo** (org "Hollow Studio").

Other scripts: `npm run typecheck`, `npm run db:generate` (new SQL migration from schema changes — commit the `server/db/migrations` output so deployed instances pick it up).

Debugging in VS Code: `.vscode/launch.json` ships configs for the dev server, a full-stack (server + browser) session, the production `.output` server, the seeder and the docs site.

Stack: Nuxt 4 · Nuxt UI 4 · Tailwind 4 · Pinia · Drizzle ORM + postgres.js · nuxt-auth-utils · GSAP · Zod.

## License

MIT — see [LICENSE](LICENSE).
