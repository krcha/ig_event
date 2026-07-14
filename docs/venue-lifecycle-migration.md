# Venue Lifecycle Migration

Venue scraping and public visibility are independent:

- `scrapeActive` controls whether ingestion and hours refresh jobs process a venue.
- `publicStatus` is `pending`, `published`, or `hidden` and controls public exposure.
- Legacy documents remain behavior-compatible before migration: `isActive: true` maps to scrape-active and published; false or missing maps to scrape-paused and hidden.
- Newly discovered handles are scrape-active and pending, so discovery never publishes them automatically.

## Before applying

1. Deploy the optional schema and compatibility readers.
2. Create and verify a Convex backup. Record its immutable identifier.
3. Run the dry-run from the intended deployment environment:

```bash
npm run migrate:venue-lifecycle
```

The dry-run reports scanned records, target states, pending changes, up to 20 sample changes, the complete `rollbackManifest`, and `rollbackMapping`. It performs no writes. `rollbackManifest` contains one record for every pending change and copies the exact values from `change.rollback`.

Export that complete manifest to a reviewed file before applying:

```bash
npm run migrate:venue-lifecycle -- \
  --rollback-manifest './venue-lifecycle-rollback.json'
```

The JSON file is an array of all per-record rollback entries; it is not limited to the 20 display samples. Store it with the backup evidence and do not commit production data to the repository.

## Apply

Only after reviewing counts and the backup:

```bash
npm run migrate:venue-lifecycle -- \
  --apply \
  --confirm APPLY_VENUE_LIFECYCLE \
  --backup-reference '<verified-backup-id>' \
  --rollback-manifest './venue-lifecycle-rollback.json' \
  --limit 50
```

Apply mode is idempotent and processes only records missing one or both explicit lifecycle fields. Before every batch, the mutation compares the complete remaining migration plan with the reviewed manifest and rejects any drift. If a venue changed after export, stop, export a fresh manifest, inspect the difference, and obtain a new review before applying. Every migrated record writes an audit entry containing the explicit before/after state and backup reference. Re-running after completion with a fresh empty manifest reports zero pending changes.

## Rollback

Before any independent scrape/publication edits, restore every record from the complete exported manifest. Treat the three rollback values independently:

- if `rollback.isActive`, `rollback.scrapeActive`, or `rollback.publicStatus` is `null`, remove only that field because it was absent before migration;
- otherwise set that field to the exact boolean or status in the manifest.

Do not generically remove both explicit fields. For example, a pre-existing partial record `{ isActive: true, scrapeActive: false }` must roll back to exactly those values: retain `isActive: true`, retain `scrapeActive: false`, and remove only `publicStatus`. After independent states have been edited, the migration manifest is no longer sufficient because it predates those edits; restore the verified Convex backup instead.

Never run the apply command without an approved backup and reviewed dry-run evidence. This repository change does not execute the migration automatically.
