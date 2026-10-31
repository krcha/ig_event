# Owner analytics and email verification production release

Released to `https://eventzeka.com` on 2026-10-31 (Europe/Belgrade).
Application changes: `984b7eac3677e15f58607de9be706c7cc71f922a`.

## Live behavior

- `/admin/analytics` provides visitor, click, source, country, device, browser,
  and operating-system reports with hourly, daily, and monthly grouping.
- Only the verified owner's existing Clerk account can read reports. Page,
  Next.js API, and Convex action each enforce the same owner restriction.
- Clerk sign-in now handles `needs_second_factor` with `email_code`. The
  previous form showed a generic failure after a valid password when Clerk
  required this step. No session is activated until verification completes.
- Tracking starts at this release. Earlier visits cannot be reconstructed.
  See [visitor analytics](visitor-analytics.md) for definitions and privacy.

## Production layout

The VPS uses Traefik and Docker, with self-hosted Convex. This is a composite
production deployment: preserve the active server source and backend modules,
as described in the [previous release](performance-calendar-release-2026-10-20.md).
Do not replace the whole live Convex deployment from this checkout.

- Web source: `/root/ig_event-releases/admin-analytics-auth-984b7ea`.
- Container: `ig-event-web-admin-analytics-984b7ea`.
- Compose project: `eventzeka-admin-analytics-984b7ea`.
- Private application listener: `127.0.0.1:3189`.
- Traefik main-site router priority: `1038`; `/api/social` keeps its existing
  independent router and container.
- Next.js build ID: `Sl8olBlu6FkjcZSN8n52u`.
- Private release evidence and Compose files:
  `/root/ig_event-release-artifacts/admin-analytics-auth-20261031`.
  This directory includes secret-bearing baseline/runtime files; do not copy it
  into Git or publish its contents.

The source overlays the 37 release files on the previous active web source,
preserving all other live files. The existing server variant of
`scripts/qa-clerk-email-auth.mjs` was retained with the new sign-in QA import
appended. Dependencies use an independent directory; only `mmdb-lib@3.0.3` was
added. Existing static assets were retained for clients with an older page open.

Convex was deployed through the pinned native CLI protocol with a scoped
request, preserving 356 existing modules, 42 tables, existing function
signatures, auth configuration, and existing cron definitions. The release
adds `analytics.js`, `analyticsEvents` with three indexes, four functions, and
one retention cron. The schema and cron exports were extended additively.
The scoped request SHA-256 is
`c9c2b71ec4cc5f02faeff3e82b2ff105fcf61dbc2cb935800f37240b1ffd0cbc`.
Do not replay the original apply request against an advanced deployment.

The owner's single ID is configured in both application and backend and is
already in the existing admin allowlist. Country lookup uses the existing
frame.baby PDDL MMDB snapshot and the trusted direct Traefik connection;
`ANALYTICS_TRUST_PROXY=true`, with the application listener kept private.
No Clerk verification requirement was disabled.

## Verification and rollback

- Full `npm run qa:release` passed, including the production build.
- Linux production build, lint, typecheck, Clerk sign-in QA, analytics QA,
  admin authorization QA, and cleanup scheduler QA passed.
- Public health, calendar, and sign-in pages respond successfully; existing
  `/events` and `/calendar` redirects to `/` remain intact. All 16 inspected
  local script assets return 200, including the new verification UI.
- The public asset set matches the new private listener. Unauthenticated
  analytics page/API requests return no report.
- A real browser visit and navigation produced two views and one click.
  The owner report showed one visitor, Serbia, Desktop, Chrome, Mac OS, and
  Direct source. Another authenticated identity and an anonymous caller were
  denied. No demonstration event rows were inserted.
- The live backend contains 357 modules, with the 42 old tables and all old
  function signatures preserved. Existing Convex, proxy, scheduler, and social
  containers were not restarted.
- Real owner password/email-code submission remains for the user to test;
  automated sign-in flow tests used mocks and sent no authentication email.

The prior web container `ig-event-web-mobile-discover-refine-d4c284e` remains
running at router priority 1037. To revert web traffic, stop only the new
release's Compose project using its `production.compose.yml`; Traefik will
resume the prior router. Do not stop shared infrastructure or the social
container. The additive backend can remain deployed during a web rollback.
Preserve the new runtime environment, source, dependencies, and geodata while
this release is active.
