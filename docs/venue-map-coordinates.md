# Venue map coordinates

The calendar map reads current venue coordinates by exact Convex venue ID.
Existing events receive the venue's saved location at read time, so the
coordinate backfill does not rewrite events, source occurrences, identities,
ingestion settings, or publication status. The page reads live data; applying
the reviewed data does not require restarting the web or Convex containers.
The server also supplies a reviewed display address when its exact venue ID
and both coordinates match the current published venue. Changing either
coordinate invalidates that address evidence. This prevents stale saved city
or seasonal address text from contradicting a verified map point without
rewriting source-bound event metadata. The reviewed directory stays on the
server and is not included in the map's client bundle.

`data/venue-coordinates-2026-10-15.json` contains the reviewed production venue
IDs, names, Instagram handles, revisions, coordinates, and public evidence
URLs. OpenStreetMap points and building geometry come from the recent
[Geofabrik Serbia extract](https://download.geofabrik.de/europe/serbia.html).
OpenStreetMap data is attributed to its contributors and licensed under
[ODbL](https://www.openstreetmap.org/copyright). Official venue contact pages
corroborate addresses and distinguish branches where available. Unclear
matches and conflicting locations must not be assigned a city-center pin.

## Applying reviewed locations

Use the existing self-hosted deployment's private credentials in the process
environment: `CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY`.
Never commit, print, or place these credentials in command arguments. The
target origin must agree with both the manifest and the explicit CLI flag.

Run the default preview on the trusted operator host first:

```sh
npm run repair:venue-coordinates -- \
  --manifest data/venue-coordinates-2026-10-15.json \
  --receipt /private/operator/path/coordinates-preview.json \
  --expect-origin https://convex-events.ineedtofeedmyrabbit.com
```

Add `--apply` to apply the same reviewed plan. Every venue is checked before
the first write and read again immediately before its update. A venue must
remain published with the exact reviewed ID, name, handle, and revision.
Existing or partially populated coordinates are never overwritten; an
identical already-applied pair is an idempotent skip.

The script uses Convex's existing admin dashboard mutation
`_system/frontend/patchDocumentsFields:default`, always supplying exactly one
venue ID and only `latitude`, `longitude`, and `updatedAt`. Convex records a
system audit event. Before and after module hashes and active schema are
fingerprinted to verify that the deployed backend stays unchanged.

The dashboard mutation does not provide an atomic expected-revision
condition. Run this maintenance from one trusted operator session and do not
perform simultaneous venue-location edits. If another process changes a
reviewed venue, stop and review the new record rather than bypassing the
revision check. Each completed row is a separate transaction; a later error
can leave an explicitly recorded partial run.

Receipts are saved with mode 600 before each write and after strict readback
verification. Keep these receipts with the current release's operational
artifacts. They contain before/after venue records and evidence URLs, never
credentials. A failed or interrupted run must be inspected before retrying.

## Verification

Run `npm run qa:release` and `git diff --check`. The release suite includes
`qa:venue-coordinates`, which checks manifest validation, missing-only guards,
idempotency, revision conflicts, and coordinate-only readback. Also verify the
live map on multiple dates, click a real marker, and confirm its event lineup
and venue link. Check site readiness and the existing social renderer after
applying production data.
