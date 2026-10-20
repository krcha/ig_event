# Event Zeka performance audit history - 2026-10-20

Status update: the date-strip fix is deployed and verified on eventzeka.com
(build `JDyq4K6y63yk6TwoPpyil`, commit `85a1342`). Selected-day/map data changes
are undergoing a separate release. Earlier local-only statements below describe
the original audit snapshot; the public-release follow-up supersedes them.
Baseline Git revision: `b282315b73f6df1c70b3d17c62e07d4d98714745`.

Confirmed improvements are the smaller initial JS union and fewer time-resolver
calls / lower isolated derivation CPU. A uniform page-load or interaction speedup
has NOT been established. Severe shared-host contention invalidates causal
interpretation of the sequential browser timing differences.

## Architecture and measurement conditions

- Next.js 15.5.20 App Router, React 19.2.7, TypeScript, Tailwind CSS 4.
- Convex server HTTP queries, indexed public projections, and a bounded 60-second
  process cache with pending-request coalescing. Clerk authentication and the
  existing HTTP user-library APIs remain in place. OpenAI and Apify ingestion
  are outside the public request path and were preserved.
- Docker / Node 22 deployment behind Traefik; an optional self-hosted Convex
  Compose overlay is present. Live HTTP responses use HTTP/2 and gzip.
- Local tests use `next build` followed by `next start`, Apple M2 / 16 GB,
  Node 22.20.0, Chromium headless, anonymous browsing, real public Convex reads.
  No Clerk keys/session or administrative credentials were available locally.
- Desktop: 1440x900, CPU rate 1, 20 ms emulated network latency, 10 Mbit/s down.
  Mobile: 390x844, CPU rate 4, 150 ms latency, 1.6 Mbit/s down. DPR is 1 for both;
  this is a repeatable laboratory profile, not a physical phone test.
- Six routes, three repetitions per device, empty browser context followed by
  a repeat document visit in that same context: 72 navigations per build.
  Server caches are shared and are not flushed between every browser visit.
  Therefore "first" means first browser visit, not a guaranteed cold backend.
- LCP/FCP, TTFB, layout shifts, long tasks, request types/bytes, image dimensions,
  and browser errors come from browser Performance APIs / Chrome DevTools.
  The observation window is 1.8 seconds after `load`. Lazy images and map tiles
  can remain in flight; byte totals describe this window, not all future scrolls.
  Scripted click-to-result timings are separate from field INP.
  [Google's INP guide](https://web.dev/articles/inp) explains the distinction
  between interaction latency and an end-to-end application result.
- During the original-build control, the measured host load averages reached
  316.33 / 129.89 / 70.14 (1/5/15 minutes). Even tiny commands took seconds to
  start. Browser profiles and software were matched, but actual host conditions
  were not controlled. Additional timing runs were stopped after the current
  exploratory pair; reliable end-to-end comparison needs an idle/isolated runner.
- Live-origin samples include Clerk and real TLS/network delivery; they are
  corroboration only and must not be compared directly with local build deltas.
  No real-user CrUX/INP, production engine CPU, DB-read metrics, or server traces
  were available. No Lighthouse score is used as a substitute for those data.

## Prioritized findings

### 1. P1 - Full-month query waterfall delays the calendar

**Where:** `app/(main)/events-browse-page.tsx`,
`lib/events/public-events.ts:loadAllPublicCalendarEventsWindow`,
`convex/eventDomain/publicReads.ts:listPublicCalendarEventsWindowPaginatedHandler`.

**Evidence:** A read-only October request returned 478 events across ten
sequential cursor pages: 323,144 serialized JSON bytes and 1,985 ms for that
sampled chain. Enrichment then requested 158 venues in two sequential batches:
222,889 bytes and 962 ms. The combined sample was about 2,947 ms / 546,033 bytes
before Next normalization/rendering. A seven-day sample used seven requests for
329 events. These are client-observed HTTP timings including network/backend
caches, not database engine execution times or compressed browser payloads.

**Cause:** Every selected-day/filter render first obtains the complete month so
counts, search and filtering can be computed on the server. The 60-second cache
helps subsequent visits but does not eliminate the cold dependency chain.

**Concrete proposal:** Add a publication-safe compact month summary for day/type
counts and filter options, and retrieve selected-day cards separately. Preserve
the current indexed visibility projection, full-month search/count semantics,
overnight boundaries, and cursor limits. Search must apply to both summary and
day results. Use request coalescing and the existing freshness ceiling; do not
introduce another independent route cache without invalidation design.

**Impact / complexity / risk:** High potential cold-load/navigation impact;
medium-high complexity and medium risk. This is a design proposal, not an
implemented speed claim. Merely increasing compatibility page size or skipping
publication proofs is unsafe.

**Verification:** Compare cold-server and warm-server SSR separately, with the
same frozen month and query filters; compare all IDs/counts, requests, bytes,
TTFB and actual-content LCP. Confirm publication/hide/ingestion updates appear
within the existing freshness contract.

### 2. P1 - Full-size posters dominate some mobile downloads

**Where:** `components/discover/discover-feed.tsx`,
`app/(main)/events/[eventId]/page.tsx`,
`app/(main)/venues/[venueId]/page.tsx`,
`app/api/discover/images/[eventId]/route.ts`.

**Evidence:** These Image components set `unoptimized`; `sizes` therefore does
not generate resized variants. One mobile Discover poster transferred 3,123,076
bytes at 2160 pixels wide while displayed at 364 pixels. The sampled event
detail used a 1440-pixel image at 297 desktop / 326 mobile pixels; venue posters
were 1080-1440 pixels at 121 mobile pixels. The first-party image route checks
publication/source identity and then fetches the original raster unchanged.
Some posters are lazy and outside the initial viewport, so different observation
windows have materially different image totals.

**Concrete proposal:** Keep the protected first-party source path, add a small
bounded set of responsive WebP/raster widths, and generate proper `srcset` values.
Evaluate the existing Next image optimizer against a bounded variant proxy;
verify SVG placeholders, stale/denied sources, animation and cache behavior
before choosing. Include source revision in cache identity when source changes;
do not extend effective stale lifetime beyond the existing policy. Preserve
the streamed byte limit, allowlisted hosts and ambiguity/publication checks.

**Impact / complexity / risk:** High potential bandwidth and poster-LCP impact;
medium complexity/risk because of image fallbacks, VPS CPU and cache freshness.
No resize/quality/cache behavior was changed in this pass.

**Verification:** Freeze representative posters (including the 3.1 MB one),
compare cold and cached image TTFB/bytes at DPR 1/2/3, inspect small poster text
visually, test missing/invalid/animated sources, and load-test transformation
concurrency and cache hit rate. Do not promise a page-speed percentage from a
single compressed-image experiment.

### 3. P2 - Directory reads transfer opening-hours data unused by cards

**Where:** `lib/venues/public-venue-pages.ts:loadPublicVenueDirectory`,
`convex/venues.ts:listPublicVenueFields`, `app/(main)/venues/directory/page.tsx`.

**Evidence:** The public endpoint returned 678 venues / 704,565 JSON bytes;
three repeated HTTP samples were 306, 269 and 276 ms. `hoursJson` on 295 venues
accounted for 476,483 bytes when serialized as a field array. An offline compact
directory projection of those records was 162,537 bytes; that is a proposed DTO
size, not measured implementation savings. Browser card serialization is already
bounded to 12 venues; the excess is primarily Convex-to-Next traffic/work.

**Concrete proposal:** Add a directory-specific field projection containing
search/card/location/follower fields. Keep hours on the separate map/open-now
and detail paths. Preserve lifecycle/publication checks and result ordering.
Consider backend pagination/search only after defining exact filter/count
semantics. Do not blindly remove fields from a shared endpoint.

**Impact / complexity / risk:** Medium-high server-transfer/parse impact;
low-medium complexity and low risk with projection-contract coverage.

**Verification:** Compare same-record serialized and wire bytes, directory
TTFB, exact search/category results, stable pagination and map open-now behavior.

### 4. P2 - Query links deliberately reload the document

**Where:** `components/navigation/navigation-feedback.tsx:shouldUseDocumentNavigation`,
`components/navigation/app-toolbar.tsx`, calendar/map links.

**Evidence:** The capture-phase click handler calls `window.location.assign`
for same-path query changes. This bypasses the date strip's router handler and
restarts document parsing/hydration. Primary toolbar tabs are native anchors.
This is an intentional workaround, explicitly asserted by `qa-app-toolbar`,
for earlier App Router stalls; it is not accidental leftover code.

**Concrete proposal:** After reducing server/RSC work, trial soft navigation on
the selected-day path with `useTransition`, existing scroll/focus restoration,
explicit pending feedback and a recoverable document fallback. Keep dense-list
prefetch bounded; do not turn it on globally. Retain existing behavior until
measured navigation/result consistency justifies replacing the workaround.

**Impact / complexity / risk:** Potentially high perceived navigation benefit;
medium complexity/risk because of the known regression history. Unchanged here.

**Verification:** Compare same date/day/filter sequence under both network
profiles; count document/RSC requests and measure click-to-visible-result,
keyboard focus, back/forward, scroll restoration and rapid successive input.

### 5. P2 - Unused Convex browser provider adds shared JavaScript (fixed)

**Where:** `app/layout.tsx`; existing unused definition remains in
`components/providers/convex-client-provider.tsx`.

**Evidence / cause:** Root mounted `convex/react` and `convex/react-clerk` on
every page, but no application component consumes their query/mutation/action
hooks. Public reads and user-library operations use server HTTP/API paths.
Constructor initialization is lazy; anonymous WebSocket savings were not
observed and are not claimed.

**Change:** Removed only the unused root wrapper/import. Convex package,
server APIs, data model, ClerkProvider, AuthUserProvider and UserLibraryProvider
remain. No new shared state or browser/data cache was introduced.

**Impact / complexity / risk:** Lower shared download/parse work on first visits;
low complexity/risk. Production manifest and browser deltas are recorded below.
Authenticated browser verification still needs a real Clerk session; deterministic
user/admin authentication gates cover mocked success/failure paths only.

**Verification:** Compare union of route/layout production chunks and actual
first-visit JS bytes; check public navigation, auth redirects and user API tests.
Before rollout, smoke-test signed-in save/favorite/admin flows with real credentials.

### 6. P2 - Repeated calendar time derivation wastes server CPU (fixed)

**Where:** `app/(main)/events-browse-page.tsx` time/ARIA helpers and
`lib/venues/venue-open-now.ts:resolveVenueClosingMinutes`.

**Evidence / cause:** The active agenda resolves the same presentation repeatedly
for time parts and accessible labels. The alternate desktop renderer is currently
unused and must not be counted as active work. Missing hours still triggered
unnecessary Intl timezone conversion work.

**Changes:** Reuse presentation in a Map scoped to one request; return before
timezone conversion when there are no opening intervals. No cross-request
memoization or freshness change. Existing overnight/DST behavior remains.

**Measured isolated CPU:** The corrected benchmark models the active agenda for
37 real selected-day events from a frozen 478-event October fixture, excluding
the unused desktop renderer. This is pure derivation work, not a full server
render or page-load measurement. The exact counts and paired medians are recorded
in the final verification section. All 478 full output objects match: SHA256
`58c001eb39b3ea46945909b6234f193c8a5f579cb49de6f709fc5404515e8acc`.

**Impact / complexity / risk:** Modest repeat-render CPU benefit; low complexity
and low risk. Browser/TTFB effects are subject to the other request costs.

**Verification:** Frozen-output comparison plus venue-hours/open-now/DST,
calendar-time-band, mobile-calendar and event-map regression gates, then same
production route/filter measurements before and after.

### 7. P2 - Intermittent hydration recovery remains unresolved

**Where:** Baseline desktop event-detail repeat and changed-build desktop home
setup in the exploratory control. Exact responsible component is unknown.

**Evidence / cause:** React #418 occurred once in the original load phase and
once in the changed-build control. The [React error reference](https://react.dev/errors/418)
identifies a server/client markup mismatch that causes client-side tree recovery.
The triggering mismatch was not captured with a component stack, so its root
cause and contribution to latency remain unverified. All scripted semantic
steps still passed; this is not a clean JavaScript-error signoff.

**Concrete proposal:** Capture the component mismatch in a development diagnostic
run of the same route/data and repeat it with controlled CPU/network and both
auth states. Compare server HTML, initial client props and any pre-hydration DOM
updates. Fix the identified mismatch; do not mask it with hydration-warning
suppression or attribute its absence in one run to the performance changes.

**Impact / complexity / risk:** Avoiding recovery may remove extra rendering
work; magnitude unknown. Diagnostic work is low risk; fix complexity/risk depend
on the responsible component.

**Verification:** Repeat cold/repeat loads, detail/back navigation and category
changes on both devices; record recoverable errors with component stacks and
compare main-content LCP and interaction timing on an idle runner.

### 8. P3 - Additional authenticated and long-feed work needs targeted profiling

- `app/(main)/saved/page.tsx:96`: signed-in users load all next-90-day events even
  with no favorite venues. Propose targeted/lazy recommendation queries while
  retaining visibility checks. Medium complexity/risk; compare empty/large real
  libraries and backend request counts. Not browser-measured without credentials.
- `components/discover/discover-feed.tsx:DiscoverPost`: loading/cursor/error state
  changes can rerender all existing posts with stable event references. A `memo`
  boundary may help; use a React profile before changing. `ReadMoreText` also
  synchronously measures caption heights. Forced-layout impact is a hypothesis,
  not a trace-confirmed bottleneck. Low-medium complexity; verify long-feed input
  latency, append behavior and layout work, not render counts alone.
- Independent venue-ID enrichment batches are serial. Bounded concurrency of
  two is a possible small improvement; current query-pressure safeguards
  intentionally forbid parallel ID enrichment with a full active-directory read.
  Preserve sequential dependent cursor pages and check backend pressure first.
- The initial calendar document was about 430 KB decoded for the 37-event day,
  including its agenda, date selectors, filters and RSC representation. Reducing the serialized tree
  is a possible further improvement; no trace isolated its CPU contribution.
  A shared responsive representation is a medium-complexity refactor with
  visual/accessibility risk. Compare HTML/RSC bytes, parse/hydration work and
  visual parity before changing it.

## Delivery, caching and assets already working

- Live HTML, JS and CSS are gzip compressed. Hashed JS/CSS use
  `public, max-age=31536000, immutable`. No evidence supports replacing the proxy/CDN.
- The single shared CSS file was 104,080 raw / 17,004 gzip bytes. It blocks paint,
  but there is no large render-blocking web-font chain: the UI uses system fonts.
  The 2 MB social-image font is server-side, not a page font download.
- Leaflet is dynamically imported. Maps still have third-party tile/network and
  rendering costs; their streaming-shell TTFB is not main-content readiness.
- No custom analytics/video/iframe load chain was found. Clerk is the material
  external bootstrap: one live sample was 90,553 compressed bytes after a redirect.
  Local no-key measurements omit this cost.
- Calendar/map HTML stays dynamic deliberately. The process event cache is
  bounded to 48 entries, coalesces pending loads, expires 60 seconds after settle,
  and removes failed promises. Detail routes already use React request memoization
  and short revalidation. No duplicate metadata/detail read defect was established.
- Public data queries use status/date or publication-state/date indexes and
  bounded pagination. No general missing-index/unbounded-collect defect was found.

The live-origin corroboration used one sample per device/visit, not a percentile:

| Live route | Desktop first/repeat LCP | Mobile first/repeat LCP |
| --- | ---: | ---: |
| `/` | 512 / 252 ms | 6,776 / 560 ms |
| `/map` | 3,396 / 632 ms | 1,580 / 2,024 ms |
| `/discover` | 2,368 / 744 ms | 5,464 / 544 ms |

The slow live mobile home sample had 5,291 ms TTFB. It demonstrates that a
multi-second request occurs, not how often it occurs. The map repeat sample was
slower than the first sample, illustrating third-party/content-timing variability.
These values are not local before/after results and no deployed gain is claimed.

## Measured build and browser comparison

Both builds used the same lockfile, public Convex origin and no local Clerk
configuration. Values below are measurements, not projected percentages.

| Initial JS union | Before raw | After raw | Before gzip | After gzip | JS files before/after |
| --- | ---: | ---: | ---: | ---: | ---: |
| Shared layout | 615,118 B | 547,763 B | 182,518 B | 163,412 B | 11 / 10 |
| Home + layout | 650,334 B | 582,979 B | 194,569 B | 175,463 B | 13 / 12 |
| Map + layout | 664,968 B | 597,489 B | 199,207 B | 180,053 B | 13 / 12 |

These are deduplicated production manifest unions with reproducible local gzip
compression, excluding external Clerk and async Leaflet. They are not JS parse
timings. Shared layout saves 67,355 raw / 19,106 gzip bytes and one JS resource.
Full-page results and the corrected active-agenda CPU benchmark are assessed
separately below.

Raw evidence is kept under `.seo-cache/performance/` (ignored by Git). The public
summary is `SUMMARY.json`; the two phase JSON files retain all 72 navigation
samples each rather than only favorable runs.

## Reproduction

```sh
npm ci
NEXT_PUBLIC_CONVEX_URL=https://convex-events.ineedtofeedmyrabbit.com npm run qa:release
NEXT_PUBLIC_CONVEX_URL=https://convex-events.ineedtofeedmyrabbit.com npm run start -- --port 3100
# In another terminal, with a separately installed Playwright measurement runtime:
node scripts/measure-public-bundles.mjs .seo-cache/performance/bundles.json
node scripts/measure-public-performance.mjs --playwright=/absolute/path/to/playwright/index.mjs --runs=3 --output=.seo-cache/performance/browser.json
node scripts/check-public-interactions.mjs --playwright=/absolute/path/to/playwright/index.mjs --runs=3 --output=.seo-cache/performance/interactions.json
git diff --check
```

Use the same Chromium binary for both phases (`--executable=/absolute/path` when
needed), same date/routes/data, hardware and profiles. Include the representative
event and venue paths using `--routes=` as recorded in the raw JSON. Do not run
the build, Lighthouse or another browser measurement simultaneously. Repeat
against the deployed site with Clerk enabled before claiming production gains.

<!-- BEGIN GENERATED MEASUREMENTS -->

### Production-build load samples

Medians of three observations; all times are milliseconds, bytes are observed wire KiB. A/B columns show before -> after. Both first and repeat refer to browser visits.

| Device | Page | Visit | TTFB | FCP | LCP | Wire KiB |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| desktop | Home | first | 61 -> 51 | 352 -> 308 | 352 -> 308 | 321.0 -> 300.9 |
| desktop | Home | repeat | 69 -> 51 | 164 -> 136 | 164 -> 136 | 94.4 -> 94.2 |
| desktop | Discover | first | 12 -> 11 | 164 -> 156 | 1352 -> 1284 | 664.5 -> 644.4 |
| desktop | Discover | repeat | 13 -> 14 | 72 -> 76 | 380 -> 388 | 24.3 -> 24.2 |
| desktop | Map | first | 10 -> 6 | 172 -> 168 | 1348 -> 1132 | 907.7 -> 887.7 |
| desktop | Map | repeat | 8 -> 9 | 88 -> 84 | 720 -> 608 | 51.8 -> 51.7 |
| desktop | Directory | first | 337 -> 336 | 564 -> 560 | 564 -> 560 | 254.9 -> 234.9 |
| desktop | Directory | repeat | 368 -> 326 | 440 -> 400 | 440 -> 400 | 34.4 -> 34.3 |
| desktop | Event detail | first | 147 -> 156 | 352 -> 316 | 664 -> 496 | 310.1 -> 290.1 |
| desktop | Event detail | repeat | 125 -> 101 | 196 -> 168 | 196 -> 172 | 24.1 -> 24.0 |
| desktop | Venue detail | first | 81 -> 99 | 224 -> 236 | 548 -> 640 | 592.1 -> 572.0 |
| desktop | Venue detail | repeat | 74 -> 91 | 132 -> 140 | 132 -> 140 | 18.8 -> 18.7 |
| mobile | Home | first | 55 -> 129 | 1124 -> 1132 | 1124 -> 1132 | 321.0 -> 300.9 |
| mobile | Home | repeat | 53 -> 45 | 252 -> 248 | 252 -> 248 | 94.4 -> 94.2 |
| mobile | Discover | first | 9 -> 12 | 840 -> 836 | 1240 -> 3488 | 259.7 -> 3589.8 |
| mobile | Discover | repeat | 8 -> 99 | 228 -> 440 | 580 -> 1296 | 24.3 -> 27.3 |
| mobile | Map | first | 10 -> 525 | 864 -> 1860 | 3604 -> 2580 | 367.6 -> 312.7 |
| mobile | Map | repeat | 7 -> 50 | 280 -> 336 | 1364 -> 2660 | 106.5 -> 186.5 |
| mobile | Directory | first | 560 -> 670 | 1276 -> 1708 | 1276 -> 1708 | 254.9 -> 234.9 |
| mobile | Directory | repeat | 454 -> 671 | 512 -> 892 | 564 -> 892 | 34.4 -> 34.3 |
| mobile | Event detail | first | 149 -> 110 | 848 -> 1080 | 848 -> 1080 | 310.1 -> 290.1 |
| mobile | Event detail | repeat | 108 -> 146 | 212 -> 292 | 272 -> 348 | 24.1 -> 24.0 |
| mobile | Venue detail | first | 72 -> 319 | 872 -> 1108 | 2800 -> 3272 | 592.1 -> 572.0 |
| mobile | Venue detail | repeat | 76 -> 120 | 212 -> 324 | 252 -> 324 | 18.8 -> 18.7 |

The desktop home median LCP improved 352 -> 308 ms for first visits and 164 -> 136 ms for repeats; mobile first LCP was 1,124 -> 1,132 ms. Mobile Discover and several other mobile metrics were worse in the second sequential phase. The cold first home request was 1,739 -> 1,436 ms TTFB (one sample each), which cannot be attributed solely to the code changes.

No outliers were removed. The after phase includes a mobile Map LCP of 35,844 ms (document DOMContentLoaded 35,687 ms despite FCP 1,860 ms) and a Discover repeat LCP of 7,464 ms / TTFB 3,752 ms. Without server traces the source of these stalls is unresolved. The host was shared and background load was observed; image sets and upstream/cache timing also varied. These results do not establish a uniform end-to-end improvement or causal regression.

### Scripted interactions

Medians of three runs, first browser input to visible result plus two animation frames (not INP). Scroll append uses action wall time. Background request counts are retained in JSON and may include prefetch.

| Device | Flow / action | Before ms | After ms |
| --- | --- | ---: | ---: |
| desktop | calendar / next-day | 191 | 465 |
| desktop | calendar / focus-category | 84 | 272 |
| desktop | calendar / search-submit-no-match | 90 | 535 |
| desktop | calendar / sort-venue | 47 | 112 |
| desktop | calendar / open-now-on | 94 | 807 |
| desktop | map / select-day | 447 | 1072 |
| desktop | map / marker-popup-or-lineup | 72 | 202 |
| desktop | directory / next-page | 425 | 1060 |
| desktop | directory / search-venue | 390 | 805 |
| desktop | discover / read-more | 36 | 50 |
| desktop | discover / append-posts | 196 | 707 |
| mobile | calendar / next-day | 779 | 909 |
| mobile | calendar / focus-category | 73 | 210 |
| mobile | calendar / search-submit-no-match | 334 | 435 |
| mobile | calendar / sort-venue | 498 | 599 |
| mobile | calendar / open-now-on | 425 | 1042 |
| mobile | map / select-day | 576 | 1477 |
| mobile | map / marker-popup-or-lineup | 56 | 229 |
| mobile | directory / next-page | 629 | 904 |
| mobile | directory / search-venue | 565 | 992 |
| mobile | discover / read-more | 58 | 250 |
| mobile | discover / append-posts | 671 | 821 |

Sequential after-phase interactions were generally slower, including unchanged handlers. An isolated original-HEAD production build was prepared for an interleaved control. Severe host contention then prevented a reliable causal conclusion; the exploratory control must not be represented as a three-sample or statistically conclusive comparison. Removing JS is not evidence that every interaction became faster.

### Corrected active-agenda CPU experiment

The active 37-event agenda executes 148 -> 37 resolver calls. Eleven alternating warm pairs, 10 simulations per sample, one discarded warmup; the process CPU clock sums user+system CPU via `process.cpuUsage()` to exclude scheduling stalls.

| Pure time derivation | Before | After |
| --- | ---: | ---: |
| Median process CPU per simulation | 22.038 ms | 6.448 ms |
| Min-max process CPU | 20.964-30.190 ms | 5.234-12.247 ms |

This excludes page rendering, React work, I/O and network. Earlier eight-use simulations counted an inactive renderer and are explicitly superseded; they do not support page-impact claims. All 478 presentation objects compare equal.

### Verification record

- `npm run qa:release`: passed before/after; final gate passed all 126 checks, including lint, TypeScript, production build, publication, auth, ingestion, moderation, images and public UI regressions.
- `git diff --check`: passed.
- Both load phases: 72/72 HTTP 200. Baseline had one intermittent React hydration error #418 on the desktop event-detail repeat; after had none. It was not reproduced in either interaction phase and is not claimed fixed. A component stack/reproduction is still needed if it recurs.
- Both interaction phases: 120 passed, six skipped, zero failed, zero page errors. Skips are the absent mobile venue select/clear controls (two steps x three runs), not failed tests.
- Verified day navigation and browser back, local category focus/reset, empty search/clear, sort, desktop venue filter/clear, open-now on/off, event detail/back, map day/keyboard marker, directory pagination/search, Discover expand/append.
- No real authenticated browser save/favorite/admin verification was possible without Clerk credentials/session. No production deployment or database writes were made.

### Exploratory original-build control and final limit

Original HEAD was built successfully in an isolated temporary source copy with
the same lockfile, public Convex URL, no Clerk configuration and the same
Chromium binary. The original server used port 3101; the changed build used
3100. Both control origins used `127.0.0.1`. Initial localhost samples were
explicitly excluded to avoid a differing IPv6 connection fallback.

Only one valid before/after pair was retained. Each side passed 28 available
calendar steps and skipped the two absent mobile venue controls. The changed
sample also recorded one initial-home React #418 hydration error; its cause is
unattributed. The temporary original-build server and test browsers were stopped
afterward; the changed local server remains available on port 3100.

The host reached load averages 329.40 / 205.40 / 108.89 on eight logical CPUs.
Further pairs were stopped because the environment cannot support causal timing
claims. A changed desktop clear-venue step took about 37.6 seconds while other
steps were faster; this is retained rather than discarded. These are raw n=1
observations, not medians, field INP, or proof of either improvement or regression.
Raw controls, environment and build logs are in `.seo-cache/performance/control-*`.

The safe confirmed result is smaller initial JavaScript and less repeated time
derivation with equal outputs. Reliable end-to-end performance acceptance, the
hydration mismatch diagnosis and real Clerk-session smoke checks remain for an
idle/isolated runner with suitable credentials. The larger query/image/navigation
changes above remain concrete proposals, not implemented or deployed promises.
<!-- END GENERATED MEASUREMENTS -->

## Follow-up: date-strip reset, selected-day loading and map (2026-10-20)

This section records the original local follow-up. The public-release follow-up
below supersedes its deployment status. The original implementation was not
present on eventzeka.com when the user reported the unchanged behavior.

1. Date strip reset (confirmed in a real production-build browser). CSS
   `scroll-smooth` animated even programmatic initial `behavior: "auto"`.
   The global capture listener also forced date-query clicks to reload the
   document, bypassing the strip's React handler. Both mobile and desktop
   next-date clicks reloaded one document and swept from zero; reload lost a
   manual horizontal position by 122 px mobile / 132 px desktop. The strip now
   aligns instantly before paint, stores horizontal position per surface/month,
   scrolls only its own container, respects reduced motion, and uses managed
   client navigation. Generic navigation behavior is preserved elsewhere.
   Complexity: small/medium; risk: low, with mocked DOM and browser checks.

2. Calendar detail window (confirmed code and frozen-data transport comparison).
   The home page previously fetched all October details and related venue hours
   before rendering one day. It now loads the selected day, today by default,
   with yesterday retained only for overnight Open now. An additive Convex
   endpoint returns grouped date/category/venue counters and venue choices for
   month navigation. It preserves the existing publication gates, indexed
   bounds, pagination and search/category interpretation. Detailed event bodies
   for other dates do not leave Convex. The overview still reads indexed event
   rows inside Convex; this is not a maintained summary-table migration.
   Complexity: medium; risk: low/medium, requiring backend-first deployment.

3. Map data (confirmed code and frozen-data transport comparison). Full detail
   loading now covers one selected day, or two for overnight Open now. Weekly
   badges use compact counters. The full public venue-directory request is
   removed; current coordinates/hours already come from exact venue IDs in the
   day loader. A reviewed address applies only to the same venue ID and exactly
   matching current coordinates. Selected-date badges use the same detail
   snapshot as the lineup, avoiding disagreement between independent caches.
   Complexity: medium; risk: low, with coordinate/branch safety checks.

The new overview cache has the existing 60-second freshness limit, starts its
TTL after completion, coalesces pending loads, is bounded to 48 keys, and retries
failures. Search, venue and window boundaries participate in the key. There is
no full-month detail fallback. Unbound compatibility calendar rows retain their
authorized source identity instead of inheriting a venue from incidental
neighboring events. Generic feed behavior, persisted records, ingestion and
moderation are unchanged.

### Data comparison under identical frozen inputs

The snapshot was read from the public backend at 2026-10-20T21:10:05Z. The new
overview bytes use the actual pure aggregate projection after the existing
publication boundary. Values are JSON response bodies, excluding HTTP envelopes,
compression and actual cursor lengths; after-path production API latency has
not been measured because that endpoint is not deployed.

| Route / selected 2026-10-20 | Before | After |
| --- | ---: | ---: |
| Home: detailed events | 478 | 37 |
| Home: JSON response bytes | 546,033 | 188,187 |
| Home: modeled query responses | 12 | 12 |
| Map: detailed events | 342 | 37 |
| Map: full-directory venues | 678 | 0 |
| Map: JSON response bytes | 1,139,224 | 157,690 |
| Map: modeled query responses | 10 | 9 |

Reproduce with `scripts/measure-calendar-data.mjs` using the same frozen snapshot
and selected date. The harness captures only already-public data. A cold first
render still needs month/week counters; warm date navigation reuses the bounded
overview cache and fetches details only for a newly selected date.

### Follow-up verification limits

Live-backend baseline: 32 interaction checks passed and two absent mobile venue
controls were skipped. One existing intermittent React #418 occurred on initial
desktop home load. A separate page-load pass timed out after 90 seconds waiting
for desktop `/map` load; only two desktop home visits completed. Those partial
results do not support a complete timing comparison. Host load again exceeded
118 on eight logical CPUs. No page-load milliseconds or percentage speedup is
claimed from these runs.

Controlled browser verification uses saved before/after production builds,
the same frozen public snapshot and unchanged Chromium/profile/throttle scripts.
This isolates slider behavior and user-flow correctness from live data changes;
it is not a measurement of deployed Convex/database performance. Raw follow-up
artifacts are under `.seo-cache/performance/date-followup-*`.

Both controlled builds passed 32 calendar/map action checks, with two expected
mobile venue-select skips and zero page errors. The date-strip comparison found:

| Browser behavior | Before desktop / mobile | After desktop / mobile |
| --- | ---: | ---: |
| Document reloads on next strip date | 1 / 1 | 0 / 0 |
| Target-date RSC requests | 0 / 0 | 1 / 1 |
| Reload position drift | +132 / +122 px | 0 / 0 px |
| Intermediate initial scroll positions | 4 / 28 | 0 / 0 |

Initial alignment can still make one atomic zero-to-selected-position change
during hydration; it no longer animates through intermediate dates. The
horizontal/date actions did not scroll the document vertically. A query-log
sample confirms initial day details for October 20-21 (exclusive end), followed
by October 21-22 only after the click. Overview samples contain only counters and
venue choices, not titles, artists, descriptions, images or hours JSON.

Four additional browser assertions passed: mobile/desktop home have 37 selected
events, badge 37 and month total 478; an explicit November 1 date has zero events,
badge zero and month total zero. The new scroll restoration adds 1,663 raw JS
bytes / 532 estimated gzip bytes to the initial home union compared with the
previous optimization build. It introduces no dependency. Test servers were
stopped after verification; frozen test data is not a live preview.

Deployment order: publish the additive Convex query first, then the Next build.
Existing APIs remain available during rollout. Production access is not
configured in this worktree, and no production mutation or deployment was made.

The current Convex source also compiled and pushed to an isolated anonymous
local backend. Real unauthenticated calls to the new overview endpoint passed
base/search/venue variants on an empty database; three invalid windows were
rejected by the existing 1-45 day guard. No production credentials or records
were copied and no fixtures were seeded. The fresh CLI's generated Convex
TypeScript config initially rejected existing `.ts` imports, aliases and modern
library methods; the temporary clone was aligned with the existing application
compiler settings. That clone-only setup correction is recorded in
`.seo-cache/performance/convex-local-validation/generated-convex-tsconfig.diff`.
The endpoint and helper hashes match the working source. The anonymous backend
and watcher were stopped after verification.

Final follow-up release gate: `npm run qa:release` passed all 126 checks,
including lint, TypeScript and the production build. `git diff --check` passed.

## Public release follow-up: actual slider fix

The unchanged public behavior was reproduced on both mobile and desktop. The
public site was still serving build `oBxN20hwDiyXE1zDL6UjS`, with CSS smooth
initial alignment and document navigation. Existing VPS SSH access was found;
the earlier statement that deployment access was unavailable was incorrect.

The bounded release at commit `85a134210ccdb0c94c44342a2fd84f143d00af2f`
was built on Linux from the actual active server source. It changed only the
date strip, its navigation exception and two QA files. All 126 local release
checks passed, as did server lint/typecheck/production build and diff checks.
The active five-category UI, green map Open now state and 06:00 map date rule
were preserved. Existing backend module/schema/auth fingerprints were guarded.

Real-data preview passed 68 assertions. After promotion, fresh anonymous mobile
390x844 and desktop 1440x900 browsers verified the public origin directly,
without proxying or fixtures: 66 assertions passed, zero JS/console/app errors.
All public documents used build `JDyq4K6y63yk6TwoPpyil`.

| Public browser behavior | Before | After |
| --- | ---: | ---: |
| Next-date document requests, each device | 1 | 0 |
| Next-date RSC requests, each device | 0 | 1 |
| Reset to month start before reaching next date | Yes | No |
| Initial intermediate scroll positions | Present | 0 |

After release, manually scrolled positions survived reload exactly: mobile
957 to 957 px and desktop 560 to 560 px. Back navigation did not move the
document vertically. Selected date, chip count and agenda all agreed (37).
These are functional measurements, not a page-load speed percentage.

Release sources are attached in the managed worktree
`/Users/krcha/.codex/worktrees/public-performance-release/eventzeka-seo`.
Actual browser proofs and guarded server release artifacts are under
`/tmp/eventzeka-public-slider-20261020` locally and
`/root/ig_event-release-artifacts/calendar-strip-85a1342` on the VPS.

## Final data-path candidate: cold-key regression caught before publication

Web commit `30b848b`, build `Ws0CkB8WZdO91oxIb5mj3`, was never promoted.
Although it returned smaller responses, a previously unseen overview-query key
took 17,067 ms on the VPS loopback for seven pages; an immediate repeat took
112 ms. A real-data preview also exposed slow content readiness. The private
preview was abandoned, and the public slider release stayed active.

The nested-query adapter executes the existing heavy query graphs in separate
contexts within the parent transaction. The final loader instead calls the
read-only `publicCalendarOverviewAction:listWindow` action. Its `ctx.runQuery`
calls use the existing public-query cache. This distinction is confirmed in the
actual running backend revision's [action query runner](https://github.com/convex/convex-backend/blob/9c73f185d0f698eaefce0ee82af6f245674bc6d1/crates/application/src/application_function_runner/mod.rs#L1985)
and [nested-query execution](https://github.com/convex/convex-backend/blob/9c73f185d0f698eaefce0ee82af6f245674bc6d1/crates/isolate/src/environment/udf/async_syscall.rs#L624).
Each action query has its own snapshot, as in the existing multi-request public
loader; publication/lifecycle authority remains in those existing queries.

The action preserves the earlier query for compatibility. The backend now has
263 modules: all original 261 are byte-identical, plus the two new read-only
adapters. Schema, auth, definitions, indexes, crons and ingestion/moderation code
were not changed. Verified backend fingerprint:
`6b7677f7f6a668c288ff5daad8a17763366738dfce346b6bc7de6b90aca02be6`.

Final source commit: `1e69ed000b66f52386916aa9003358aac4683833` on
`codex/publish-day-loading`. All 126 release checks passed again, including
production build. Actual log SHA256:
`213e92d15acd2ab4c4cf19678cd5dd8d98075bd5c2a6c28fff25ec36fc9f6ca1`.
The original audit workspace was synchronized to all 721 tracked files of that
commit, preserving this report and the raw audit artifacts.

### Actual public API transport comparison

The independent HTTP harness used identical October/month/week/day arguments,
the same public backend and explicit identity encoding. Response-body bytes
include the Convex JSON envelope, exclude HTTP/TLS headers, and describe the
backend-to-Next path rather than browser downloads. All before/after event and
directory digests matched: 478 month events, 342 week events and 37 selected-day
events. These are actual deployed API measurements, unlike the earlier frozen
DTO projections.

| Initial data composition | Before | Final action path |
| --- | ---: | ---: |
| Home detailed events received by Next | 478 | 37 |
| Home HTTP JSON body bytes | 548,709 | 190,486 |
| Home responses | 12 | 12 |
| Map detailed events received by Next | 342 | 37 |
| Full-directory venues received for map | 678 | 0 |
| Map HTTP JSON body bytes | 1,145,709 | 161,549 |
| Map responses | 10 | 9 |

Action response sums in three adjacent old/new samples were home
2,662/786, 517/871 and 556/642 ms; map 2,293/598, 703/577 and 627/467 ms.
Order, shared server load and query-cache warmth prevent causal first-load
claims. In particular, the old reads can warm child queries for the action.
Warm home overhead was higher in two samples. Smaller payloads do not imply a
uniform page-speed gain.

A completely novel outer whitespace query took 468 ms, then 424 ms, with the
same unfiltered week digest; the rejected nested-query version took 17 seconds
on a novel equivalent key. A genuinely new date window still took 5,279 ms on
its first seven-page action traversal, then 499 ms. This remaining cold cost
must not be described as solved. The overview still reads authorized event
rows inside Convex; no database-read reduction is claimed.

Receipts: `/tmp/eventzeka-public-api-action-after-20261020.json`,
`/tmp/eventzeka-public-api-action-comparison-20261020.json`,
`/tmp/eventzeka-action-new-window-parity-20261020.json` and the private guarded
deployment directory `/tmp/eventzeka-convex-overview-action-20261020` on the VPS.
Web publication remains gated on the final Linux build and actual browser flows.

### Next proposal for the remaining cold path

If first access to a new month/week remains material after public verification,
separate map rendering from weekly count readiness, or batch bounded public
pages inside one action and deduplicate venue reads across those pages. Preserve
the opaque continuation cursor, existing publication queries, exact counts and
60-second freshness ceiling. This needs a separate measured implementation;
neither maintained aggregate tables nor a schema migration were introduced.
