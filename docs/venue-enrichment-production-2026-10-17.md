# Venue location and opening-hours enrichment, 2026-10-17

The user authorized completing the exported venue gaps, prioritizing venues with
upcoming events, using Google Maps and reliable owner sources including public
Instagram biographies, and publishing the verified data to production.

## Reviewed data

`data/venue-enrichment-reviewed-2026-10-17.json` preserves the exact venue IDs,
identity and branch evidence, source URLs, review timestamps, coordinates and
weekly visitor schedules. The research inspected 477 public Instagram profiles
(464 exposed a public biography), existing reviewed source manifests, owner
websites, venue booking pages and public Google Maps business listings. No Apify
run or paid Google Places API call was used for this enrichment.

- 21 missing map coordinate pairs, including seven venues with upcoming events.
- 168 previously missing visitor schedules: 91 Google and 77 owner/manual.
- 148 new complete weeks and 20 new intentionally partial weeks.
- 177 distinct public profiles enriched. Eleven have 35 upcoming approved public
  events in the bounded 400-day research window. New hours cover four of those
  venues and 28 events, including 25 events at Mts Dvorana.

The Google parser was scoped to the main business-hours group `[203, 0]`.
Secondary kitchen, brunch, ticket-office, reception and booking periods were not
used as visitor opening hours. Current owner schedules prevail over conflicting
Google clocks. Unknown weekdays remain omitted. Eugster's owner-confirmed open
days match Google exactly; Google's explicit closed days complete its week.
Overnight windows retain their following-day closing semantics.

Future-only Ljubavnica, closed or seasonal venues, unresolved relocations,
different branches, organizers, outside-Belgrade matches and the RADIO.D59B
online radio profile were withheld. The separate physical D59B cafe has an
owner-confirmed schedule. FAKS received its owner-linked map point but has no
confirmed weekly visitor hours. The source address labels in the coordinate
manifest are review evidence; this operation does not change address text.

## Production operation

Production remains on web source `4718382b2e24c8e75f42d27e731e98a910b07e45`,
container `ig-event-web-schema-hours-4718382`, at
`https://eventzeka.com`, using the existing self-hosted Convex origin
`https://convex-events.ineedtofeedmyrabbit.com`.

The data was applied directly through existing maintenance paths. This does not
require a frontend or backend redeployment. No event, ingestion, moderation,
venue lifecycle, identity, map ID or existing usable-hours fields were changed.
The public map and hours consumers already read these live venue records.

Private production artifacts are stored under
`/root/ig_event-release-artifacts/venue-enrichment-20261017/` on the existing VPS.
The directory is mode 0700; receipts, plans and snapshots are mode 0600.

1. `scripts/backfill-venue-coordinates.mjs` validated all 21 exact identities,
   revisions and missing coordinate pairs before its preview. The matching
   apply used the same manifest/script hashes, fresh per-row reads and exact-ID
   field patches limited to `latitude`, `longitude` and `updatedAt`. Each row
   was read back and all other fields compared. The backend module/schema
   fingerprint and protected service identities/start times remained unchanged.
2. The private hours operator planned all 168 exact-ID missing-only updates
   after the coordinate operation. It rechecked the identity and existing hours
   immediately before each write, saved an applying receipt, patched only the
   six hours-cache fields through `venues:patchVenueHours`, then immediately
   verified the result. Existing hours, unselected venue hours, other venue
   controls and backend/runtime fingerprints are guarded. Source evidence is
   retained in `hoursJson.raw`; cache refresh metadata uses the existing
   seven-day interval.

Reviewed coordinate manifest SHA-256:
`004a55e81e9a5e7de7b36b01648263852e1773a70435a47ebef8e8ed75d0b603`.

Reviewed hours operator dataset SHA-256:
`b28130631e3a9f25ae1d640df87df03b81ff2ea5208e4e9e1a2a1fe77026610d`.

## Verification and remaining gaps

The coordinate apply completed at `2026-10-17T19:18:11Z`; the hours apply
completed at `2026-10-17T19:26:24Z`. All 21 coordinate and 168 hours readbacks
passed. Existing usable schedules, unselected venue hours and the guarded
backend deployment and protected services remained unchanged.

Public verification at `2026-10-17T19:26:44Z` confirmed every new coordinate pair
and schedule through the public venue API. Live HTML verification checked all
seven upcoming-event Place coordinate pairs, plus two venue LocalBusiness geo
nodes. Four enriched venue pages and their event pages publish matching sourced
opening-hours specifications. Unknown event starts remain date-only, Vespa's
announced 21:00 start retains the Belgrade UTC offset, and venue closing times do
not become announced event end dates.

All 168 new schedules emit 1,098 valid opening-hours specifications. The entire
public directory's 290 sourced schedules emit 1,886 specifications, with no
invalid sourced schedule. `npm run qa:release` passed, including `npm run build`.
`git diff --check` passed.

The refreshed public export contains 578 profiles:

| Data | Before | After |
| --- | ---: | ---: |
| Missing map coordinates | 214 | 193 |
| Missing opening hours | 456 | 288 |
| Known opening-hours schedules | 122 | 290 |
| Complete weekly schedules | 108 | 256 |
| Partial weekly schedules | 14 | 34 |

The new partial schedules explain the increase in partial-week count; an unknown
day is explicitly retained as unknown. No timezone mismatches or invalid time
zones were found. The directory also contains non-venue profiles and unresolved
physical venues; the remaining gap counts are not a count of confirmed operating
businesses that could safely receive guessed data.

Updated read-only CSV exports and their checksummed public snapshot are in the
new local folder `/Users/krcha/Downloads/Eventzeka-dopune-2026-10-17/`:

- `mesta-bez-lokacije-na-mapi.csv` (193 profiles).
- `mesta-bez-radnog-vremena.csv` (288 profiles).
- `mesta-sa-nepotpunim-radnim-vremenom.csv` (34 profiles).
- `venue-data-gaps.json` and `export-manifest.json`.

The earlier export folder is preserved. Public verification, reviewed source
files, release checks and final gap summaries are retained with the private
production operation artifacts; credentials were read only inside the existing
trusted host process and were not included in commands, exports or commits.
