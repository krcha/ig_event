# Calendar first-load performance

This follow-up targets the first-route outliers remaining after the
`502f7a6` release. It is a web-only change over the same public Convex APIs.

## Evidence and scope

A temporary opt-in timing proxy on the production domain recorded browser
resource timing and upstream first/last-byte timing. Its diagnostic cookie and
router are limited to the test session and must be removed after verification.
It records public route/date timings, not authentication tokens or user data.

- An isolated first public-TLS query took 922 ms versus 20 ms on the private
  Docker network. Warm samples varied (23-74 ms and 7-74 ms respectively).
- A new-process day loader took 1220 ms with public transport versus 600 ms
  with private transport. These are sequential observations, not a controlled
  latency percentage. Both returned the same 140 public events.
- A traced month-counter request waited 10937 ms upstream. It is independent
  of day rendering but competes for backend work. An isolated day/month/week
  read involved 18 calls; ordinary selected-day reads involved only 2-5.
- Traced first day transitions included 2457 and 3726 ms. The earlier >8 s
  outliers were not reproduced in every run. No single recorded trace proves
  one cause accounts for every outlier.
- The root Suspense boundary had no content key. React transitions retained
  the old day until the new payload completed, preventing useful loading
  feedback. The complete list was also laid out/painted eagerly.

## Changes

- `CONVEX_PUBLIC_READ_URL` optionally routes server calendar reads over the
  private network to the exact same backend. Hosted deployments fall back to
  `NEXT_PUBLIC_CONVEX_URL`; browser/auth URLs are unchanged. The helper is
  server-only, and day cache keys include the backend origin.
- Independent venue-ID batches run at concurrency two, retain original merge
  order, and stop scheduling after errors. Public visibility, normalization,
  date cursor order, and the existing 60-second freshness bound are unchanged.
- The root loading boundary is keyed by date and filters, allowing the new
  day's skeleton to stream before its data. The skeleton is not counted as
  completed event content in performance measurements.
- Browser-native `content-visibility` defers off-screen event/guide layout and
  paint. All event markup, IDs, categories, counts and structured data remain
  present. Expanded posts opt out to preserve media sizing and scroll anchoring.
- The mobile month picker is a separate lazy module, mounted only on opening.
  Native dialog focus trapping, Escape, backdrop close, body scroll locking,
  future-date bounds and trigger focus restoration remain intact. Instagram
  preview code and images retain their existing on-demand loading.

## Foreground scheduling follow-up

Initial public verification of `1a900e1` caught a 4624 ms first desktop transition
overlapping a 9830 ms counter refresh. Other first production transitions were
1666, 3031 and 1285 ms. This confirmed remaining contention despite separate
HTTP requests and motivated a stricter background budget before final handoff.

All counter month/week/filter scopes now share one backend RPC slot per web
process. At most 64 reads may wait; overflow uses the existing recoverable
counter-unavailable response. Foreground day queries do not use that queue.
Cursor chains, exact aggregation and the 60-second successful-cache lifetime
are preserved. Counter throughput is intentionally lower so an unused month
overview cannot fill several backend execution slots. Periodic refresh skips
active navigation/loading states, and category-only toggles retain their
existing optimistic content boundary.

## Lazy server routes and calendar readiness

A CPU profile of a fresh Next process exposed another cold-start cost:
`unstable_preloadEntries` eagerly requires every route's webpack modules,
including unvisited admin/ingestion/API dependencies. The installed Next
15.5.20 defaults `experimental.preloadEntriesOnStart` to true. Module loading,
VM initialization and garbage collection competed with the first calendar
response. An instrumented same-build test observed 16.9 s for its first HTML
response with eager loading, versus 4.3 s with the runtime flag disabled.
These profiler runs are diagnostic observations, not public latency promises.

Disable that eager initialization so unvisited routes load on demand. Readiness
warms only `/` once per container boot and consumes the complete streamed body
before marking the new web healthy. The boot identity comes from PID 1's start
time, so a restarted container warms again even if its temporary state survives.
Subsequent health checks only check `/api/health`; they do not periodically load
calendar data. Existing health intervals are retained, with a 20 s timeout for
the initial warm-up. The public calendar's 60 s data TTL remains unchanged.
Admin authentication, background jobs and API behavior are unchanged; their
modules initialize when those routes are actually used.

## Work under concurrent public traffic

The first `41bef81` production browser series still caught a 10315 ms transition
to October 31. A subsequent opt-in server trace separated backend time from
rendering: one 4814 ms server response spent about 2500 ms on three sequential
event pages, then about 715 ms on parallel venue reads. Another trace of the
same day finished in 1867 ms. These are variable shared-server observations.

A separate 12-second sample of actual production requests observed 35 calendar
HTML requests for dates spread across 2021-2034, alongside ordinary routes. A
second sample used several browser-like user agents without browser fetch
metadata; a third sample came from multiple source addresses. This is consistent
with automated traffic, but the samples do not establish its owner or purpose.
It competes with foreground navigation even when month counters are serialized.

A 15.5-second CPU profile of that workload included 724 ms of self time in the
page's date formatter, plus locale comparison and GC work. Reuse the three fixed
date formats and the numeric, case-insensitive collators across requests rather
than initializing ICU data for every month cell and comparison. Preserve the
existing locale, formatting options, sorting order and 60-second data freshness.
No source-address bans, date restrictions or backend policy changes are applied.

## Cache eviction under distant-date traffic

A follow-up 15-second sample of the live calendar cache observed over 80 cache
writes. All 48 retained entries at its end referred to distant dates in
2018-2031; the current week had been evicted before its normal TTL. This explains
why revisiting a day could repeat backend reads even within 60 seconds.

Eviction now prefers ordinary entries before recent/upcoming one- and two-day
windows around the current UTC date. This covers both sides of the local night
and the mobile week, without changing valid dates or any query result. The
global 48-entry bound, successful-result 60-second TTL, origin separation,
in-flight coalescing and error retry behavior remain intact. Priority is an
eviction preference only; expired priority entries are removed normally.

The navigation QA executes the actual day loader, fills its cache with 80
distant dates, and checks that fresh and pending near-term reads survive without
extra backend calls. It also verifies eviction of old ordinary dates, expiry,
error recovery and a hard bound even when every fixture claims priority.

## Verification and rollout

The navigation QA executes the root boundary with two dates, verifies that
selected params reach the deferred page, tests real bounded batch overlap and
deterministic ordering/failure, and verifies optional/private transport fallback.
Existing responsive row, category/time/session projection, month scope/cache,
preview, public search, Open now, auth and analytics checks remain required.

Run `npm run qa:release` and `git diff --check`. Build Linux from an explicit
source manifest over the active composite web source, preserving unrelated
runtime code. Before promotion, compare event IDs/categories, test cold first
HTML/RSC requests and real mobile/desktop navigation, inspect lazy module
loading and off-screen paint, then repeat on the public domain.

Preserve shared Convex, scheduler, proxy and social containers and all existing
credentials/owner settings. Only add the server transport environment variable;
do not deploy Convex functions or change the browser backend URL. Retain the
previous web container/router for rollback.

## Final production verification

Functional release `eb425d1`, validation-only follow-up `2cbefbe`, Linux build
`R_NqT9PUfFbF4Kr2m0jwF`, is live on `eventzeka.com`. The public health response
confirms `X-EventZeka-Release: eb425d1`. Local `npm run qa:release`, Linux lint,
typecheck, build, focused QA and `git diff --check` passed. Eight old/new page
comparisons preserve event IDs, categories, ordering and one row per event.
Fourteen referenced assets return 200; sign-in returns 200; anonymous analytics
page/API access stays 404; invalid overview ranges return 400.

Final browser results count the complete stable list, including hydration:

| Measurement | Time |
| --- | ---: |
| First desktop document, 140 events | 1322 ms |
| Fresh mobile document, 140 events | 1232 ms |
| Desktop day transitions, four samples | 420-2386 ms |
| Mobile day transitions, two samples | 3319-3650 ms |
| Day transition during forced counter work | 420 ms |
| Concurrent forced counter request | 19608 ms |

The first document uses a temporary opt-in first-party timing proxy. Subsequent
day transitions use the normal compressed production route. Browser assets may
already be cached, and no CPU/network throttle is applied. These are observed
navigation timings, not a cold-browser guarantee or field Core Web Vitals.
The lazy month picker remains absent before opening, loads its separate module
on demand, traps focus, closes on Escape and restores focus to its trigger.

Sequential public HTTP tests cover nine HTML responses and six full-route RSC
responses. HTML completes in 516-2723 ms, with medians of 943/840/755 ms for
October 31/30/29. RSC completes in 281-1606 ms. A private candidate's first
October 31 response had still reached 7895 ms before final idle-container
cleanup; its second response was 764 ms. Shared-server contention remains a
source of variability, so this small series does not establish a global SLO.

A 15-second production cache sample retains all three visited near-term dates
while processing 20 ordinary cache misses, with five priority cache hits and
48 total entries. This confirms the eviction change under real traffic.

After promotion, two idle web-only candidates from this follow-up (`1a900e1`
and `41bef81`) were stopped after verifying identical runtime credentials/image,
read-only mounts and no established web connections. Their source and compose
files remain available. The immediately previous `6f1ce20` web remains healthy
for rollback. Eight other protected containers, including Convex, scheduler,
social web and proxy, retain their IDs, start times and configuration.
No Convex deployment was performed. Diagnostic routers, proxy, inspector and
browser flags/tabs were removed after verification.

Detailed measurements and the clean mobile screenshot are in the ignored local
artifact directory `.seo-cache/performance/2026-10-31/cold-load/`, indexed by
`SUMMARY.json`. Lighthouse and field LCP/INP/CLS were not measured in this run.
