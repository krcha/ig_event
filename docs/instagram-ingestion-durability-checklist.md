# Durable Instagram ingestion implementation checklist

Updated: 2026-07-27 (Europe/Belgrade)

This checklist tracks the end-to-end Event Zeka ingestion hardening requested for delivery to `main` and production. A checked implementation item still requires focused tests, release QA, exact-head review, rollout, and production proof before the corresponding release stage is complete.

## Safety and audit

- [x] Read `AGENTS.md` and `INSTRUCTIONS.md` completely.
- [x] Inspect branch, status, recent history, staged/unstaged diffs, and `origin/main` relationship.
- [x] Preserve the existing dirty ingestion-fencing work; do not create a competing implementation.
- [x] Pause only the paid 07:00 UTC / 09:00 Belgrade ingestion cron; retain weekly following discovery and unrelated schedules.
- [ ] Trace acquisition, persistence, processing, extraction, occurrence receipts, approval, canonicalization, public reads, and cron continuation end to end.
- [ ] Reconcile every requested behavior with an implementation and deterministic oracle.

## Source model and following synchronization

- [ ] Add additive ingestion-source roles: `venue`, `promoter`, `unknown`.
- [ ] Allow venue-role sources to map to canonical venues without changing existing venue identity or manual fields.
- [ ] Prevent promoter/unknown source ownership from becoming public venue evidence.
- [ ] Keep weekly cached-following synchronization and protected manual synchronization.
- [ ] Upsert/reactivate newly followed handles idempotently as `unknown` unless reliably mapped.
- [ ] Deactivate only after a complete, successful, uncapped following snapshot; record synchronization state and `lastSeenFollowingAt`.
- [ ] Provide bounded bootstrap ingestion for newly discovered sources without exposing them as venues.

## Incremental acquisition and cost controls

- [ ] Persist per-source successful checkpoints whose meaning is complete fetch-through time.
- [ ] Use inclusive overlap, stable post ID then normalized URL, and a 10-day no-checkpoint bootstrap.
- [ ] Fetch up to page-size 5 / per-source 50 and persist continuation without advancing incomplete checkpoints.
- [ ] Prove provider failure, timeout, malformed/partial result, cap, budget exhaustion, interruption, and lease loss preserve checkpoints.
- [ ] Acquire one global paid-fetch lease and atomically reserve/reconcile daily Apify budget before every request.
- [ ] Enforce default paid switch, `$2.00` daily budget, and `$0.01` maximum reservation per handle.
- [ ] Defer remaining sources fairly and report reserved/charged/released/remaining/deferred metrics.

## Saved-post-first processing

- [ ] Atomically block paid acquisition while any discovered, expired-processing, due-retry, or legacy-unknown row is processable.
- [ ] Persist explicit outcomes: discovered, processing, non-event, event-created, duplicate-linked, pending-review, retryable failure, terminal failure.
- [ ] Persist revision/fingerprint, owner/lease, attempts, categorized errors, retry time, timestamps, result event IDs, model/version, and terminal reason.
- [ ] Fence every raw, event, receipt, media, approval, and finalizer write by current owner, unexpired lease, and source revision.
- [ ] Reopen materially changed evidence once; skip unchanged terminal revisions before OpenAI.
- [ ] Add idempotent dry-run/bounded legacy migration and prevent infinite legacy replay.

## OpenAI, moderation, occurrences, and canonical events

- [ ] Use one structured OpenAI classification/extraction request per unseen revision.
- [ ] Reuse durable normalized media, deduplicate carousel images, and enforce a five-image limit.
- [ ] Enforce 300 daily post calls, three per-post attempts, retry backoff, and a durable provider-wide circuit with controlled half-open probe.
- [ ] Persist OpenAI request/model/token/estimated-cost metrics without logging captions or secrets.
- [ ] Make definite non-events terminal without creating moderation/event rows.
- [ ] Allow clear poster or caption evidence to auto-approve at 0.78 when exact future date, supported venue, meaningful identity, and no critical conflicts are present.
- [ ] Do not block solely on missing time, price, or artists; generate only deterministic supported display titles and mark them generated.
- [ ] Keep ambiguous date/venue, conflicting evidence, unresolved promoter venue, and inseparable multi-event posts pending.
- [ ] Persist exact expected/satisfied/deferred child receipts and repair only missing occurrences after interruption.
- [ ] Keep exact-source idempotency separate from conservative semantic duplicate linking.
- [ ] Maintain one canonical event with all source post IDs/URLs and strongest compatible evidence; never merge solely on venue/date.
- [ ] Preserve moderation/audit/saved-event references transactionally and keep ambiguous real-world matches separate.

## Orchestration, public reads, migration, and release

- [ ] Implement saved-first daily ordering, explicit partial/deferred statuses, durable continuation, and structured metrics.
- [ ] Prove only approved future events appear on all public event/calendar readers.
- [ ] Add compatible additive schema and dry-run/bounded backfill; document deploy/rollback ordering.
- [ ] Add every deterministic acceptance fixture listed in the delivery specification.
- [ ] Run focused tests after each phase and resolve failures before continuing.
- [ ] Run `npm run convex:codegen`, `npm run qa:release`, and `git diff --check` on the frozen final tree.
- [ ] Complete independent spec and adversarial quality/data-integrity review on the exact final snapshot.
- [ ] Fetch/integrate current `origin/main` non-destructively, rerun QA, commit cohesive changes, push normally to `main`, verify remote SHA, and monitor CI.
- [ ] Deploy Convex functions/schema first, then application; run migration dry-run and bounded batch.
- [ ] Prove saved-only processing with zero Apify calls, run five-source canary, verify data/cost/circuit/checkpoint/public behavior, drain backlog, resume paid cron, and monitor the first complete run.

## Current evidence / blockers

- The existing branch is `fix/76-repeated-event-caption`, 12 commits ahead of the previously fetched `origin/main`, with seven dirty files containing partial fencing/media/receipt work.
- The paid ingestion cron was paused at `/etc/cron.d/ig_event`; the backup is `/root/backups/ig-event-paid-cron-pause-20260726T224015Z/ig_event.before`. Weekly following discovery remains active.
- Baseline `npm run typecheck` passed. Baseline `npm run qa:extraction` failed in the dirty worktree because the new scraped-post mock does not implement the Convex `.first()` query path; this is a release blocker to repair before broader QA.
