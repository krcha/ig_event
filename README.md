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

Current recommendation: self-host only the Next.js web app on the existing VPS
if desired, while keeping Convex, Clerk, OpenAI, and Apify managed. Do not
replace services unless a later plan explicitly chooses that tradeoff.

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
- Convex for data, functions, generated types, and scheduled cleanup
- Clerk for admin authentication
- OpenAI Responses API for extraction and approved-event review
- Apify Instagram actor for scraping
- Docker Compose for the low-complexity VPS deployment path

## System Shape

```text
Public user/admin browser
  -> Next.js app routes and API routes
  -> Convex hosted backend for events, venues, users, scraped posts, jobs
  -> Apify for Instagram post scraping
  -> OpenAI for structured event extraction and duplicate review
  -> Clerk for authentication
```

The app has intentionally not replaced Convex, Clerk, OpenAI, or Apify. Docker
support only moves the Next.js web process onto a VPS.

## Local Setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

If Convex is not connected yet, run:

```bash
npx convex dev
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

- `NEXT_PUBLIC_CONVEX_URL` and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` are public
  build-time values for browser bundles. Rebuild Docker images if they change.
- `CRON_SECRET` protects the cron ingestion route when set. Set it in
  production.
- `EVENTS_TIMEZONE` controls local event-day handling.
- `ADMIN_CLERK_USER_IDS` is a comma- or space-separated allowlist for showing
  admin UI.
- Local development can run without Clerk keys. In production, `/admin` and
  `/api/admin/*` fail closed unless both Clerk keys are configured.
- Do not put deploy-only secrets such as `CONVEX_DEPLOY_KEYS` into the runtime
  env unless the server is actually deploying Convex.

## Useful Scripts

```bash
npm run dev
npm run build
npm run start
npm run lint
npm run typecheck
npm run qa:dedupe
npm run qa:automerge
npm run qa:extraction
npm run qa:release
npm run convex:codegen
```

`qa:release` runs the deterministic release gate used by CI: lint, typecheck,
dedupe QA, automerge QA, and extraction QA.

Known blocker: local `next build` has previously hung before useful Next output.
Docker image builds also call `next build`, so verify this in a clean shell or
CI before production rollout.

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
3. Convex functions still deploy separately through Convex tooling.

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
- GitHub Actions release gate via `npm run qa:release`.

Remaining high-priority follow-up:

- Resolve the `next build` hang and add `next build` to the required release
  gate.
- Verify Docker image build in CI or a clean shell.
- Add production smoke checks after build/startup are stable.

## Handoff Prompt

For another AI, use:

```text
You are taking over the Ig Event repo. Read README.md, INSTRUCTIONS.md,
DEVELOPMENT_PLAN.md, docs/ai-handoff.md, docs/architecture.md,
docs/operations-runbook.md, and docs/vps-self-hosting.md first. Do not replace
Convex, Clerk, OpenAI, or Apify unless explicitly asked. Preserve existing
behavior, run npm run qa:release after changes, and treat the local next build
hang as the main release blocker.
```
