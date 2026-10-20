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
Known event starts and ends determine eligibility; a start-only event uses the
venue closing assumption above. Only confirmed active events are included.
An unresolved end is excluded, including missing hours and uninterrupted 24/7
hours without an announced event end. The internal `possible` state remains a
diagnostic classification and is not eligible for public Open now results.
An announced event end remains authoritative even when venue hours are absent.
This eligibility assumption does not invent or store an event end. Events without
a usable time otherwise use current venue opening hours, including verified
overnight continuations from yesterday. Enabling the home filter retains the
07:00 nightlife date; the map keeps its existing 06:00 display rollover. Both
read civil yesterday/today independently, retaining current-civil early starts.
Explicit date navigation leaves this mode. Other calendar filters remain
available. Results refresh each minute and when the tab becomes visible. The
control's visible and accessible label is simply `Open now`.

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
