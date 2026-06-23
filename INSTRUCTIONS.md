# Ig Event AI Handoff Instructions

These instructions are for any AI or engineer taking over the repository from a
GitHub link. They are intentionally explicit so the next agent can start safely
without the original conversation.

## First 15 Minutes

1. Run `git status --short` and read the dirty/untracked files before editing.
2. Read `README.md`, `DEVELOPMENT_PLAN.md`, `docs/ai-handoff.md`,
   `docs/architecture.md`, `docs/operations-runbook.md`,
   `docs/vps-self-hosting.md`, and `docs/self-hosted-convex.md`.
3. Inspect `package.json`, `.env.example`, `.env.production.example`, and
   `convex/schema.ts`.
4. Run `npm run qa:release` before broad changes if dependencies are installed.
5. Do not run destructive git commands. Do not revert unrelated user work.

## Current Product Intent

The product is a Belgrade nightlife event aggregator. The core promise is a
trustworthy public calendar fed by Instagram venue activity and controlled by a
small admin workflow.

Default product stance:

- Favor false negatives over false positives for public event publishing.
- Keep uncertain AI extractions pending for human review.
- Keep duplicate merges conservative.
- Keep operator UX explicit about approved, pending, quota-blocked, and
  automerge outcomes.

## Service Boundaries

Do not replace these services without a separate explicit migration plan:

- Convex API/data model: data, functions, generated types, ingestion jobs, and
  scheduled cleanup. Convex may be hosted in Convex Cloud or self-hosted through
  `docker-compose.self-hosted-convex.yml`.
- Clerk: authentication and admin route protection.
- OpenAI: event extraction and approved-event review.
- Apify: Instagram scraping.

Current deployment strategy supports the existing managed-Convex path and an
optional self-hosted Convex path on the same VPS/Compose project. Replacing
Convex with another database, or replacing Clerk/OpenAI/Apify, still requires a
separate migration plan.

## Code Guardrails

- Use existing patterns before adding abstractions.
- Keep changes scoped; avoid opportunistic refactors.
- Use `apply_patch` or normal editor patches for manual edits.
- Do not commit secrets, `.env.local`, `.env.production`, or local exports.
- Keep docs and code ASCII unless the target file already requires Unicode.
- If changing Convex schema/functions, regenerate types with
  `npm run convex:codegen` when appropriate and verify generated diffs.
- If changing ingestion behavior, run the focused QA scripts and update docs if
  user-facing semantics change.

## Key Contracts

Instagram scraper output contract:

- `InstagramScrapedPost` in `lib/scraper/instagram-scraper.ts`
- Required pipeline fields include post identity, caption, image URLs, post URL,
  username, timestamp, post type, and optional location name.
- Any Apify replacement must return the same shape before entering ingestion.

Convex data contract:

- `convex/schema.ts` defines `events`, `venues`, `users`, `userSavedEvents`,
  `scrapedPosts`, and `ingestionJobs`.
- Event statuses are `pending`, `approved`, and `rejected`.
- Ingestion jobs are `queued`, `running`, `completed`, or `failed`.

Release gate contract:

- `npm run qa:release` must pass before handoff.
- It includes lint, typecheck, `next build`, dedupe QA, automerge QA,
  extraction QA, venue taxonomy QA, public search QA, and Apify cost-control QA.
- Treat any `next build` failure or timeout as a normal release blocker.

## Important Paths

```text
app/(main)/events/page.tsx                 public event list
app/(main)/calendar/page.tsx               public calendar
app/(dashboard)/admin/page.tsx             moderation dashboard
app/(dashboard)/admin/scraper/page.tsx     scraper dashboard
app/api/admin/scrape/*                     admin ingestion APIs
app/api/admin/events/*                     admin event APIs
app/api/admin/venues/*                     admin venue APIs
app/api/cron/ingest-venues/route.ts        scheduled ingestion endpoint
app/api/health/route.ts                    health check
components/admin/*                         admin UI
convex/*                                   data functions and schema
lib/pipeline/run-instagram-ingestion.ts    ingestion engine
lib/scraper/instagram-scraper.ts           Apify adapter
lib/ai/*                                   OpenAI prompts and calls
lib/events/*                               public events, retention, dedupe
scripts/*                                  deterministic QA
```

## Environment And Deployment

Use `.env.example` for local development and `.env.production.example` for the
Docker/VPS path.

Critical deployment notes:

- `NEXT_PUBLIC_CONVEX_URL` and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` are baked
  into client bundles at build time.
- `CRON_SECRET` must be set in production.
- Production admin routes fail closed if Clerk keys are missing.
- Docker Compose binds to `127.0.0.1:3000` by default; expose it through Caddy
  or nginx.
- Vercel Cron is configured in `vercel.json`; VPS deployment needs host cron or
  a systemd timer instead.

## Verification Commands

Run these after most code changes:

```bash
npm run qa:release
git diff --check
```

Run focused checks when relevant:

```bash
npm run lint
npm run typecheck
npm run build
npm run qa:dedupe
npm run qa:automerge
npm run qa:extraction
docker compose --env-file .env.production.example config
```


## Known Risks

- `next build` is part of the normal release gate. If it fails or times out,
  fix the build before handoff or production rollout.
- Apify and OpenAI are the primary variable cost centers.
- Self-hosted Convex removes Convex Cloud quotas but adds VPS storage, backup,
  upgrade, dashboard-security, and monitoring responsibilities.
- Replacing Convex with Postgres/SQLite is still a large data-layer rewrite.
- Replacing Apify with browser automation is possible only if it preserves the
  scraper output contract; it may be fragile and should start behind a feature
  flag with Apify fallback.
- Admin authorization currently relies on Clerk plus UI allowlist behavior; be
  careful before exposing admin flows publicly.

## Recommended Next Work

1. Verify Docker image build with real production public env values.
2. Add production smoke tests for `/api/health`, `/events`, `/calendar`, and
   authenticated admin routes.
3. Add spend controls and monitoring for Apify/OpenAI usage.
4. Only then consider service replacement experiments.
