# Stacked venue hours, 2026-10-17

Release `f5ba2c8` is live on eventzeka.com. Calendar venue-hours fallbacks now
show opening above closing in the same 64px-wide rounded badge as event times.
Opening uses regular 12px text; closing uses regular 10px muted text. The
separate Venue hours label remains absent.

Every interval is retained for split schedules, and the badge grows vertically
when needed. Accessible event labels and full-range tooltips are preserved.
This change only affects calendar presentation.

## Verification

- `npm run qa:release`, including lint, typecheck and build, passed.
- `git diff --check` passed; the frozen Linux production build also passed.
- Browser checks at 390px and 1440px validated all 31 rendered fallback labels,
  including one split schedule. Both times have weight 400, opening appears
  above closing, and visible agenda badges are 64px wide without overflow.
- The same checks passed in the browser against the public production domain.
- Preview and production smoke checks passed health, calendar, map and event
  details; all 19 referenced script assets matched the frozen build.

## Production

- Container: `ig-event-web-venue-hours-layout-f5ba2c8`.
- Source: `/root/ig_event-releases/venue-hours-layout-f5ba2c8`.
- Compose: `/root/ig_event-release-artifacts/venue-hours-layout-f5ba2c8/production.compose.yml`.
- Loopback: `http://127.0.0.1:3141`; Traefik priority 1006.
- Dependency mount: `/root/ig_event-releases/upcoming-role-audit-c38f9d9/node_modules`.
- Prior main retained: `ig-event-web-map-open-now-640f094`.

Staging verified two file hashes, including the prior release receipt, and
preserved 48 older static assets. Five protected prior web/social/backend
containers retained their IDs and start times. No backend deployment or data
mutation was needed. Apify configuration and budgets were preserved.

Private manifests, QA markers, Linux build log, smoke results and browser
evidence are under `/root/ig_event-release-artifacts/venue-hours-layout-f5ba2c8`.
The temporary preview and build containers were removed after verification.
