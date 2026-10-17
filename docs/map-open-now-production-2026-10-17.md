# Map Open now and event closing fallback, 2026-10-17

Release `640f094` is live on eventzeka.com. It extends the calendar update in
`b7e56b4` with the same Open now control on the map.

- The visible and accessible control label is `Open now`, without a clock.
  Filtering still uses Europe/Belgrade and refreshes each minute and on return
  to the tab.
- Announced event starts and ends determine eligibility. A start-only event
  assumes the closing of its matching continuous venue opening. Announced ends
  take precedence; missing closing information remains unresolved.
- Calendar, detail, map lineup and mobile popups display the derived closing.
  Canonical event time, provenance, sorting and JSON-LD retain source evidence.
- Events without announced times use verified venue hours. Yesterday's rows
  require an actual overnight continuation; 24-hour opening alone does not
  carry an unknown-time event into another day.
- Map pins, popups, lineup and selected-day counts use the same filtered set.
  Date navigation exits Open now. Equivalent minute refreshes preserve the
  Leaflet instance, viewport and open popup.
- DST filtering resolves real instants. Repeated-hour starts use the earliest
  possible instant and ends use the latest; impossible spring-hour bounds are
  unresolved. Closing gaps are not bridged.

## Verification

The final source passed `npm run qa:release`, including build, and
`git diff --check`. Linux lint, typecheck and build also passed. Focused tests
cover announced bounds, start-only closing, clipped midnight windows, gaps,
unknown schedules, 24-hour carry, future dates and both DST transitions.

Preview and production smoke checks passed health, calendar, map and three
event details. All 19 referenced script assets matched the frozen Linux build.
Calendar and map each returned the same 27 Open now event IDs at 17:45, matching
the public-data verifier exactly. Requests combining Open now with a future
date still select the current Belgrade date.

Browser checks at 390px and 1440px confirmed the compact label, filtering,
date navigation and no horizontal overflow. A minute refresh preserved an open
popup and map pan. Mobile popup hours clear the map controls and use weight 400.
The Muzej 90ih start-only example displays 17:00-20:00, while its canonical
17:00 start and JSON-LD remain unchanged and no derived endDate is emitted.

## Production

- Container: `ig-event-web-map-open-now-640f094`.
- Source: `/root/ig_event-releases/map-open-now-640f094`.
- Compose: `/root/ig_event-release-artifacts/map-open-now-640f094/production.compose.yml`.
- Loopback: `http://127.0.0.1:3139`; Traefik priority 1005.
- Dependency mount: `/root/ig_event-releases/upcoming-role-audit-c38f9d9/node_modules`.
- Prior main retained: `ig-event-web-calendar-open-now-b7e56b4`.

Four protected prior web/social/backend containers retained their IDs and start
times. The social API routing exclusion, Apify configuration and budgets were
preserved. No backend deployment or data mutation was needed. Staging verified
14 changed file hashes and preserved 40 older static assets for existing clients.

Private source manifests, QA markers, Linux log, smoke snapshots, parity checks
and browser evidence are under
`/root/ig_event-release-artifacts/map-open-now-640f094`. Temporary preview and
build containers were removed; the active source and dependency mount remain.
