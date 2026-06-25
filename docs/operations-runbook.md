# Operations Runbook

This runbook covers local setup, Convex deployment, optional self-hosted Convex,
VPS/Docker deployment, cron replacement, QA, monitoring, rollback, and current
operational blockers for the Instagram event aggregator.

Checked against this repo on 2026-06-05.

## Service Shape

Two Convex modes are supported:

1. **Hosted Convex Cloud** - run only the Next.js web container on the VPS.
2. **Self-hosted Convex** - run the web app plus `convex-backend` and
   `convex-dashboard` services in the same Docker Compose project using
   `docker-compose.self-hosted-convex.yml`.

Clerk, OpenAI, and Apify remain managed services in both modes.

Hosted Convex shape:

```text
internet
  -> reverse proxy with TLS on the VPS
  -> Docker web container on 127.0.0.1:3000
  -> hosted Convex, Clerk, OpenAI, and Apify over HTTPS
```

Self-hosted Convex shape:

```text
internet
  -> reverse proxy with TLS on the VPS
  -> events host -> Docker web container :3000
  -> Convex host -> convex-backend container :3210
operator only
  -> SSH tunnel 127.0.0.1:6791 -> convex-dashboard container :6791
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

For self-hosted Convex development against the Compose backend, see
`docs/self-hosted-convex.md`; the browser-facing `NEXT_PUBLIC_CONVEX_URL` must be
reachable from the browser, not just from Docker.

Local checks:

```bash
npm run lint
npm run typecheck
npm run build
npm run qa:dedupe
npm run qa:automerge
npm run qa:extraction
npm run qa:release
```

`npm run qa:release` runs lint, typecheck, dedupe QA, approved-event automerge
QA, extraction QA, venue taxonomy QA, public search QA, Apify cost-control QA,
and `npm run build` with timeouts.

## Environment Variables

Start from `.env.example` locally and `.env.production.example` in production.
Never commit filled env files and never bake secrets into the image.

Required or expected runtime variables:

```env
NODE_ENV=production
PORT=3000
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/admin
NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/admin
NEXT_PUBLIC_CONVEX_URL=
CONVEX_DEPLOYMENT=
CONVEX_SELF_HOSTED_URL=
CONVEX_SELF_HOSTED_ADMIN_KEY=
CONVEX_CLOUD_ORIGIN=
CONVEX_TRAEFIK_HOST=convex-events.ineedtofeedmyrabbit.com
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
  production. For self-hosted Convex, `NEXT_PUBLIC_CONVEX_URL` must be the public
  backend URL reachable from users' browsers, usually the Traefik HTTPS host for
  `convex-backend`.
- `NEXT_PUBLIC_CLERK_SIGN_IN_URL`, `NEXT_PUBLIC_CLERK_SIGN_UP_URL`, and the
  fallback redirect URLs keep Clerk redirects on the app's custom auth pages and
  return successful admin sign-ins to `/admin`.
- The custom auth pages make Instagram the primary action and mount
  `/sso-callback` with `AuthenticateWithRedirectCallback` for OAuth completion.
  The button only starts a strategy Clerk exposes in
  `authenticatableSocialStrategies`: native `oauth_instagram`, or a custom
  provider such as `oauth_custom_instagram`. Set
  `NEXT_PUBLIC_CLERK_INSTAGRAM_OAUTH_STRATEGY` when the custom provider slug is
  not exactly `instagram`.
- `CLERK_SECRET_KEY`, `OPENAI_API_KEY`, `APIFY_API_TOKEN`, and `CRON_SECRET`
  are secrets and must stay out of git.
- `ADMIN_CLERK_USER_IDS` is the Clerk user allowlist for admin pages and
  `/api/admin/*`.
- `CRON_SECRET` must be set in production. When it is blank, the cron endpoint
  fails closed in production and allows unauthenticated calls only for local
  convenience.
- `EVENTS_TIMEZONE` controls local event-day handling.
- `OPENAI_VISION_MODEL` and `OPENAI_REVIEW_MODEL` must be set in production;
  the default cost-control value is `gpt-4.1-mini`.
- `CLERK_JWT_ISSUER_DOMAIN` must match the Clerk JWT issuer configured for the
  Convex `convex` JWT template.
- `CONVEX_DEPLOY_KEY` is a deploy-time secret only. Do not put it in the VPS
  runtime env unless that host is also responsible for deploying Convex.
- `CONVEX_SELF_HOSTED_ADMIN_KEY` is the equivalent deploy/import secret for the
  self-hosted backend. Keep it in a private env file only.

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

Self-hosted Convex deploy:

```bash
# Start backend/dashboard with the web app in one Compose project.
docker compose --env-file .env.production \
  -f docker-compose.yml \
  -f docker-compose.self-hosted-convex.yml \
  up -d --build

# Generate an admin key once, then add it to .env.production privately.
docker compose --env-file .env.production \
  -f docker-compose.yml \
  -f docker-compose.self-hosted-convex.yml \
  exec convex-backend ./generate_admin_key.sh

# Deploy functions to the self-hosted backend.
npm run convex:codegen
npx convex deploy -y --typecheck disable --codegen enable --env-file .env.production
```

For cloud-to-self-hosted migration, export cloud production before switching the
app URL, then import into the self-hosted backend:

```bash
mkdir -p backups
npx convex export --prod --path backups/convex-cloud-prod-$(date +%Y%m%d-%H%M%S).zip
npx convex import --replace-all --yes --env-file .env.production backups/convex-cloud-prod-YYYYmmdd-HHMMSS.zip
```

See `docs/self-hosted-convex.md` for DNS, dashboard, backup, upgrade, and
rollback details.

Convex also has an internal weekly cron in `convex/crons.ts` for deleting
expired events older than the 3-day retention grace period. It runs Wednesday at
05:00 UTC and calls a maintenance action that deletes bounded batches until the
backlog is clear (up to the configured safety cap). That is separate from the
web app ingestion cron below.

## Docker and VPS Deployment

The repo includes `Dockerfile`, `.dockerignore`, `docker-compose.yml`,
`docker-compose.runtime.yml`, and optional `docker-compose.self-hosted-convex.yml`.
The image runs `npm run lint`, `npm run typecheck`, and `npm run build` during
the Docker build, then starts with `npm run start`.

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

Deploy or update hosted-Convex web app only:

```bash
cd /opt/ig_event/app
git fetch origin
git checkout main
git pull --ff-only
docker compose --env-file /opt/ig_event/.env.production up -d --build
```

Deploy or update web app plus self-hosted Convex:

```bash
cd /opt/ig_event/app
git fetch origin
git checkout main
git pull --ff-only
docker compose --env-file /opt/ig_event/.env.production \
  -f docker-compose.yml \
  -f docker-compose.self-hosted-convex.yml \
  up -d --build
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

`vercel.json` documents the intended schedule, but the self-hosted VPS uses real
host cron under `/etc/cron.d/ig_event`.

Installed files on the VPS:

```text
/etc/cron.d/ig_event                 root-readable cron schedule
/etc/ig_event/cron.env               APP_ORIGIN + CRON_SECRET, chmod 600
/usr/local/sbin/ig-event-cron-runner root-owned curl runner with flock locking
/var/log/ig_event/cron.log           appended cron output
/var/log/ig_event/cron-*-last.json   last response body per job
```

Current host cron schedule uses UTC to match `vercel.json` and Convex:

```cron
CRON_TZ=UTC
0 7 * * * root /usr/local/sbin/ig-event-cron-runner ingest-venues >> /var/log/ig_event/cron.log 2>&1
0 10 * * 1 root /usr/local/sbin/ig-event-cron-runner discover-following >> /var/log/ig_event/cron.log 2>&1
```

Use the same `CRON_SECRET` value in `/etc/ig_event/cron.env` and the web app
runtime env. If a job returns `401`, check the header and secret first. The
runner keeps the bearer token out of process arguments by writing a temporary
root-only curl config file, and it uses `/run/lock/ig-event-<job>.lock` to avoid
overlapping runs.

The Convex retention cleanup is separate: it is a native Convex cron that runs
Wednesday 05:00 UTC and is not called by VPS cron.

## QA Commands

Run deterministic gates before deploying:

```bash
npm run qa:release
```

Run focused checks when touching related areas:

```bash
npm run lint
npm run typecheck
npm run build
npm run qa:dedupe
npm run qa:automerge
npm run qa:extraction
npm run qa:convex-retention-cron
npm run qa:clerk-instagram-sso
npm run qa:self-hosted-convex-compose
npm run convex:codegen
```

Production deploy verification:

```bash
docker compose --env-file /opt/ig_event/.env.production ps
docker compose --env-file /opt/ig_event/.env.production logs --tail 100 web
curl -fsS http://127.0.0.1:3000/api/health
curl -fsS -I http://127.0.0.1:3000/events
curl -fsS -I https://events.example.com/events

# If using self-hosted Convex overlay:
docker compose --env-file /opt/ig_event/.env.production \
  -f docker-compose.yml \
  -f docker-compose.self-hosted-convex.yml \
  ps
curl -fsS http://127.0.0.1:3210/version
curl -fsS -I https://convex-events.ineedtofeedmyrabbit.com/version
```

Behavioral smoke test:

- `/events` loads and shows approved upcoming events.
- `/calendar` loads.
- Clerk sign-in works on the production domain.
- Admin pages are visible only to `ADMIN_CLERK_USER_IDS`.
- Manual admin scrape reaches Apify and writes to the selected Convex backend
  (Convex Cloud or self-hosted).
- `GET /api/cron/ingest-venues` succeeds with
  `Authorization: Bearer <CRON_SECRET>`.

## Monitoring

Minimum monitoring:

- External uptime check for `https://events.example.com/events`.
- Internal health check for `http://127.0.0.1:3000/api/health`.
- Docker health status from `docker compose ps`.
- Web logs from `docker compose logs --tail 200 web`.
- Cron logs from syslog or systemd timer logs.
- Convex dashboard for function errors, ingestion job writes, and data shape
  (Convex Cloud dashboard or SSH-tunneled self-hosted dashboard on 127.0.0.1:6791).
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

- `npm run qa:release` includes `npm run build`; a build failure or timeout is a
  release blocker.
- The Docker build also runs `npm run lint`, `npm run typecheck`, and
  `npm run build`, so verify image builds with the same public env values used in
  production.
- Vercel Cron does not run after moving the app to a VPS. Host cron or a systemd
  timer must be installed before relying on scheduled ingestion.
- Build-time public env values must match production runtime values. Rebuild the
  image when `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` or `NEXT_PUBLIC_CONVEX_URL`
  changes.
- Production admin routes fail closed if Clerk env vars are missing. This is
  expected and safer than exposing admin APIs.
- Self-hosted Convex removes Convex Cloud quotas but adds VPS storage, backup,
  upgrade, and monitoring responsibilities. Do not expose the self-hosted
  dashboard publicly without VPN/Tailscale or reverse-proxy auth.
- Replacing Convex with another database is still a separate migration and not
  part of the self-hosted Convex overlay.
