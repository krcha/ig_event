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
