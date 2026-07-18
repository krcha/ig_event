# Self-Hosted Convex Deployment

This guide runs Convex on the same VPS and Docker Compose project as the Event Zeka
web app. It keeps the application code on Convex APIs, but moves the Convex
backend out of Convex Cloud.

## Decision

Use separate containers in the same Compose stack:

```text
internet
  -> Traefik/Caddy/nginx TLS
  -> events.ineedtofeedmyrabbit.com       -> web container :3000
  -> convex-events.ineedtofeedmyrabbit.com -> convex-backend container :3210

operator SSH tunnel, local only
  -> 127.0.0.1:6791 -> convex-dashboard container :6791
```

Do not put Convex and Next.js in one Linux container. Convex upstream ships a
backend container and a dashboard container. Keeping them as separate Compose
services gives independent health checks, restarts, logs, upgrades, and a named
persistent data volume while still running on the same host/network as the app.

## What This Does And Does Not Remove

Self-hosting Convex removes Convex Cloud quotas for this app. It does not remove
limits or costs from:

- Apify Instagram scraping.
- OpenAI extraction/review calls.
- Clerk authentication.
- VPS CPU, RAM, disk, network, backups, and operator time.

The default self-hosted backend stores data in the `convex-data` Docker volume
using local SQLite. That is acceptable for a first migration/small deployment.
For a higher-durability production setup, move Convex storage to Postgres/MySQL
and configure S3-compatible object storage following upstream Convex self-hosted
docs.

## Files In This Repo

- `docker-compose.self-hosted-convex.yml` - Compose overlay adding
  `convex-backend`, `convex-dashboard`, and `convex-data`.
- `.env.production.example` - includes the self-hosted Convex variables needed
  by the overlay and Convex CLI.
- `docs/self-hosted-convex.md` - this runbook.

The existing `docker-compose.yml` and `docker-compose.runtime.yml` remain usable
for the hosted Convex path. Add the overlay only when you are running Convex on
the VPS.

## Required DNS And Public URL

Browser clients must reach the Convex deployment URL directly. The web container
cannot use `http://convex-backend:3210` as `NEXT_PUBLIC_CONVEX_URL`, because that
Docker DNS name is invisible to users' browsers.

For the current Traefik setup, create a DNS record:

```text
convex-events.ineedtofeedmyrabbit.com -> VPS public IP
```

Then set these env values before building the web app:

```env
NEXT_PUBLIC_CONVEX_URL=https://convex-events.ineedtofeedmyrabbit.com
CONVEX_CLOUD_ORIGIN=https://convex-events.ineedtofeedmyrabbit.com
CONVEX_TRAEFIK_HOST=convex-events.ineedtofeedmyrabbit.com
```

`CONVEX_SITE_ORIGIN` is only needed if Convex HTTP actions are exposed. This app
currently uses queries, mutations, and Convex crons, not Convex HTTP actions, so
the default local site-proxy port is enough.

## Environment

Start from `.env.production.example` and fill real secrets in `.env.production`
(or the existing live `.env.local` if you are using `docker-compose.runtime.yml`).

Self-hosted Convex-specific variables:

```env
# Browser/server app URL for Convex. Must be public if users load the app.
NEXT_PUBLIC_CONVEX_URL=https://convex-events.ineedtofeedmyrabbit.com

# Convex backend public origin. Keep equal to NEXT_PUBLIC_CONVEX_URL.
CONVEX_CLOUD_ORIGIN=https://convex-events.ineedtofeedmyrabbit.com

# Optional Convex HTTP action/site proxy origin. Not public unless you add a proxy.
CONVEX_SITE_ORIGIN=http://127.0.0.1:3211

# Local port bindings for backend, site proxy, and dashboard.
CONVEX_BACKEND_BIND=127.0.0.1
CONVEX_BACKEND_PORT=3210
CONVEX_SITE_BIND=127.0.0.1
CONVEX_SITE_PORT=3211
CONVEX_DASHBOARD_BIND=127.0.0.1
CONVEX_DASHBOARD_PORT=6791

# Traefik public backend route.
CONVEX_TRAEFIK_ENABLE=true
CONVEX_TRAEFIK_HOST=convex-events.ineedtofeedmyrabbit.com

# Convex CLI self-hosted deploy/import credentials.
CONVEX_SELF_HOSTED_URL=https://convex-events.ineedtofeedmyrabbit.com
CONVEX_SELF_HOSTED_ADMIN_KEY=
```

For self-hosted deploy/import commands, leave `CONVEX_DEPLOYMENT` blank or use a
separate env file that contains only the self-hosted URL/admin key. This avoids
accidentally targeting Convex Cloud when importing or deploying functions.

## First-Time Bring-Up

From the repo root on the VPS:

```bash
# Build/run the web app and Convex backend/dashboard in one Compose project.
docker compose --env-file .env.production \
  -f docker-compose.yml \
  -f docker-compose.self-hosted-convex.yml \
  up -d --build

# Check status and backend health.
docker compose --env-file .env.production \
  -f docker-compose.yml \
  -f docker-compose.self-hosted-convex.yml \
  ps

curl -fsS http://127.0.0.1:3210/version
curl -fsS http://127.0.0.1:3000/api/health
```

If the live VPS uses the bind-mounted runtime compose instead of the production
image compose, use:

```bash
docker compose --env-file .env.local \
  -f docker-compose.runtime.yml \
  -f docker-compose.self-hosted-convex.yml \
  up -d
```

## Generate The Admin Key

The Convex CLI needs a self-hosted admin key to deploy functions and import or
export data.

```bash
docker compose --env-file .env.production \
  -f docker-compose.yml \
  -f docker-compose.self-hosted-convex.yml \
  exec convex-backend ./generate_admin_key.sh
```

Copy the generated key into your private env file:

```env
CONVEX_SELF_HOSTED_ADMIN_KEY=<generated key>
```

Do not commit this key. It is equivalent to deployment/admin access for the
self-hosted Convex backend.

## Deploy Convex Functions To Self-Hosted Backend

After setting `CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY`:

```bash
npm run convex:codegen
npx convex deploy -y --typecheck disable --codegen enable --env-file .env.production
```

Verify the generated types are unchanged or expected:

```bash
git diff -- convex/_generated
```

## Migrate Data From Convex Cloud

Export cloud production before changing the app's public Convex URL:

```bash
mkdir -p backups
npx convex export --prod --path backups/convex-cloud-prod-$(date +%Y%m%d-%H%M%S).zip
```

Then import the snapshot into self-hosted Convex with the self-hosted env file:

```bash
npx convex import --replace-all --yes --env-file .env.production \
  backups/convex-cloud-prod-YYYYmmdd-HHMMSS.zip
```

After import, run read-only app checks before running ingestion:

```bash
curl -fsS http://127.0.0.1:3210/version
curl -fsS http://127.0.0.1:3000/api/health
curl -fsS -I https://events.ineedtofeedmyrabbit.com/
```

Then check the public app and admin pages in a browser. Only run manual scraping
after public reads, admin auth, and a Convex data read are confirmed.

## Dashboard Access

The dashboard is intentionally bound to localhost only by default:

```text
127.0.0.1:6791 -> convex-dashboard:6791
```

Access it through an SSH tunnel:

```bash
ssh -L 6791:127.0.0.1:6791 root@<vps-host>
```

Then open `http://127.0.0.1:6791`. Do not expose the dashboard publicly unless a
separate reverse-proxy authentication layer or VPN/Tailscale-only route is in
place.

## Backups

Minimum backup before upgrades or migrations:

```bash
mkdir -p backups
npx convex export --env-file .env.production \
  --path backups/convex-self-hosted-$(date +%Y%m%d-%H%M%S).zip

docker run --rm \
  -v ig_event_convex-data:/data:ro \
  -v "$PWD/backups:/backups" \
  alpine sh -c 'tar -czf /backups/convex-data-volume-$(date +%Y%m%d-%H%M%S).tgz -C /data .'
```

The Docker volume name includes the Compose project prefix. If your project name
is not `ig_event`, confirm it with:

```bash
docker volume ls | grep convex-data
```

For production durability, also enable provider/VPS snapshots before changing
Convex versions or importing data.

## Upgrade

Pin the image tag for predictable upgrades if needed:

```env
CONVEX_SELF_HOSTED_IMAGE_TAG=<known-good-tag>
```

Upgrade sequence:

```bash
# 1. Export data first.
npx convex export --env-file .env.production \
  --path backups/convex-self-hosted-before-upgrade-$(date +%Y%m%d-%H%M%S).zip

# 2. Pull and recreate Convex services.
docker compose --env-file .env.production \
  -f docker-compose.yml \
  -f docker-compose.self-hosted-convex.yml \
  pull convex-backend convex-dashboard

docker compose --env-file .env.production \
  -f docker-compose.yml \
  -f docker-compose.self-hosted-convex.yml \
  up -d convex-backend convex-dashboard

# 3. Verify.
docker compose --env-file .env.production \
  -f docker-compose.yml \
  -f docker-compose.self-hosted-convex.yml \
  logs --tail 100 convex-backend
curl -fsS http://127.0.0.1:3210/version
```

## Rollback

If the web app cannot read Convex after migration:

1. Restore the previous env file where `NEXT_PUBLIC_CONVEX_URL` points at Convex
   Cloud.
2. Rebuild the web app because `NEXT_PUBLIC_CONVEX_URL` is baked into the client
   bundle.
3. Restart the web service.
4. Keep the self-hosted Convex containers stopped until the issue is understood.

```bash
docker compose --env-file .env.production \
  -f docker-compose.yml \
  up -d --build web

docker compose --env-file .env.production \
  -f docker-compose.yml \
  -f docker-compose.self-hosted-convex.yml \
  stop convex-backend convex-dashboard
```

## Verification Checklist

- `docker compose ... config --quiet` passes with the overlay.
- `convex-backend` is healthy and `GET /version` returns successfully.
- `convex-events.ineedtofeedmyrabbit.com` routes to the backend over HTTPS.
- `NEXT_PUBLIC_CONVEX_URL` equals the public self-hosted backend URL at build
  time and runtime.
- Convex functions deploy successfully to self-hosted backend.
- Cloud production snapshot imports successfully.
- `/api/health` passes.
- Public browse page loads approved events.
- Admin auth works and admin pages can read/write Convex.
- Cron ingestion succeeds with `CRON_SECRET` set.
- Backups are documented and tested before upgrades.
