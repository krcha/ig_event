# Architecture Overview

Event Zeka is a Next.js application backed by Convex. Convex can stay hosted in
Convex Cloud or run as a self-hosted backend in the same Docker Compose project
as the app. The product turns Instagram venue posts into reviewed public event
listings.

## Runtime Components

```text
Browser
  -> Next.js App Router pages and API routes
  -> Convex queries/mutations for persistent data
     (Convex Cloud or self-hosted convex-backend container)
  -> Clerk for auth
  -> Apify for Instagram scraping
  -> OpenAI Responses API for extraction/review
```

## Data Model

The source of truth is `convex/schema.ts`.

- `events`: extracted event records with `pending`, `approved`, or `rejected`
  status.
- `venues`: configured venue names and Instagram handles.
- `users`: Clerk-linked users.
- `userSavedEvents`: saved-event references.
- `scrapedPosts`: normalized raw Instagram post data.
- `ingestionJobs`: resumable job state for admin and cron ingestion.

## Public Surfaces

- `/` product entry point.
- `/events` approved upcoming events.
- `/events/[eventId]` event detail.
- `/calendar` monthly browsing.
- `/venues` public venue directory.
- `/map` compatibility redirect to `/venues`.
- `/api/health` container health check.

## Admin Surfaces

- `/admin` moderation dashboard.
- `/admin/scraper` ingestion controls and job status.
- `/admin/venues` venue management.
- `/api/admin/*` admin API routes protected by Clerk and
  `ADMIN_CLERK_USER_IDS` when Clerk is configured.

## Ingestion Flow

1. Load active venues from Convex.
2. Scrape recent posts with Apify through `lib/scraper/instagram-scraper.ts`.
3. Normalize posts to the `InstagramScrapedPost` contract.
4. Extract structured event data through OpenAI in `lib/ai/extract-event-data.ts`.
5. Normalize venue/date/title/confidence in `lib/pipeline/run-instagram-ingestion.ts`.
6. Insert approved or pending events in Convex.
7. Merge safe approved duplicates through `lib/events/approved-event-automerge.ts`.

## Moderation And Deduplication

Admins approve, reject, remove, or bulk-moderate events from `/admin`. Approved
duplicate cleanup merges likely duplicates into the strongest primary record and
reassigns saved-event references before deleting duplicate records.

## Deployment Shape

The low-complexity VPS path runs only the Next.js app in Docker and keeps
Convex Cloud managed. The self-hosted Convex path adds `convex-backend` and
`convex-dashboard` services through `docker-compose.self-hosted-convex.yml` on
the same Compose project/network. Clerk, OpenAI, and Apify remain managed in both
paths. See `docs/vps-self-hosting.md`, `docs/self-hosted-convex.md`, and
`docs/operations-runbook.md`.

## Extension Points

- Scraper replacement: must preserve `InstagramScrapedPost[]` before entering
  ingestion. Keep Apify fallback until reliability is proven.
- Convex hosting: can be Convex Cloud or the self-hosted Compose overlay without
  changing the app data API.
- Database replacement: replacing Convex itself with Postgres/SQLite is still a
  large data-layer rewrite. Plan it separately from self-hosting Convex.
- Build/deploy hardening: keep `next build` in the release gate and verify
  Docker image builds with production public env values.
