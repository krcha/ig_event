# Ig Events Development Plan

## Mission

Build a reliable event discovery app for Belgrade nightlife that turns Instagram activity into trustworthy public event listings with a small, efficient admin workflow.

## Product Principles

- Public listings must be accurate enough to trust without manual cross-checking.
- Automation should accelerate moderation, not silently publish uncertain data.
- Admin tools should explain what happened in each ingestion run.
- Ingestion should be resumable and safe under route/runtime time limits.
- QA must be deterministic across calendar dates and environments.

## Workstreams

### 1. Ingestion Reliability

Goal: Make "Get New Events" a dependable operator action.

- Keep queued jobs small enough to finish inside route limits.
- Persist progress after bounded units of work.
- Track fetched, inserted, approved, pending, duplicate, and failed counts consistently.
- Make Apify/OpenAI quota failures visible in the admin run summary.
- Add focused regression fixtures for duplicate, date, venue, and confidence handling.

### 2. Moderation Quality

Goal: Prevent weak extractions from reaching the public calendar.

- Use a conservative auto-approval threshold until production confidence data proves otherwise.
- Keep UI labels aligned with auto-approval policy.
- Keep duplicate suspicion, missing media, suspicious years, and fallback titles visible.
- Prefer pending review for uncertain events.

### 3. Approved Event Deduplication

Goal: Collapse duplicate approved listings without losing user state.

- Merge duplicate records into the strongest primary event.
- Reassign saved-event references before deleting duplicates.
- Leave ambiguous groups for manual review.
- Keep automerge QA independent of wall-clock date.

### 4. Operator Experience

Goal: Let an admin understand the app state in one pass.

- Keep one primary "Get New Events" workflow.
- Keep advanced tools available but visually secondary.
- Show clear outcomes: calendar-visible events, pending review, quota-blocked runs, and duplicate merges.
- Avoid copy that says "deleted" when the behavior is "merged".

### 5. Release Engineering

Goal: Make every release mechanically checkable.

- Required deterministic checks: lint, typecheck, `qa:dedupe`, `qa:automerge`, `qa:extraction`.
- Add `next build` to the required gate once the local build hang is resolved.
- Bound long-running local checks so hung tooling is treated as a failure.
- Keep environment-dependent checks documented separately from code regressions.
- Do not ship with failing deterministic QA.

## Immediate Stabilization Sprint

1. Fix `qa:automerge` so fixtures use future dates relative to the run date.
2. Restore a conservative auto-approval threshold or explicitly redesign the low-confidence policy.
3. Respect queued ingestion `batchSize` for full-scrape job steps.
4. Re-run focused QA scripts and document any local tooling hangs.
5. Review the admin scraper dashboard copy against actual ingestion behavior.

## Implementation Status

Completed in this pass:

- Added deterministic approved-event automerge QA with future-relative fixtures.
- Restored the conservative auto-approval policy and covered it in extraction QA.
- Made queued full-scrape job steps respect the configured batch size.
- Updated admin scraper and duplicate-merge copy to match current behavior.
- Made production admin routes fail closed when Clerk is not configured.
- Added `qa:release` and a GitHub Actions release gate.

Known follow-up:

- Local `next build` still hangs before Next emits useful output; verify the
  build in CI or a clean shell after the deterministic release gate is green.

## Next Product Milestones

### Milestone A: Trustworthy Calendar

- Public `/events` and `/calendar` show only approved upcoming events.
- Auto-approved events have high confidence and clear extraction evidence.
- Low-confidence and missing-media entries stay in moderation.

### Milestone B: Reliable Ingestion Operations

- Admin can run "Get New Events" and see a completed job summary.
- Jobs survive partial failures per handle.
- Duplicate cleanup is safe, logged, and tested.

### Milestone C: Moderation Throughput

- Admin can filter by issues, confidence, duplicates, and missing media.
- Bulk operations are reversible or low-risk.
- Master review is reserved for ambiguous duplicate clusters.

### Milestone D: Production Readiness

- Required env vars are validated before deploy.
- Admin routes are protected in production.
- Scheduled ingestion is monitored.
- QA scripts are part of CI.

## Decision Log

- Default stance: favor false negatives over false positives for public event publishing.
- Auto-merge approved duplicates only when date, venue, and identity evidence are strong.
- Keep AI confidence thresholds conservative until there is enough production data to calibrate.
