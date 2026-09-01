throw new Error(
  "migrate:event-venue-identity is retired because it could change an event without atomically re-attesting its source-occurrence receipt. Run the tracked internal/migrations/eventDomain:backfillEventVenueBindingsBatch workflow in dry-run, apply, and verification passes instead.",
);
