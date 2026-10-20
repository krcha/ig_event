# Venue Working Hours Runbook

The public event display already uses venue hours when an event has no explicit
time: `resolveEventTimeDisplay` falls back to the matched venue's weekly hours,
and public event loaders attach the venue hours payload. This runbook is about
populating and refreshing `venues.hoursJson`.

## Prerequisites

- `NEXT_PUBLIC_CONVEX_URL`
- `CRON_SECRET` for script and cron access to Convex venue mutations
- `GOOGLE_MAPS_API_KEY` only for Google place ID resolution and Google fallback
- `VENUE_HOURS_GOOGLE_FALLBACK=true` only when the scheduled cron should spend
  Google Places quota

Google fallback uses Places API (New). Store only `googlePlaceId` permanently;
Google hours stay in the existing 7-day venue-hours cache.

## OSM-First Backfill

1. Measure current coverage:
   `npm run qa:venue-hours`
2. Backfill all OSM-findable venues:
   `npm run repair:venue-hours -- --overpass --apply`
3. Re-run `npm run qa:venue-hours`.

Use `--force` to refetch all active venues, `--limit N` for batches, and
`--delay-ms N` to throttle provider calls. Dry run is the default unless
`--apply` is present.

Before using Google, close venue-name gaps through
`data/venue-name-overrides.csv` and, when needed, run
`npm run repair:event-venue-names`. Events that do not resolve to a venue record
cannot use venue hours.

## Google Fallback

Resolve Google place IDs once, then refresh hours with Google enabled.

```bash
npm run resolve:venue-place-ids
npm run resolve:venue-place-ids -- --apply
GOOGLE_MAPS_API_KEY=... npm run repair:venue-hours -- --google --apply
```

`resolve:venue-place-ids` uses Text Search (New) with an IDs-only field mask and
stores only `{ googlePlaceId }` through the existing `patchVenueHours` mutation.
By default it selects active venues without usable OSM/manual hours. Use `--all`
for every active venue and `--force` to re-resolve existing IDs.

`repair:venue-hours -- --google` remains OSM-first. Google is queried only when
OSM returns no usable hours, a stored `googlePlaceId` exists, and
`GOOGLE_MAPS_API_KEY` is set. Without `--google`, script behavior remains
OSM-only.

## Scheduled Refresh

This repo already has `GET /api/cron/refresh-venue-hours` in `vercel.json`.
The cron is protected by `CRON_SECRET` and defaults to OSM-only. To allow
scheduled Google fallback, set both:

```bash
GOOGLE_MAPS_API_KEY=...
VENUE_HOURS_GOOGLE_FALLBACK=true
```

The cron response includes `googleFallbackRequested`, `googleFallback`, and
`googleFallbackMissingKey` so production logs show whether Google was actually
available.

## UI

The event detail page renders `VenueWeeklyHours` below the main event panel.
The component renders nothing when no usable weekly hours exist and shows source
attribution for Google, OpenStreetMap, or manual hours.

## Verification

Run the focused checks before a Google rollout:

```bash
npm run qa:google-hours
npm run qa:venue-hours
```

Run the full handoff gate before shipping:

```bash
npm run qa:release
git diff --check
```

Do an initial Google dry run with a small limit and inspect the JSON summary:

```bash
npm run resolve:venue-place-ids -- --limit 20
GOOGLE_MAPS_API_KEY=... npm run repair:venue-hours -- --google --limit 20
```
