# Nightlife Event Aggregator

A Next.js app for collecting event data from Instagram, moderating it, and publishing approved events in list and calendar views.

## What It Covers

- Public event discovery at `/events`
- Monthly browsing at `/calendar`
- Admin moderation at `/admin`
- Scrape controls at `/admin/scraper`
- Venue management at `/admin/venues`

## Stack

- Next.js 14 + TypeScript
- Tailwind CSS
- Convex
- Clerk
- OpenAI
- Apify

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

Copy `.env.example` to `.env.local` and set:

```env
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
NEXT_PUBLIC_CONVEX_URL=
CONVEX_DEPLOYMENT=
OPENAI_API_KEY=
APIFY_API_TOKEN=
APIFY_INSTAGRAM_ACTOR_ID=apify/instagram-post-scraper
OPENAI_VISION_MODEL=gpt-4.1-mini
CRON_SECRET=
EVENTS_TIMEZONE=Europe/Belgrade
```

Notes:

- `CRON_SECRET` protects the cron ingestion route when set.
- `EVENTS_TIMEZONE` controls local event-day handling.

## Useful Scripts

```bash
npm run dev
npm run lint
npm run typecheck
npm run convex:codegen
npm run qa:extraction
```

## Ingestion Flow

1. Scrape Instagram posts with Apify.
2. Extract structured event data with OpenAI.
3. Store results in Convex as `pending`.
4. Review events in `/admin`.
5. Show approved events on `/events` and `/calendar`.

Manual and admin-triggered scrape endpoints live under `app/api/admin/scrape/*`. The cron route is `GET /api/cron/ingest-venues` and uses `Authorization: Bearer <CRON_SECRET>` when `CRON_SECRET` is configured.

## Project Layout

```text
app/
  (auth)/
  (dashboard)/
  (main)/
components/
convex/
lib/
scripts/
```
