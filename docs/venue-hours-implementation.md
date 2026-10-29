# Venue Working Hours Runbook

Public event loaders attach the matched venue's weekly hours. When the event has
no explicit time, detail, calendar and map views display that date's venue
windows in regular weight, without a separate opening-hours label. A start-only
event displays the matching venue closing as its assumed end.
`resolveEventTimePresentation` supplies this display context;
`resolveEventTimeDisplay` keeps canonical event-time evidence intact. Venue
opening hours never become stored event start/end times, structured data,
sorting keys, or day/night classification. This runbook covers populating and
refreshing `venues.hoursJson`.

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
attribution for Google, OpenStreetMap, or manual hours. Reviewed source links in
`raw.sourceUrls` or `raw.evidenceUrls` appear as clickable hours sources.

The main detail time tile, calendar rows and map use all opening windows for the
event's weekday when no event time is announced, including overnight closing
times. An announced start is preserved. When only a start is available, the
display assumes the event runs until the end of the venue's matching continuous
opening window. Touching midnight periods are joined; closing gaps remain
separate. An announced end always wins. This presentation assumption does not
change stored event times, provenance, sorting or structured data. Missing
weekdays remain unknown
(`Not available` in the weekly table), while only explicit closed days say
`Closed`. Partial source schedules must omit unknown weekdays rather than mark
them closed.

The calendar and map share an `Open now` control using `Europe/Belgrade` time.
As requested on 2026-10-29, eligibility describes the venue's current working
hours, rather than whether the event itself is underway. Current-outing listings
at a confirmed open venue can appear before their event starts or after it ends.
Announced event ranges never override venue closures, opening gaps or unknown
hours. Verified 24/7 venues are eligible without inventing a finite event end.
Missing/invalid schedules, source-none records, conflicting source/timezone
metadata and omitted weekdays remain unknown; internal `possible` states never
enter public Open now results. The existing seven-day provider refresh policy
and nonexpiring reviewed manual hours remain unchanged.

Announced starts only assign early-morning listings to their actual outing;
unknown-time listings keep their stored outing date. Previous outings cannot
revive the next night and expire at 07:00, including at 24/7 venues. This filter
does not modify canonical event times or the separate display-only closing
inference above. Home retains its 07:00 nightlife date; map keeps its existing
06:00 display rollover. Both read civil yesterday/today independently, retaining
current-civil early starts. Explicit date navigation leaves this mode. Other
calendar filters remain available. Results refresh each minute and when the tab
becomes visible. The visible and accessible label remains `Open now`.

## Verification

Run the focused checks before a Google rollout:

```bash
npm run qa:google-hours
npm run qa:venue-hours
npm run qa:venue-open-now
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
