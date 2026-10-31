# Calendar day navigation performance

This release addresses the production measurements from 2026-10-31: duplicate
mobile/desktop event trees, unnecessary venue-name canonicalization, and month
overview reads on the selected day's critical path.

## Data and rendering boundaries

- Calendar normalization skips legacy venue-name resolution when its existing
  `inferLegacyVenue` option is false. All other callers retain that resolution.
- The server still loads only the selected day's approved public events, or
  the existing overnight window for Open now. Publication, venue visibility,
  and ingestion/moderation behavior are unchanged.
- One `CalendarAgenda` receives a compact projection and renders one event row
  per event. It retains desktop busy-venue disclosures and mobile chronological
  ordering. `useSyncExternalStore` selects the responsive presentation with a
  deterministic server snapshot; it does not serialize two server-rendered
  lists. CSS breakpoints and the existing card/preview controls are retained.
- Time presentation, category, tags, and age/session labels are computed from
  the full authorized server snapshot before descriptions and venue-hours JSON
  are removed from client props. Unknown times remain in their own time band.
  Structured data retains its original server projection.
- `/api/calendar/overview` independently loads month counters and the disjoint
  portion of the mobile week. The day page does not wait for this request.
  Initial unknown counts use placeholders; selected-day counts remain based on
  the same detailed snapshot as the visible list.
- The browser shares pending overview requests and caches at most six scopes
  for 60 seconds. The scope includes month, week, search, and venue; clicking a
  different day or category does not initiate another month request. Visible
  pages refresh counters periodically, recover after errors, and ignore results
  for a previous scope. Month totals exclude the extra week's dates.
- Existing ID/name venue filters do not wait for month counters. Old unprefixed
  alias URLs exceptionally retain the previous month-wide ambiguity resolution;
  navigation then uses the resolved filter. This prevents cross-day alias and
  duplicate-name regressions while keeping ordinary day navigation independent.
- Weekly dates, date arrows and filter-clearing links explicitly retain client
  navigation. The prior composite production source lacked the weekly marker,
  allowing the global same-path handler to force full document reloads.

## Verification

`qa:calendar-navigation-performance` executes the shipped server page and both
responsive agenda modes using isolated public fixtures. It verifies one row per
event, complete metadata/age/time projection, desktop grouping, mobile ordering,
selected-day counter authority, filter/month bounds, request coalescing, cache
expiry, and retry after failure. Existing time-band, date-strip, category,
preview, search, Open now, and mobile QA remain in the release gate, with source
checks following the extracted components.

Before promotion, run `npm run qa:release` and `git diff --check`, then verify
the Linux production build in a private preview with real public data. Compare
event IDs and row counts against the previous active release. Test date changes,
filters, Back, viewport changes, and inline previews, including a counter request
that is still pending or fails. Repeat public HTTP and browser timings after
promotion; do not claim a causal percentage from variable shared-host latency.

This is a web-only release. Preserve the composite live Convex deployment,
independent social router, backend/scheduler containers, authentication and
analytics owner settings. Overlay only this release's explicit file manifest
onto the active web source. Include `app/page.tsx` so production also receives
the existing root Suspense wrapper. Keep previous static assets and the prior
web router for rollback.

## Production release evidence

Promoted the web-only release `calendar-day-speed-502f7a6` on 2026-10-31.
Functional source commit: `502f7a6e9b505564329202cbc5d15bb58c072049`.
Linux production build ID: `VXuU9qRkozTzuZX38-Uld`. The production container
`ig-event-web-calendar-day-speed-502f7a6` is healthy, listens privately on port
3191, and has main-router priority 1039. The public domain's script asset set
matches the private production listener. All 28 scoped source hashes match the
release manifest, and all 14 local script assets return 200.

The full local `npm run qa:release`, Linux build/type/lint and focused calendar
checks passed. Private old/new comparisons preserved every event ID and
category across October 29, 30 and 31. On October 31, 140 events now render 140
rows, compared with 280 in the previous release. Compressed public HTML fell
from approximately 415 KB to 96 KB (77% less), and the full-route RSC response
from 321 KB to 44 KB (86% less). RSC figures describe complete route responses,
not the exact differential payload for each browser interaction.

Three sequential public HTML requests per day after promotion had median total
response times of 549 ms (October 31), 530 ms (October 30), and 520 ms (October
29). These are HTTP response timings on an unthrottled connection, not browser
paint metrics. Shared-host load and cache state differ from the earlier audit;
do not interpret the latency differences as a controlled causal percentage.

Four completed repeated browser transitions measured 455 and 506 ms on desktop,
and 589 and 415 ms at 390x844, including the October/November boundary. These
measure UI click through committed URL/visible content and include automation
overhead; they are not INP or field CWV. Two earlier first route transitions
were still pending beyond 6.3 and 8.4 seconds before completing. Those checks
did not capture an exact completion timestamp. Cold first-load outliers remain
an unresolved limitation; the 0.4-0.6 second range applies to the repeated
transitions only.

Live browser checks confirmed independent counter placeholders/fill, matching
selected-day counts, one responsive event tree, category filtering and reset,
month-boundary navigation, and an inline preview with its original image and
close control. The production Clerk sign-in page and health endpoint remain
available. Anonymous analytics page/API requests still return 404, invalid
overview dates return 400, and overview responses contain compact public count
groups and venues without event evidence fields.

All six protected pre-existing web/backend/dashboard/social/proxy/scheduler
containers retained their IDs, start times, and configurations. Production
environment values are unchanged. No Convex functions, schema, ingestion or
moderation were deployed. The previous web router remains running at priority
1038. For rollback, stop only this new release's Compose project; the retained
router then takes over. Do not stop shared services or the separate social
router.

Server evidence, manifest and build/smoke results are stored privately under
`/root/ig_event-release-artifacts/calendar-day-speed-502f7a6/`. Local HTTP
measurements and browser evidence are under the ignored directory
`.seo-cache/performance/2026-10-31/after-502f7a6/`.
