# Ig Event

Ig Event is a Next.js app for turning Instagram venue activity into a moderated,
public Belgrade nightlife calendar. It scrapes venue profiles, extracts event
details with AI, stores records in Convex, gives admins a moderation workflow,
and publishes approved events to public list and calendar views.

## Start Here For Handoff

If you are another AI or engineer receiving only this GitHub repository, read in
this order:

1. [INSTRUCTIONS.md](INSTRUCTIONS.md) - operating instructions, guardrails, and
   exact verification commands.
2. [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) - product direction, current
   stabilization status, and next milestones.
3. [docs/ai-handoff.md](docs/ai-handoff.md) - architecture narrative, service
   boundaries, risks, and next recommended work.
4. [docs/architecture.md](docs/architecture.md) - compact runtime and data-flow
   overview.
5. [docs/operations-runbook.md](docs/operations-runbook.md) - local setup,
   deployment, cron, QA, monitoring, and rollback.
6. [docs/vps-self-hosting.md](docs/vps-self-hosting.md) - cheapest VPS path and
   financial tradeoffs.

Current deployment supports two Convex modes: hosted Convex Cloud, or
self-hosted Convex running on the same VPS/Compose project as the Next.js app.
Clerk, OpenAI, and Apify remain managed services unless a separate migration plan
explicitly replaces them.

## What The App Does

- Public event discovery at `/events`
- Monthly browsing at `/calendar`
- Event details at `/events/[eventId]`
- Admin moderation at `/admin`
- Scrape controls and ingestion job status at `/admin/scraper`
- Venue management at `/admin/venues`
- Cron ingestion at `/api/cron/ingest-venues`
- Health check at `/api/health`

## Stack

- Next.js 14 App Router + React 18 + TypeScript
- Tailwind CSS
- Convex for data, functions, generated types, and scheduled cleanup (hosted
  Convex Cloud or self-hosted Convex via Docker Compose overlay)
- Clerk for admin authentication
- OpenAI Responses API for extraction and approved-event review
- Apify Instagram actor for scraping
- Docker Compose for the low-complexity VPS deployment path

## System Shape

```text
Public user/admin browser
  -> Next.js app routes and API routes
  -> Convex backend for events, venues, users, scraped posts, jobs
     (Convex Cloud or self-hosted convex-backend container)
  -> Apify for Instagram post scraping
  -> OpenAI for structured event extraction and duplicate review
  -> Clerk for authentication
```

Docker support can run only the Next.js web process, or it can run the web app
plus self-hosted Convex using `docker-compose.self-hosted-convex.yml`. The
self-hosted Convex path still keeps Clerk, OpenAI, and Apify managed.

## Local Setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

If Convex is not connected yet, run one of the following:

```bash
# Cloud or local development deployment
npx convex dev

# Self-hosted backend in the same Docker Compose project as the app
npx convex deploy -y --typecheck disable --codegen enable --env-file .env.production
```

Then generate Convex types:

```bash
npm run convex:codegen
```

## Environment Variables

Copy `.env.example` to `.env.local` for development or
`.env.production.example` to `.env.production` for Docker/VPS deployment.

```env
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
CLERK_JWT_ISSUER_DOMAIN=
CLERK_AUTHORIZED_PARTIES=https://events.ineedtofeedmyrabbit.com
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/
NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/
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
INGESTION_POST_STEP_LIMIT=8
SCRAPED_POST_PAGE_SIZE=25
OPENAI_VISION_MODEL=gpt-4.1-mini
OPENAI_REVIEW_MODEL=gpt-4.1-mini
CRON_SECRET=
CRON_RESULTS_LIMIT=1
CRON_DAYS_BACK=10
CRON_INGESTION_MAX_STEPS=4
CRON_MAX_HANDLES_PER_RUN=600
CRON_FULL_SCRAPE_COOLDOWN_HOURS=23
EVENTS_TIMEZONE=Europe/Belgrade
APP_BIND=127.0.0.1
APP_PORT=3000
```

Notes:

- `NEXT_PUBLIC_CONVEX_URL` and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` are public
  build-time values for browser bundles. Rebuild Docker images if they change.
  For self-hosted Convex, `NEXT_PUBLIC_CONVEX_URL` must be the public HTTPS
  backend URL reachable by browsers, not Docker DNS such as
  `http://convex-backend:3210`.
- `NEXT_PUBLIC_CLERK_SIGN_IN_URL`, `NEXT_PUBLIC_CLERK_SIGN_UP_URL`, and the
  fallback redirect URLs point Clerk at the in-app `/sign-in` and `/sign-up`
  pages and send successful default sign-ins back to `/`.
- `CLERK_AUTHORIZED_PARTIES` should be set in production to the public app
  origin so Clerk middleware rejects session tokens minted for another
  subdomain.
- The in-app auth pages use custom Clerk email/password sign-in and sign-up
  forms with email-code verification. They intentionally avoid Clerk's generic
  social provider picker so disabled or unconfigured OAuth providers cannot be
  launched from the app UI.
- `CRON_SECRET` protects the cron ingestion route when set. Set it in
  production.
- Cron ingestion defaults to one latest Instagram post per active venue handle,
  all active handles up to the 600-handle safety cap, and a 23-hour cooldown so
  the daily 07:00 UTC schedule is not blocked by normal scheduler jitter.
- `EVENTS_TIMEZONE` controls local event-day handling.
- `ADMIN_CLERK_USER_IDS` is a comma- or space-separated allowlist for admin
  pages and `/api/admin/*`.
- Local development can run without Clerk keys. In production, `/admin` and
  `/api/admin/*` fail closed unless both Clerk keys are configured; when Clerk
  is configured, the admin allowlist must also be populated.
- Do not put deploy-only secrets such as `CONVEX_DEPLOY_KEYS` into the runtime
  env unless the server is actually deploying Convex. For the self-hosted path,
  `CONVEX_SELF_HOSTED_ADMIN_KEY` is also a deploy/import secret and must stay out
  of git.
- Full self-hosted Convex operations live in
  [docs/self-hosted-convex.md](docs/self-hosted-convex.md).

## Useful Scripts

```bash
npm run dev
npm run build
npm run start
npm run lint
npm run typecheck
npm run qa:dedupe
npm run qa:automerge
npm run qa:master-review
npm run qa:extraction
npm run qa:ingestion-triage
npm run qa:clerk-email-auth
npm run qa:release
npm run qa:self-hosted-convex-compose
npm run convex:codegen
```

`qa:release` runs the deterministic release gate used by CI: lint, typecheck,
`next build`, dedupe QA, automerge QA, extraction QA, venue taxonomy QA, public
search/sort/mobile QA, Apify cost-control QA, follow-discovery QA, Convex
retention-cron QA, and Clerk email auth QA.

`npm run build` is a normal release requirement. Treat any build failure or
timeout as a release blocker before production rollout.

## Core Workflows

Ingestion:

1. Admin or cron starts an ingestion job.
2. Active venues are loaded from Convex.
3. Apify fetches recent Instagram posts per venue handle.
4. OpenAI extracts structured event data from captions/images.
5. High-confidence events are auto-approved; uncertain items stay pending.
6. Approved duplicate automerge runs when ingestion completes.

Moderation:

1. Admin reviews pending events in `/admin`.
2. Admin approves, rejects, removes, or bulk-moderates records.
3. Approved events become visible on `/events` and `/calendar`.

Deployment:

1. Hosted/Vercel deployment can use `vercel.json` cron.
2. VPS deployment runs the Next app in Docker and replaces Vercel Cron with host
   cron or systemd timers.
3. Convex can stay on Convex Cloud, or run self-hosted in the same Compose stack
   with `docker-compose.self-hosted-convex.yml`.
4. Convex functions still deploy separately through Convex tooling, targeting
   either the cloud deployment or `CONVEX_SELF_HOSTED_URL`.

## Repository Map

```text
app/                  Next.js pages, API routes, auth/admin/public surfaces
components/           UI components for admin, events, calendar, navigation
convex/               Convex schema, queries, mutations, crons, generated types
lib/ai/               OpenAI prompts, extraction, image preparation, review
lib/events/           public event helpers, dedupe, retention, automerge
lib/pipeline/         Instagram ingestion, venue normalization, job execution
lib/scraper/          Apify Instagram scraper adapter and output normalization
scripts/              deterministic QA and release gate scripts
docs/                 handoff, operations, deployment, and cost documentation
```

## Current State

Completed stabilization work includes:

- Conservative auto-approval threshold and extraction QA coverage.
- Future-relative approved-event automerge QA.
- Queued ingestion batch-size fix for full-scrape jobs.
- Admin scraper dashboard copy aligned with approved/pending/quota/automerge
  behavior.
- Production admin routes fail closed when Clerk is missing.
- Docker/Compose health-check deployment path for the web app.
- Optional self-hosted Convex Compose overlay and runbook for moving Convex off
  Convex Cloud while keeping the Convex API/data model.
- GitHub Actions release gate via `npm run qa:release`, including `next build`.

Remaining high-priority follow-up:

- Verify Docker image build in CI or a clean shell with production public env
  values.
- Add production smoke checks after build/startup are stable.

## Handoff Prompt

For another AI, use:

```text
You are taking over the Ig Event repo. Read README.md, INSTRUCTIONS.md,
DEVELOPMENT_PLAN.md, docs/ai-handoff.md, docs/architecture.md,
docs/operations-runbook.md, docs/vps-self-hosting.md, and
docs/self-hosted-convex.md first. Convex can run hosted or self-hosted through
the Compose overlay; do not replace Clerk, OpenAI, or Apify unless explicitly
asked. Preserve behavior, run npm run qa:release after changes, and treat any
next build failure or timeout as a release blocker.
```
