# Reviewed venue hours, 2026-10-17

The display change in `b58e285` is live on eventzeka.com. When the source does
not announce an event time, the event detail and calendar show the venue's
verified opening windows for that weekday, explicitly labeled `Venue hours`.
Announced event times take precedence. Venue hours do not become event times,
sorting keys, day/night classifications, occurrence identities or structured
data timestamps.

## Data collection and coverage

`data/venue-hours-reviewed-2026-10-17.json` records 163 reviewed venues linked to
approved events between October 17 and November 30. Exact place identity,
address, official handle and visitor scope were reviewed before acceptance.
Google's main business hours were preferred, with current official schedules
used when Google was absent, malformed or contradicted the venue's explicit
visitor schedule. Reception, box-office, office, takeout and brunch schedules,
unrelated branches and promoter-only profiles were excluded.

- 118 new venue schedules: 79 Google and 39 other verified sources.
- 104 complete weekly schedules and 14 partial schedules.
- 45 unresolved venues retained with reasons and source references.
- Usable venue schedules in production increased from 4 to 122.
- The public calendar returned 485 events in the reviewed date window.
- 289 of those events are bound to the newly enriched venues.
- 139 events without an announced time now have an opening window for their
  actual weekday; another 6 have no verified open window for that day.

Unknown weekdays remain absent and display `Not available`; they are not
converted to `Closed`. Explicit closed days are retained. Multiple windows and
overnight boundaries are preserved. Sources and review dates are stored with
each schedule, and the public weekly table links to the sources.

The exact reviewed dataset SHA-256 is
`7072bafd99c28b63e2c5efe9f823e0a2d2f34fba6b92555653c56e5901e08451`.
Collection used public Maps pages and other public evidence, with no paid
Apify acquisition or Google Places API request.

## Production application

The existing authenticated `venues:patchVenueHours` mutation applied only
`hoursSource`, `hoursJson`, `hoursFetchedAt`, `hoursExpiresAt`, `hoursTimezone`
and `hoursError`. Before every write, the operator rechecked the venue's name,
handle, publication state, address, coordinates, map identifiers and prior
hours. Existing usable caches were not overwritten. All 118 readbacks matched
their reviewed patches; other venue fields and unselected venue hours were
checked unchanged. No event records, map identities, schema or backend functions
were changed by this collection.

Private before/after snapshots, the reviewed plan, operator, progress, receipt
and coverage report are under
`/root/ig_event-release-artifacts/venue-hours-20261017`.

## Web release and verification

- Container: `ig-event-web-venue-hours-b58e285`.
- Source: `/root/ig_event-releases/venue-hours-b58e285`.
- Compose: `/root/ig_event-release-artifacts/venue-hours-b58e285/production.compose.yml`.
- Loopback: `http://127.0.0.1:3135`; Traefik priority 1003.
- Dependency mount: `/root/ig_event-releases/upcoming-role-audit-c38f9d9/node_modules`.
- Prior main web release `ig-event-web-apify-recent-065c717` remains available.

The release retains the `/api/social` routing exclusion. The prior main web,
separate social and Convex backend containers kept their IDs and start times.
Apify basic-first collection, pinned-post exclusion, rolling 24-hour window and
existing budget settings remain in place. No backend deployment was needed.

`npm run qa:release`, including build, and `git diff --check` passed. The Linux
release separately passed lint, typecheck and build. Preview and production
health, event and map routes passed, along with all 14 referenced local script
assets checked against the new build. Previous static assets were preserved.

Browser checks at 390px confirmed the labeled fallback in event details and
calendar cards, source links, all six categories and no horizontal overflow.
Dim shows `Venue hours 17:00-01:00`; Bar44 shows `20:00-03:00` while its event's
JSON-LD date remains date-only. VIS Potencijali retains its announced 21:00 and
its timestamp in JSON-LD. A partial schedule retains unknown weekdays.
Temporary preview and build containers were removed after production checks;
the active release and its required dependency mount remain in place.
