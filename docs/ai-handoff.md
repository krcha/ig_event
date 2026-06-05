# AI Handoff Guide

Last reviewed: 2026-06-05

This guide is for an AI agent that arrives with only a GitHub link and needs to
be productive without guessing. Treat it as a map of the current repo, not a
substitute for reading the code that you are about to edit.

## Current Mission

The product is a Belgrade nightlife event aggregator. Its job is to turn
Instagram activity from venues and promoters into public event listings that are
trustworthy enough for users to browse without manual cross-checking.

The core product promise is:

- Scrape Instagram posts from configured venues or pasted handles.
- Extract structured event data from posters, captions, and post metadata.
- Store events as pending unless confidence is very high.
- Give admins enough context to approve, reject, repair, and dedupe events.
- Publish only approved upcoming events on public list and calendar pages.

Current priorities from `DEVELOPMENT_PLAN.md`:

- Keep ingestion reliable under route/runtime limits.
- Keep moderation conservative; automation should accelerate review, not hide
  uncertainty.
- Merge approved duplicates without losing saved-event references.
- Make operator-facing run summaries explain what happened.
- Keep deterministic QA green before shipping.

Known current follow-up:

- `npm run qa:release` is the intended deterministic gate.
- `next build` is intentionally not part of that gate yet because the local
  build has been reported to hang before useful Next output appears. Verify in
  CI or a clean shell before treating production readiness as solved.

## First 15 Minutes From A GitHub Link

1. Clone the repo and check the active branch plus dirty state before editing.
   Parallel agents may be working in the same repository.
2. Read `README.md`, `DEVELOPMENT_PLAN.md`, and this file.
3. Install dependencies with `npm install` or `npm ci`.
4. Copy `.env.example` to `.env.local` and provide real service credentials if
   you need to run ingestion or admin flows.
5. Run `npx convex dev` if Convex is not connected locally, then run
   `npm run convex:codegen` if generated Convex types are stale.
6. Use `npm run dev` for local UI work.
7. Use `npm run qa:release` before handing off code changes that affect
   behavior.

Important env vars:

- `NEXT_PUBLIC_CONVEX_URL`: required for Next server routes and public pages to
  read/write Convex.
- `CONVEX_DEPLOYMENT`: used by Convex tooling.
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`: enable Clerk
  auth. Production admin routes fail closed if Clerk is not configured.
- `ADMIN_CLERK_USER_IDS`: allowlist for admin UI visibility.
- `OPENAI_API_KEY`: required for extraction and approved-event master review.
- `OPENAI_VISION_MODEL`: `.env.example` pins `gpt-4.1-mini`; code has a
  fallback, so set it explicitly for cost and model control.
- `OPENAI_REVIEW_MODEL`: same recommendation for approved-event master review.
- `APIFY_API_TOKEN`: required for Instagram scraping.
- `APIFY_INSTAGRAM_ACTOR_ID`: defaults to `apify/instagram-post-scraper`.
- `CRON_SECRET`: protects scheduled ingestion when set. If blank, the cron route
  allows unauthenticated calls for local convenience.
- `EVENTS_TIMEZONE`: defaults operational expectations to `Europe/Belgrade`.

## Architecture Overview

This is a Next.js 14 App Router app with TypeScript, Tailwind CSS, Convex,
Clerk, OpenAI, and Apify.

Top-level areas:

- `app/(main)`: public pages.
  - `/events`: paginated approved event feed with search.
  - `/calendar`: monthly calendar for approved events.
  - `/events/[eventId]`: event detail page.
- `app/(dashboard)`: admin pages.
  - `/admin`: moderation dashboard.
  - `/admin/scraper`: scrape controls and ingestion summaries.
  - `/admin/venues`: venue CRUD and CSV import.
- `app/(auth)`: Clerk sign-in and sign-up pages.
- `app/api`: Next route handlers for admin, ingestion, cron, and health.
- `components`: UI components for admin, events, calendar, and navigation.
- `convex`: schema, queries, mutations, internal cron jobs, and generated types.
- `lib/pipeline`: ingestion orchestration, venue normalization, recent scrape
  cooldown helpers, and venue-name overrides.
- `lib/scraper`: Apify Instagram actor integration and Apify run-history import.
- `lib/ai`: OpenAI extraction, image preparation, and approved-event review.
- `lib/events`: public event loading, duplicate detection, auto-merge, and
  event retention logic.
- `scripts`: deterministic QA and release-gate scripts.
- `docs`: operational docs. This handoff lives here.

## Durable Data Model

Convex owns the durable state. See `convex/schema.ts`.

`events`:

- Main event records.
- Status is `pending`, `approved`, or `rejected`.
- Public pages should only show approved upcoming events.
- Source identity is stored in `instagramPostId` and `instagramPostUrl`.
- Raw and normalized extraction details live in `rawExtractionJson` and
  `normalizedFieldsJson`.

`venues`:

- Configured source venues with `name`, `instagramHandle`, `category`,
  optional `location`, and `isActive`.
- Active venue handles are the default source for venue-wide ingestion.

`scrapedPosts`:

- Cached Instagram post records by handle.
- Populated from fresh Apify scraping, Apify run history, or existing event
  imports.
- Used by `saved_posts` ingestion mode so extraction can run from stored posts
  without re-scraping Instagram.

`ingestionJobs`:

- Tracks queued/running/completed/failed jobs.
- Stores `summaryJson` and `stateJson` so the UI can process bounded batches.
- Current job modes are `full_scrape` and `saved_posts`.

`users` and `userSavedEvents`:

- Clerk-backed user records and saved event references.
- Duplicate approved-event merges reassign saved references before deleting
  duplicate event rows.

## Service Boundaries

Next.js route handlers:

- Authenticate admin requests when Clerk env vars are configured.
- Validate request bodies.
- Create or advance ingestion jobs.
- Call Convex through `ConvexHttpClient`.
- Call pipeline helpers for expensive ingestion work.

Convex:

- Stores all event, venue, scraped post, user, saved-event, and ingestion-job
  state.
- Exposes data operations through queries and mutations in `convex/*.ts`.
- Runs an hourly internal cron to delete expired events.

Apify:

- Fetches Instagram account or post data.
- `lib/scraper/instagram-scraper.ts` normalizes Apify output into
  `InstagramScrapedPost`.
- Actor id defaults to `apify/instagram-post-scraper`; legacy actor ids are
  normalized.

OpenAI:

- `lib/ai/extract-event-data.ts` calls the Responses API with a strict JSON
  schema for poster/caption extraction.
- `lib/ai/review-approved-events.ts` calls the Responses API for approved-event
  master review of duplicate candidates.
- Prompts live in `lib/ai/event-extraction-prompt.ts` and
  `lib/ai/approved-events-master-review-prompt.ts`.

Clerk:

- Middleware protects `/admin(.*)` and `/api/admin(.*)` when Clerk is
  configured.
- `lib/auth/admin.ts` checks `ADMIN_CLERK_USER_IDS` for showing admin-only UI
  affordances.
- In production, admin routes fail closed if Clerk env vars are absent.

Vercel or VPS:

- `vercel.json` schedules `GET /api/cron/ingest-venues` at `0 8 * * *`.
- `docs/vps-self-hosting.md` describes the self-hosted Next container path while
  keeping Convex, Clerk, OpenAI, and Apify managed.
- `Dockerfile`, `docker-compose.yml`, and `/api/health` support containerized
  deployment.

## Key Workflows

### Public Event Browsing

1. `/events` calls `loadUpcomingApprovedEventsPage` in
   `lib/events/public-events.ts`.
2. `/calendar` calls `loadUpcomingApprovedEvents`.
3. Those helpers query Convex for approved events from today or a small
   configured lookback.
4. Public loading filters likely duplicate approved events using
   `buildApprovedEventAutoCleanupGroups`.
5. Events are sorted by normalized date, time, title, and id.
6. Search on `/events` matches title, venue, type, ticket notes, and artists.

### Venue Management

1. `/admin/venues` renders `components/admin/venue-manager.tsx`.
2. `GET/POST/PATCH/DELETE /api/admin/venues` maps UI operations to Convex
   `venues` queries and mutations.
3. `POST /api/admin/venues/import` imports CSV rows. Current parser expects
   Instagram handle in `_ap3a` and venue name in `x1lliihq`.
4. Venue handles are normalized by removing leading `@` and lowercasing.
5. Active venues drive the default "all active venues" ingestion workflow.

### Queued Manual Ingestion

1. `/admin/scraper` uses `components/admin/scraper-dashboard.tsx`.
2. `POST /api/admin/scrape` validates pasted handles and creates an
   `ingestionJobs` row with source `manual`.
3. `POST /api/admin/scrape/venues` loads active venue handles, filters out
   fresh full-scrape attempts from the last 24 hours, and creates a source
   `active_venues` job.
4. `POST /api/admin/scrape/repair` creates a source `repair_active_venues` job
   with short backfill defaults.
5. The UI polls `POST /api/admin/scrape/jobs/[jobId]` every two seconds.
6. Each poll advances one bounded batch through
   `runInstagramIngestionBatchStep`.
7. The job route persists updated `summaryJson`, `stateJson`, status, and
   timestamps after every batch.
8. When done, the pipeline runs approved-event auto-merge and records the
   cleanup summary in the ingestion summary.

This queue is route-driven polling, not a separate background worker. If no one
calls the job POST route, the job will not keep advancing.

### Full Scrape Ingestion

1. `full_scrape` mode calls Apify through `scrapeInstagramAccount`.
2. Fresh posts are persisted into `scrapedPosts` in batches.
3. Direct full scrape uses limited parallelism when run through
   `runInstagramIngestion`.
4. Queued full scrape respects the job `batchSize`, loads posts per handle, and
   processes bounded posts per poll.
5. Video, image download, conversion, invalid event, missing date, missing
   venue, past event, and far-future cases are counted in the handle summary.

### Saved Posts Ingestion

1. `saved_posts` mode reads posts from Convex `scrapedPosts` by handle.
2. It can apply `resultsLimit` and `daysBack`.
3. This mode is useful after importing recent Apify run history or existing
   upcoming events into the saved-post cache.
4. It avoids a fresh Apify scrape but still runs image preparation, OpenAI
   extraction, normalization, duplicate checks, and event insert/update logic.

### Event Extraction And Normalization

1. `processIngestionPost` prepares image data when possible.
2. OpenAI extraction returns structured JSON for title, date, time, venue,
   price, category, artists, description, source fields, schedule entries, and
   field confirmation.
3. `prepareEventsForInsert` normalizes venue, title, date, artists, description,
   price, confidence, split schedules, and date ranges.
4. Events more than `MAX_EVENT_DAYS_AHEAD` ahead, events in the past, missing
   dates, missing venues, and invalid events are skipped.
5. Confidence is normalized in `lib/utils/confidence.ts`.
6. Auto-approval is conservative: `AUTO_APPROVE_CONFIDENCE_THRESHOLD` is `0.9`,
   and the code uses a strict greater-than comparison.
7. Missing image and suspected duplicate penalties can reduce moderation
   confidence.
8. Auto-approved events are inserted as `approved`; all others are inserted as
   `pending`.

### Duplicate Handling During Ingestion

1. Existing events are checked by source identity (`instagramPostId`,
   `instagramPostUrl`) and by prepared dates.
2. Clean duplicates are skipped and counted.
3. Low-quality existing duplicates can be patched with better extracted data.
4. Material changes can reset a previously reviewed event back toward safer
   moderation behavior depending on the patch logic.
5. New prepared events are inserted only after duplicate matching fails.

### Moderation

1. `/admin` renders `components/admin/moderation-dashboard.tsx`.
2. `GET /api/admin/events` loads events by status and can include duplicate
   context.
3. `POST /api/admin/events/moderate` approves or rejects one event or a bulk set
   of event ids.
4. Convex only allows `pending` events to be moderated through
   `setEventStatus` and skips non-pending rows in bulk operations.
5. The dashboard exposes filters for issues, suspected duplicates, suspicious
   years, low confidence, fallback titles, missing image, and missing time.

### Approved Event Deduplication

1. `POST /api/admin/events/dedupe-approved` runs deterministic approved-event
   auto-merge.
2. `runApprovedEventAutoMerge` loads approved events, filters to upcoming, builds
   conservative cleanup groups, and calls `events:mergeApprovedEvents`.
3. `mergeApprovedEvents` patches the primary event if requested, reassigns saved
   event references, and deletes duplicate approved event rows.
4. Public loaders also hide duplicate groups for display, even before a merge is
   run.
5. `POST /api/admin/events/master-review` uses OpenAI for a higher-level review
   of approved duplicate candidates.
6. `POST /api/admin/events/master-review/apply` applies a selected merge/delete
   recommendation through Convex.

### Scheduled Ingestion And Retention

1. Vercel Cron calls `GET /api/cron/ingest-venues` at `0 8 * * *`.
2. The route checks `Authorization: Bearer <CRON_SECRET>` if `CRON_SECRET` is
   set.
3. It loads active venue handles, skips handles with a fresh full-scrape attempt
   inside the cooldown window, creates an ingestion job, runs direct full-scrape
   ingestion, and patches job status.
4. Convex internal cron `delete expired events` runs hourly at minute 5 UTC and
   deletes expired events plus saved-event references in batches.
5. Event retention uses `EVENTS_TIMEZONE` and event time when available.

## Testing And Verification

Use these scripts:

- `npm run lint`: ESLint.
- `npm run typecheck`: TypeScript.
- `npm run qa:dedupe`: deterministic duplicate QA.
- `npm run qa:automerge`: deterministic approved-event automerge QA.
- `npm run qa:extraction`: deterministic extraction/normalization QA.
- `npm run qa:release`: runs lint, typecheck, dedupe QA, automerge QA, and
  extraction QA with timeouts.
- `npm run convex:codegen`: refresh Convex generated types.

GitHub Actions:

- `.github/workflows/release-gates.yml` runs `npm ci` and `npm run qa:release`
  on push and pull request.

Manual checks after UI or workflow changes:

- Public `/events` loads approved upcoming events and search works.
- Public `/calendar` loads the current month and filters by venue/type/weekend.
- `/admin` loads pending events and can approve/reject a test event.
- `/admin/scraper` can enqueue a job and poll it to completion.
- `/admin/venues` can create/update an active venue.
- `/api/health` returns an OK response in deployment.

## Risk Register

Build reliability:

- `next build` has a known local hang. Do not assume production readiness from
  `qa:release` alone until the build behavior is understood.

External quotas and costs:

- Apify and OpenAI are called from route handlers. Quota/rate/cost failures must
  show clearly in ingestion summaries.
- Set OpenAI model env vars explicitly; code fallbacks may not match the desired
  cost profile.

Auth configuration:

- Local development can run admin routes without Clerk. Production fails closed
  through middleware when Clerk env vars are absent.
- Several route handlers still do their own "if Clerk is configured, require a
  user" checks. When touching auth, reason about both middleware and handler
  behavior.

Cron exposure:

- `/api/cron/ingest-venues` is unauthenticated when `CRON_SECRET` is blank. This
  is convenient locally and dangerous in production.

Queue semantics:

- Ingestion jobs are not processed by a real worker. They advance when the UI or
  caller posts to `/api/admin/scrape/jobs/[jobId]`.
- A queued or running job can stall forever if polling stops.

Data deletion:

- Approved duplicate merge deletes duplicate event rows after moving saved-event
  references.
- Event retention deletes expired events and saved references hourly. Check
  timezone and cutoff behavior before changing retention logic.

Date normalization:

- Nightlife events cross midnight. Be careful with `EVENTS_TIMEZONE`, event
  time parsing, past-event filtering, and retention cutoffs.
- Far-future filtering currently caps events at 90 days ahead.

Duplicate sensitivity:

- False positive merges are more harmful than false negatives. Keep duplicate
  auto-merge conservative and backed by QA fixtures.
- Public loaders hide duplicates using the same grouping logic; changing it can
  affect visible public results even without database mutations.

Instagram and Apify data shape:

- `instagram-scraper.ts` accepts many possible Apify fields. Actor output can
  change, so prefer robust parsing and fixture-backed changes.
- Actor input accepts handles and Instagram post URLs. Handle normalization is
  repeated in a few places; keep behavior consistent.

Image handling:

- Extraction quality depends on poster image availability and conversion.
- CDN URLs, image download failures, and sharp conversion failures should be
  counted and logged without killing the whole run.

Stringly typed Convex references:

- Many route and pipeline calls cast string names such as `events:createEvent`
  to `FunctionReference`. Renames can compile but fail at runtime if not
  updated consistently.

Parallel-agent work:

- This repo may be modified by multiple agents. Always inspect `git status` and
  file diffs before editing. Do not revert unrelated user or agent work.

Secrets:

- Do not commit real `.env.local`, Clerk keys, OpenAI keys, Apify tokens, Convex
  deploy keys, or cron secrets.

## Recommended Next Steps

1. Reproduce and diagnose the local `next build` hang. Add `next build` back to
   the release gate only after the hang is resolved or bounded.
2. Add or refresh fixtures around full-scrape batch behavior, especially
   `batchSize`, stalled jobs, and resume state.
3. Make ingestion job processing less dependent on the browser poll loop, or at
   least add an operator path to resume stale queued/running jobs.
4. Improve run observability by surfacing Apify/OpenAI quota errors, skipped
   reasons, and duplicate cleanup results in one compact admin summary.
5. Keep auto-approval conservative until there is real production confidence
   data. Any threshold change should update `qa:extraction`.
6. Extend duplicate QA before touching `approved-event-duplicates.ts` or
   ingestion duplicate matching. Include saved-event reference behavior when
   testing merge mutations.
7. Verify production auth and cron configuration before deployment:
   `ADMIN_CLERK_USER_IDS`, Clerk keys, `CRON_SECRET`, Convex URL, OpenAI models,
   and Apify actor/token.
8. Decide whether VPS or Vercel is the primary deployment target. If VPS, follow
   `docs/vps-self-hosting.md` and replace Vercel Cron with host cron or a
   systemd timer.
9. Consider consolidating repeated admin auth and Convex client helpers in route
   handlers, but only after behavior is covered. Avoid broad refactors during
   ingestion stabilization.
10. Keep the next product milestone focused: trustworthy public calendar first,
   then more aggressive automation.

## High-Value Files To Read Before Editing

- Product and setup: `README.md`, `DEVELOPMENT_PLAN.md`.
- Schema and Convex operations: `convex/schema.ts`, `convex/events.ts`,
  `convex/venues.ts`, `convex/scrapedPosts.ts`, `convex/ingestionJobs.ts`.
- Ingestion: `lib/pipeline/run-instagram-ingestion.ts`,
  `lib/scraper/instagram-scraper.ts`,
  `app/api/admin/scrape/jobs/[jobId]/route.ts`.
- Extraction: `lib/ai/extract-event-data.ts`,
  `lib/ai/event-extraction-prompt.ts`,
  `lib/ai/prepare-image-for-openai.ts`.
- Moderation and duplicates: `components/admin/moderation-dashboard.tsx`,
  `lib/events/approved-event-duplicates.ts`,
  `lib/events/approved-event-automerge.ts`.
- Public pages: `lib/events/public-events.ts`,
  `app/(main)/events/page.tsx`, `app/(main)/calendar/page.tsx`.
- Auth and env: `middleware.ts`, `lib/auth/admin.ts`, `lib/utils/env.ts`.
- Release: `scripts/release-check.mjs`,
  `.github/workflows/release-gates.yml`.

## Working Rules For The Next AI

- Read the local code before acting; this guide can drift.
- Prefer existing patterns and helpers over new abstractions.
- Keep ingestion changes small and fixture-backed.
- Keep public publication safer than convenient: pending review is acceptable,
  bad public data is not.
- Avoid destructive database or git operations unless the user explicitly asks.
- If the worktree is dirty, preserve unrelated changes.
- When changing visible UI, test the actual route in a browser and check mobile
  and desktop layouts.
- When changing external service calls, preserve clear error reporting and
  summary counters.
