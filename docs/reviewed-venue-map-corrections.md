# Reviewed venue map corrections

The missing-only coordinate backfill continues to refuse overwriting existing
points. `scripts/correct-reviewed-venue-map.mjs` is a separate operator for one
human-reviewed existing venue's coordinates and display address. It does not
rename venues, move events, change source roles, or deploy Convex code.

The reviewed plan must pin the exact Convex origin, venue ID, name, Instagram
handle, old revision, old coordinates, old address (null means absent), new point
and address, evidence URLs and review note. Published venue identity is required.
Use private `CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY` credentials
through the operator environment; never include the admin key in CLI arguments,
committed files, logs or receipts.

Preview with a new private receipt path:

```bash
node scripts/correct-reviewed-venue-map.mjs \
  --manifest data/venue-map-correction-vinyl-2026-10-17.json \
  --receipt /private/operator/vinyl-map-preview.json \
  --expect-origin https://convex-events.ineedtofeedmyrabbit.com
```

Review the before snapshot, evidence and target point, then apply the identical
manifest using the printed `planHash` and `deploymentFingerprint`, and a second
new receipt path:

```bash
node scripts/correct-reviewed-venue-map.mjs \
  --manifest data/venue-map-correction-vinyl-2026-10-17.json \
  --receipt /private/operator/vinyl-map-apply.json \
  --expect-origin https://convex-events.ineedtofeedmyrabbit.com \
  --apply --expect-plan-hash REVIEWED_PLAN_SHA256 \
  --expect-fingerprint REVIEWED_DEPLOYMENT_SHA256
```

The existing admin maintenance mutation has no atomic revision condition. Avoid
concurrent venue editing during this operation. The script persists the full
before snapshot before writing, checks the deployed module/schema fingerprint,
rereads and compares the full venue immediately before the exact-ID patch, then
verifies the complete readback. Only latitude, longitude, location and updatedAt
may change. A failed or lost response retains the before receipt; inspect current
data and the receipt before retrying. It does not roll back concurrent edits.
An already matching point and address is a write-free success. Receipt files are
mode 0600 and must be kept in the private operator release artifacts directory.

The 2026-10-17 Vinyl review supersedes the previous exact-name OSM music-shop
match. Its stale old revision is intentional: if the venue changes before apply,
capture and review a new private manifest rather than bypassing the guard.
Run the offline focused checks with
`node scripts/qa-reviewed-venue-map-correction.mjs`.
