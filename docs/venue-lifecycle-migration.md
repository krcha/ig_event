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

The dry-run reports scanned records, target states, pending changes, sample changes, and `rollbackMapping`. It performs no writes.

## Apply

Only after reviewing counts and the backup:

```bash
npm run migrate:venue-lifecycle -- \
  --apply \
  --confirm APPLY_VENUE_LIFECYCLE \
  --backup-reference '<verified-backup-id>' \
  --limit 50
```

Apply mode is idempotent and processes only records missing one or both explicit lifecycle fields. Every migrated record writes an audit entry containing the explicit before/after state and backup reference. Re-running after completion reports zero pending changes.

## Rollback

Before any independent scrape/publication edits, restore each record's legacy `isActive` value and remove `scrapeActive` and `publicStatus` using the dry-run's rollback mapping. After independent states have been edited, the legacy boolean cannot represent both values; restore the verified Convex backup instead.

Never run the apply command without an approved backup and reviewed dry-run evidence. This repository change does not execute the migration automatically.
