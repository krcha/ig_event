# Nightlife Event Aggregator

Centralize nightlife events from Instagram into one calendar and list view.

## Stack
- Next.js 14 (App Router) + TypeScript
- Tailwind CSS + shadcn/ui
- Convex
- Clerk

## Quickstart

```bash
npm install
cp .env.example .env.local
npm run dev
```

## Environment Variables

Populate `.env.local` with:

```
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
NEXT_PUBLIC_CONVEX_URL=
CONVEX_DEPLOYMENT=
OPENAI_API_KEY=
APIFY_API_TOKEN=
APIFY_INSTAGRAM_ACTOR_ID=apify/instagram-scraper
OPENAI_VISION_MODEL=gpt-4.1-mini
CRON_SECRET=
```

## Convex Codegen

Run Convex code generation after deployment is configured:

```bash
npm run convex:codegen
```

If this fails with `No CONVEX_DEPLOYMENT set`, run `npx convex dev` first to connect the project.

## Phase 2 Pipeline

- Manual handles: `POST /api/admin/scrape`
- Active venues (admin): `POST /api/admin/scrape/venues`
- Active venues (cron): `GET /api/cron/ingest-venues`
  - Protected via `Authorization: Bearer <CRON_SECRET>` when `CRON_SECRET` is set.
  - Vercel cron schedule is defined in `vercel.json` (every 6 hours).

Each run executes:
1. Instagram scraping via Apify
2. Event extraction via OpenAI vision
3. Event persistence in Convex as `pending`

Admin scrape controls are available at `/admin/scraper`.

## Moderation Flow

- Review queue UI: `/admin`
- List moderation events: `GET /api/admin/events?status=pending|approved|rejected`
- Transition status: `POST /api/admin/events/moderate`
  - Allowed transitions from the UI are `pending -> approved` and `pending -> rejected`.
- Public events page (`/events`) shows only `approved` events.

## Project Structure

```
app/
  (auth)/
  (dashboard)/
  (main)/
components/
convex/
lib/
```
