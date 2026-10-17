# Calendar filter update, 2026-10-17

Code release `b7e56b4` is live on eventzeka.com. It includes the UI change in
`bc25555` and the updated bounded-read release check.

- Choosing a category from All now isolates that category. Other categories can
  then be added or removed; All restores the full selection.
- Public labels are Barovi, Radionice and Ostalo. Their stable keys and stored
  event classifications are unchanged.
- Opening-hour fallback values use regular font weight without a separate
  Venue hours label. The weekly schedule heading is Hours. Event-time provenance,
  JSON-LD timestamps, sorting and ingestion remain unchanged.
- Open now uses `Europe/Belgrade`, including daylight saving time. It selects
  today's program at currently open venues and includes yesterday's rows only
  during a verified overnight continuation. Unknown opening hours are excluded.
  This is a venue-opening filter, not a claim that a performance has begun.
- The clock updates every minute and refreshes active results. Category,
  search, venue and sort controls retain the mode; date navigation leaves it.
  Open now loads only yesterday through tomorrow, including month boundaries.

## Production release

- Container: `ig-event-web-calendar-open-now-b7e56b4`.
- Source: `/root/ig_event-releases/calendar-open-now-b7e56b4`.
- Compose: `/root/ig_event-release-artifacts/calendar-open-now-b7e56b4/production.compose.yml`.
- Loopback: `http://127.0.0.1:3137`; Traefik priority 1004.
- Dependency mount: `/root/ig_event-releases/upcoming-role-audit-c38f9d9/node_modules`.
- Prior main container retained: `ig-event-web-venue-hours-b58e285`.

The router retains the `/api/social` exclusion. The prior main web, social and
Convex backend containers retained their IDs and start times. Apify settings
and budgets were preserved. This release needed no backend or data mutation.

The frozen patch verified 23 file hashes before and after staging. Runtime
source matched `b58e285`; one documentation file still matched the committed
`62014b9` version, which was explicitly recorded in the manifest before overlay.
The new release preserves 28 older static assets for existing clients.

## Verification

`npm run qa:release`, including build and the new `qa:venue-open-now` suite,
passed, as did `git diff --check`. Focused cases cover both DST transitions,
exact opening/closing boundaries, split windows, midnight continuations,
unknown schedules and future-date exclusion. The Linux release separately
passed lint, typecheck and build.

Preview and production health, calendar, event and map checks passed. All 14
referenced local script assets matched the new build. A request containing a
future month/day with `open=now` still selected the current Belgrade date.
The preview's 66 returned event IDs at 17:03 matched the public-data verifier
exactly, with no extra or missing IDs. Production returned the same count at
17:07 and the live browser showed the current Belgrade clock.

Browser checks confirmed category isolation, All reset, category and sort
preservation with Open now, and date navigation clearing the mode. Fallback
time values computed to font weight 400 in both calendar and event detail;
the old visible label was absent. Checks at 390px and 1440px had no horizontal
overflow. Unknown event time remained date-only in JSON-LD, and an announced
21:00 retained its timestamp.
An isolated live browser retained `open=now` through reload and the 17:13 to
17:14 clock refresh; captured history updates preserved the query.

Private manifests, QA markers, build log, smoke results, browser evidence and
opening-filter snapshots are under
`/root/ig_event-release-artifacts/calendar-open-now-b7e56b4`.
Temporary preview and build containers were removed after verification. The
active release and the required dependency mount remain in place.
