# Operations Runbook

This runbook covers local setup, Convex deployment, VPS/Docker deployment,
cron replacement, QA, monitoring, rollback, and current operational blockers for
the Instagram event aggregator.

Checked against this repo on 2026-06-05.

## Service Shape

Run the Next.js web app as one Docker container. Keep Convex, Clerk, OpenAI, and
Apify managed services.

```text
internet
  -> reverse proxy with TLS on the VPS
  -> Docker web container on 127.0.0.1:3000
  -> hosted Convex, Clerk, OpenAI, and Apify over HTTPS
```

The app exposes:

- Public event pages: `/events` and `/calendar`
- Admin pages: `/admin`, `/admin/scraper`, and `/admin/venues`
- Health endpoint: `/api/health`
- Scheduled ingestion endpoint: `GET /api/cron/ingest-venues`

## Local Setup

Use Node 20.

```bash
npm install
cp .env.example .env.local
npm run dev
```

If Convex is not connected locally yet:

```bash
npx convex dev
npm run convex:codegen
```

Local checks:

```bash
npm run lint
npm run typecheck
npm run qa:dedupe
npm run qa:automerge
npm run qa:extraction
npm run qa:release
```

`npm run qa:release` runs lint, typecheck, dedupe QA, approved-event automerge
QA, and extraction QA with timeouts. It intentionally does not run
`npm run build` while the local Next build hang remains unresolved.

## Environment Variables

Start from `.env.example` locally and `.env.production.example` in production.
Never commit filled env files and never bake secrets into the image.

Required or expected runtime variables:

```env
NODE_ENV=production
PORT=3000
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
NEXT_PUBLIC_CONVEX_URL=
CONVEX_DEPLOYMENT=
ADMIN_CLERK_USER_IDS=
OPENAI_API_KEY=
APIFY_API_TOKEN=
APIFY_INSTAGRAM_ACTOR_ID=apify/instagram-post-scraper
OPENAI_VISION_MODEL=gpt-4.1-mini
OPENAI_REVIEW_MODEL=gpt-4.1-mini
CRON_SECRET=
EVENTS_TIMEZONE=Europe/Belgrade
APP_BIND=127.0.0.1
APP_PORT=3000
```

Notes:

- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `NEXT_PUBLIC_CONVEX_URL` are public
  build-time values. Build the Docker image with the same public values used in
  production.
- `CLERK_SECRET_KEY`, `OPENAI_API_KEY`, `APIFY_API_TOKEN`, and `CRON_SECRET`
  are secrets and must stay out of git.
- `ADMIN_CLERK_USER_IDS` is the Clerk user allowlist for admin access.
- `CRON_SECRET` must be set in production. When it is blank, the cron endpoint
  allows unauthenticated calls for local convenience.
- `EVENTS_TIMEZONE` controls local event-day handling.
- `OPENAI_VISION_MODEL` and `OPENAI_REVIEW_MODEL` should be set explicitly for
  cost control.
- `CONVEX_DEPLOY_KEY` is a deploy-time secret only. Do not put it in the VPS
  runtime env unless that host is also responsible for deploying Convex.

## Convex Deploy and Codegen

Local development:

```bash
npx convex dev
npm run convex:codegen
```

Before production deploys, generate types and deploy Convex functions from a
clean checkout:

```bash
npm run convex:codegen
CONVEX_DEPLOY_KEY=<deploy-key> npx convex deploy -y --typecheck disable --codegen enable
```

If the deploy needs production env values, pass the production env file:

```bash
CONVEX_DEPLOY_KEY=<deploy-key> npx convex deploy -y --typecheck disable --codegen enable --env-file .env.production
```

After Convex deployment, confirm production `.env.production` has the matching
`NEXT_PUBLIC_CONVEX_URL` and `CONVEX_DEPLOYMENT`.

Convex also has an internal hourly cron in `convex/crons.ts` for deleting
expired events. That is separate from the web app ingestion cron below.

## Docker and VPS Deployment

The repo includes `Dockerfile`, `.dockerignore`, and `docker-compose.yml`. The
image runs `npm run build` during the Docker build and starts with
`npm run start`.

Recommended host layout:

```text
/opt/ig_event/app              git checkout
/opt/ig_event/.env.production  production env file, chmod 600
```

Initial VPS setup:

```bash
sudo apt update
sudo apt install -y ca-certificates curl git ufw
docker version
docker compose version
```

Firewall:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Deploy or update:

```bash
cd /opt/ig_event/app
git fetch origin
git checkout main
git pull --ff-only
docker compose --env-file /opt/ig_event/.env.production up -d --build
```

The Compose default binds the container to `127.0.0.1:3000`. Put Caddy or nginx
in front for public HTTPS.

Caddy example:

```caddyfile
events.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

After DNS points to the VPS and ports 80/443 are open, reload the proxy and
verify HTTPS externally.

## Cron Replacement

`vercel.json` configures Vercel Cron for `/api/cron/ingest-venues`. Once the
app runs on a VPS, replace that with host cron or a systemd timer.

Create `/etc/ig_event/cron.env`:

```env
APP_ORIGIN=https://events.example.com
CRON_SECRET=
```

Install host cron:

```cron
TZ=Europe/Belgrade
0 8 * * * . /etc/ig_event/cron.env; curl -fsS -H "Authorization: Bearer ${CRON_SECRET}" "${APP_ORIGIN}/api/cron/ingest-venues" >/dev/null
```

Use the same `CRON_SECRET` value in `/etc/ig_event/cron.env` and the web app
runtime env. If the cron endpoint returns `401`, check the header and secret
first.

Promote cron to a systemd timer if you need clearer failure logs, retries, or
alerting. The command remains the same curl call.

## QA Commands

Run deterministic gates before deploying:

```bash
npm run qa:release
```

Run focused checks when touching related areas:

```bash
npm run lint
npm run typecheck
npm run qa:dedupe
npm run qa:automerge
npm run qa:extraction
npm run convex:codegen
```

Production deploy verification:

```bash
docker compose --env-file /opt/ig_event/.env.production ps
docker compose --env-file /opt/ig_event/.env.production logs --tail 100 web
curl -fsS http://127.0.0.1:3000/api/health
curl -fsS -I http://127.0.0.1:3000/events
curl -fsS -I https://events.example.com/events
```

Behavioral smoke test:

- `/events` loads and shows approved upcoming events.
- `/calendar` loads.
- Clerk sign-in works on the production domain.
- Admin pages are visible only to `ADMIN_CLERK_USER_IDS`.
- Manual admin scrape reaches Apify and writes to Convex.
- `GET /api/cron/ingest-venues` succeeds with
  `Authorization: Bearer <CRON_SECRET>`.

## Monitoring

Minimum monitoring:

- External uptime check for `https://events.example.com/events`.
- Internal health check for `http://127.0.0.1:3000/api/health`.
- Docker health status from `docker compose ps`.
- Web logs from `docker compose logs --tail 200 web`.
- Cron logs from syslog or systemd timer logs.
- Convex dashboard for function errors, ingestion job writes, and data shape.
- Apify dashboard for actor failures, rate limits, and run cost.
- OpenAI dashboard for model usage and spend.
- Clerk dashboard for auth errors and production domain configuration.

Operational checks:

```bash
docker compose --env-file /opt/ig_event/.env.production ps
docker compose --env-file /opt/ig_event/.env.production logs --tail 200 web
curl -fsS http://127.0.0.1:3000/api/health
```

Alert on:

- Health endpoint failures.
- Repeated container restarts.
- Cron ingestion failures or missing daily runs.
- Apify quota or actor failures.
- OpenAI quota, auth, or rate-limit failures.
- Convex function errors.

## Rollback

Keep rollback boring:

```bash
cd /opt/ig_event/app
git fetch origin
git checkout <known-good-sha>
docker compose --env-file /opt/ig_event/.env.production up -d --build
docker compose --env-file /opt/ig_event/.env.production logs --tail 100 web
curl -fsS http://127.0.0.1:3000/api/health
```

If Convex schema/functions were deployed and need rollback, deploy the matching
Convex code from the known-good commit with the same production deploy key.
Avoid manual production data edits unless a specific recovery plan exists.

## Rollback

Web app rollback:

```bash
cd /opt/ig_event/app
git fetch origin
git checkout <known-good-commit>
docker compose --env-file /opt/ig_event/.env.production up -d --build
curl -fsS http://127.0.0.1:3000/api/health
```

If only env changed, restore the previous `/opt/ig_event/.env.production`, then
restart:

```bash
docker compose --env-file /opt/ig_event/.env.production up -d
```

If a Convex deploy caused the issue, redeploy the last known good code with the
same Convex deployment target:

```bash
git checkout <known-good-commit>
CONVEX_DEPLOY_KEY=<deploy-key> npx convex deploy -y --typecheck disable --codegen enable --env-file .env.production
```

After rollback, verify public pages, admin auth, health, and one read from
Convex. Avoid re-running full ingestion until the rollback is confirmed.

## Known Blockers and Risks

- Local `npm run build` can hang before Next emits useful output. Use
  `npm run qa:release` for deterministic local gates and verify the Next build
  in CI or inside the Docker build until this is fixed.
- `npm run qa:release` does not include `next build`; add it only after the
  local build hang is resolved.
- The Docker build still runs `npm run build`, so a production image build can
  fail even when deterministic QA passes.
- Vercel Cron does not run after moving the app to a VPS. Host cron or a systemd
  timer must be installed before relying on scheduled ingestion.
- Build-time public env values must match production runtime values. Rebuild the
  image when `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` or `NEXT_PUBLIC_CONVEX_URL`
  changes.
- Production admin routes fail closed if Clerk env vars are missing. This is
  expected and safer than exposing admin APIs.
- Do not self-host Convex, Clerk, OpenAI, or Apify in the first VPS phase unless
  there is a separate migration plan for backups, auth, scraping, and model
  operations.
