# Event and venue schema production release, 2026-10-17

Release `4718382` is live on eventzeka.com. Venue LocalBusiness and Event location
Place nodes now include sourced weekly OpeningHoursSpecification. Venue detail
pages also show the existing Hours component, matching structured data with
visible content. Opening and closing clocks use regular-weight text.

Event dates use canonical announced times and time provenance. Unknown or inferred
clocks remain date-only; start-only events do not publish an assumed Event end.
Explicit ranges retain overnight closing and independently resolved Belgrade
offsets. Invalid real dates omit the Event node; DST gaps and repeated autumn
clocks avoid invented instants. Display and Open now closing fallbacks remain.

Weekly hours retain multiple periods, overnight sessions, known closed days and
24-hour schedules. Missing weekdays remain unknown. Invalid, conflicting,
unsourced or foreign-timezone schedules are omitted. The public-catalog audit
found 122 usable schedules across 578 profiles; all 122 produced schema, totaling
788 opening-hours entries.

## Verification

- `npm run qa:release`, including lint, typecheck, build and all configured gates,
  passed locally. `git diff --check` and the read-only exporter's self-test passed.
- [GitHub Linux release gates](https://github.com/krcha/ig_event/actions/runs/39056230272)
  passed for the same source commit.
- The frozen Linux production build passed after resolving host memory pressure.
- Preview and public-production browser checks passed at 390px and 1440px:
  seven Dim weekly rows, matching schema, font weight 400 and no horizontal overflow.
- Browser and HTTP checks confirmed unknown-start Dim, start-only Muzej 90ih,
  and Vrtoglavica's explicit 23:00 to next-day 05:00 range.
- Preview and production smoke checks passed health, calendar, map, five events
  and three venue pages. All 21 referenced script assets matched the frozen build.
- Calendar and map Open now each returned 48 events at the recorded check instants;
  the label and future-date override remained intact. Counts naturally vary with time.
- Six protected prior main/social/backend containers retained their IDs, running
  state and start times. No backend deployment or data mutation was required.
  Apify basicData, pinned-post skipping, the 24-hour window and budgets were preserved.

These checks validate implementation and rendered JSON-LD. Google Rich Results
Test and Search Console were not run. See [the audit report](../SCHEMA-REPORT.md)
and [generated examples](../generated-schema.json) for scope and primary references.

## Production

- Container: `ig-event-web-schema-hours-4718382`.
- Source: `/root/ig_event-releases/schema-hours-4718382`.
- Compose: `/root/ig_event-release-artifacts/schema-hours-4718382/production.compose.yml`.
- Loopback: `http://127.0.0.1:3143`; Traefik priority 1007.
- Dependency mount: `/root/ig_event-releases/upcoming-role-audit-c38f9d9/node_modules`.
- Prior active main retained: `ig-event-web-venue-hours-layout-f5ba2c8`.

Staging verified nine changed-file hashes against the prior production source and
preserved 56 older static assets. Private manifests, QA markers, Linux build log,
smoke results, browser evidence and cleanup records live in the artifact directory.

## Host memory pressure and retired instances

Two initial build attempts were stopped before release after host memory pressure
caused public health checks to time out. Health recovered after each stop.

Two obsolete Eventzeka web containers consumed about 2 GiB. Both had lower
Traefik priority than the active main, excluded social routes, had no established
TCP connections, and had no direct references in host cron or systemd units:

- `ig-event-web-upcoming-role-audit-c38f9d9` (priority 1000, loopback 3125).
- `ig-event-web-apify-recent-065c717` (priority 1002, loopback 3133).

They were stopped reversibly, retaining containers, source directories and
dependency mounts. Available memory increased from about 1.2 GiB to 3.2 GiB;
public health passed. If needed, restore them with `docker start` and those exact
two names. The active main, prior rollback main, social service and backend stayed
running. The final clean build used a 1536 MiB hard memory limit, no swap, two CPUs,
a 1024 MiB Node heap and two Rayon threads.

## Venue gap exports

The read-only export was fetched after public promotion at
`2026-10-17T18:24:46.452Z` (20:24:46 Europe/Belgrade):

- Public directory profiles: 578.
- Missing valid map coordinates: 214.
- Missing all known sourced opening-hours days: 456.
- Partial weekly schedules, listed separately: 14.

The directory also contains organizers, festivals and performers; physical venue
roles are not guessed from names. An expired refresh deadline is flagged separately
and does not mean hours are absent. Confirmed closed days count as known information.

CSV files, the workbook, snapshot, timestamp and checksum manifest are saved outside
Git in `/Users/krcha/Downloads/Eventzeka-izvoz-2026-10-17/`. The reusable exporter is
`scripts/export-public-venue-data-gaps.mjs`; run with `node --experimental-strip-types`,
`--output-dir` naming a new directory, and optionally `--convex-url`.

All three workbook sheets were rendered and reviewed. Artifact Tool reimport and
independent CSV/XML checks verified every exported row and stable ID, tables,
filters, frozen headings, full URL text values, UTF-8 BOM and checksums. The
workbook has no formula or error cells. Its SHA-256 is
`9a6fef44facf45c2fa33a216ed20a69718bd2e9a3a814619681163b06a512e3a`.

The owned preview and three build-attempt containers were removed after public
verification. Browser and tunnel sessions were closed; final public health passed.
