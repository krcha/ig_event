# Calendar and map performance release

This change follows the public slider fix at `85a1342`. It preserves the live
five-category taxonomy, green Open now control and 06:00 map nightlife boundary.

## Request behavior

- Calendar event details cover only the selected date. Initial selection uses
  today's existing nightlife date. Clicking another date loads that date.
- Month counts, search and venue choices use `publicCalendarOverview:listWindow`.
  Its response contains counts and venue labels, not other dates' event bodies.
- The map loads selected-day details and compact week counts. It no longer loads
  the complete public venue directory. Coordinates still require current public
  canonical venue bindings; reviewed data only attach matching addresses.
- Open now retains the civil yesterday/today detail window needed for overnight
  sessions, including before the map display date rolls at 06:00.
- Pending overview requests coalesce. Successful entries expire after 60 seconds;
  failures are evicted. Selected-day counters use the same detail snapshot as
  the displayed cards. This preserves the existing freshness ceiling.
- Unused root Convex React context is removed. The application has no consumers
  of its hooks; server HTTP queries and authenticated library APIs remain.

## Backend deployment boundary

The active backend is assembled from multiple prior releases. A full Convex push
from this checkout would overwrite unrelated installed functions. Do not do it.

Deploy the standalone `convex/publicCalendarOverview.ts` module as a bounded
addition over the exact installed configuration. Preserve every existing module
hash, schema, auth config, app definition and dependency configuration. Abort on
concurrent drift. The new query delegates publication, lifecycle and cursor
authority to the existing public queries; it performs no database writes.

Publish and smoke-test the additive query before deploying the web changes.
Build the web release from the active server source plus an explicit file
allowlist, retaining its runtime configuration and prior static assets. Verify
the production build in a private preview before changing the main router.
Keep the previous web release for rollback. Preserve the independent social
router, ingestion services, cron configuration and Convex container.

## Verification

Run `npm run qa:release` (including production build) and `git diff --check`.
Focused QA covers date bounds, opaque cursor progression, publication authority,
five-category counts, venue/search compatibility, cache expiry/coalescing and
overnight map boundaries. Browser verification must exercise actual production
data on mobile and desktop, then repeat on the public origin after promotion.

Compare public API response bytes and event/count identity under identical date
and filter arguments. Report HTTP timing separately from frozen DTO projections.
Browser load comparisons require identical viewport, throttling, observation
window and first/repeat visit definitions. Shared-host load can invalidate a
causal speed claim; never infer a percentage from a noisy timing pair.
