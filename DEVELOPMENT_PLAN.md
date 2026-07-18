# Event Zeka Development Plan

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

- Required deterministic checks: lint, typecheck, `next build`, `qa:dedupe`, `qa:automerge`, master-review QA, `qa:extraction`, ingestion triage QA, venue taxonomy QA, public search QA, and Apify cost-control QA.
- Keep `next build` in the required gate and treat failures or timeouts as release blockers.
- Bound long-running local checks so hung tooling is treated as a failure.
- Keep environment-dependent checks documented separately from code regressions.
- Do not ship with failing deterministic QA.

### 6. Self-Hosted Convex Operations

Goal: Move Convex off Convex Cloud without rewriting the data layer.

- Run Convex backend/dashboard as separate services in the same Docker Compose
  project as the web app.
- Keep `NEXT_PUBLIC_CONVEX_URL` public and browser-reachable.
- Preserve Convex schema/functions/generated types and existing ingestion flows.
- Document cloud export/import, admin key handling, backups, upgrades, and
  rollback before production cutover.

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
- Added `qa:release` and a GitHub Actions release gate, including `next build`.
- Added a self-hosted Convex Compose overlay and runbook so Convex can move to
  the VPS without replacing the Convex API/data model.

Known follow-up:

- Verify Docker image builds in CI or a clean shell with production public env
  values after the deterministic release gate is green.

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
