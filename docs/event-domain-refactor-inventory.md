# Event-domain architecture and rollout inventory

## Status

The repository-level architecture is implemented locally. Production remains
unchanged: no deployment, backfill, migration, read/write cutover, or generic
reconciliation enablement has been run from this worktree.

The code deliberately separates two states:

- **Code complete:** domain authorities, bounded migrations, audits, rollback
  controls, and fail-closed cutover mechanisms exist and are tested locally.
- **Production execution pending:** equivalence evidence must be generated from
  production data, reviewed, and enabled in the documented order by an
  operator. Compatibility storage and entrypoints remain until then.

## Authoritative runtime flow

```text
SourceProviderAdapter
  -> SourceDocument
       provider row is discarded; parser DTO is derived from SourceDocument evidence
  -> StructuredFacts
       typed facts are the runtime output, not a projection of a prepared event
  -> SourceOccurrence plan and first-class sourceOccurrences row
  -> Universal VenueResolver + immutable VenueSnapshot
  -> NormalizedOccurrence + versioned OccurrenceSignature
  -> indexed, bounded candidate repository
  -> ReconciliationStrategy registry
  -> ReconciliationDecision + immutable ReconciliationPlan
  -> server-generated complete-outcome verification
  -> rollout-gated generic reconciliation executor
  -> CanonicalEvent compatibility row + provenance + receipts + saves
  -> shared moderation policy
  -> materialized publication policy and visibility-safe pagination
```

`scrapedPosts` remains the physical Instagram SourceDocument table. The
provider adapter constructs a generic `SourceDocument`; acquisition no longer
carries a parallel provider row through the boundary. The temporary Instagram
parser DTO is reconstructed from `SourceDocument.evidence`, canonical source,
account, publication time, and opaque provider metadata. Persisted source rows
cross the same adapter before parsing.

Canonical reconciliation crosses a second explicit compatibility adapter in
`convex/repositories/reconciliationSourceContext.ts`. It projects the physical
source document, legacy provenance/receipt topology, source-account identity,
and legacy venue-account identity into provider-neutral contracts. The domain
classifier never reads Instagram tables, URL normalizers, or legacy JSON/venue
handle fields; the approval compatibility wrapper adapts older normalized JSON
before invoking that classifier. A release-gated static QA check enforces this
ownership boundary.

## Facades and cohesive owners

- `convex/events.ts` is a registered compatibility facade (about 885 lines),
  down from 10,327 lines in `HEAD`. Its implementations live in cohesive
  `convex/eventDomain/*`, repository, publication, and internal-repair modules.
- `lib/pipeline/run-instagram-ingestion.ts` is an orchestration/export facade
  (about 89 lines), down from 13,572 lines in `HEAD`.
- `convex/reconciliation.ts` is a 128-line registered internal API facade.
  Context decoding, outcome generation, canonical writes, provenance
  persistence, auditing, verification, and orchestration have separate owners
  under `convex/internal/reconciliation*`.
- Structured fact production, finalization, occurrence construction,
  persistence adaptation, and post-processing are separate modules. The
  post-processor and structured-facts producer are each well below the
  replacement-god-module guardrail.
- Venue normalization/evidence precedence is authoritative in
  `lib/domain/venues/normalization.ts`; the old
  `lib/pipeline/venue-normalization.ts` path is a thin re-export facade.

No new TypeScript file exceeds 1,500 lines. Existing pre-refactor operational
modules such as `convex/scrapedPosts.ts` and `convex/durableIngestionRuns.ts`
remain large, but this refactor did not move event-domain authority into them.

## Domain authority matrix

| Concept                     | Authoritative implementation                                                                                                    | Remaining compatibility or migration surface                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Source URL identity         | `lib/domain/source-url.ts`; strict mutation guard in `convex/eventDomain/sourceUrlPolicy.ts`                                    | Bounded malformed legacy read/comparison fallbacks; historical repair scripts only                                     |
| SourceDocument identity     | `lib/domain/source-documents.ts` and `lib/pipeline/ingestion/source-provider.ts`                                                | `scrapedPosts` is the physical Instagram table; parser DTO is an adapter output                                        |
| StructuredFacts             | `lib/domain/occurrences/types.ts` and `lib/pipeline/ingestion/structured-facts.ts`                                              | `structured-fact-persistence.ts` converts facts to the existing event-write contract                                   |
| SourceOccurrence identity   | `buildSourceDocumentIdentity` plus typed fact occurrence construction and `convex/sourceOccurrences.ts`                         | Legacy event occurrence fields, source links, and receipt arrays remain dual-written                                   |
| Venue resolution            | `lib/domain/venues/normalization.ts`, `venue-resolver.ts`, and request-scoped snapshots                                         | Pipeline import path is a thin facade; alias seeds are migration-only data                                             |
| OccurrenceSignature         | `lib/domain/occurrences/signature.ts`                                                                                           | Legacy indexed fields remain during backfill                                                                           |
| Candidate retrieval         | `convex/repositories/occurrenceCandidates.ts`                                                                                   | Exact legacy source lookup is the first bounded compatibility tier                                                     |
| Relationship classification | `lib/domain/reconciliation/occurrence-relation.ts` and `strategies.ts`                                                          | `approval-occurrence-conflict.ts` is a thin wrapper; the legacy ingestion selector is a declared pre-cutover exception |
| Reconciliation execution    | `convex/internal/reconciliationSourceExecutor.ts` plus canonical executor/writer and verifier modules                           | Specialized composite operations listed below; production apply remains disabled                                       |
| Moderation                  | `lib/domain/moderation/policy.ts` and `convex/eventDomain/moderationCommands.ts`                                                | Existing API and `events` exports are thin callers                                                                     |
| Publication                 | `lib/domain/publication/policy.ts`, `convex/publicationPolicy.ts`, `convex/publicationCutover.ts`, `eventDomain/publicReads.ts` | Compatibility indexed window remains available for rollback                                                            |
| Saved events                | `convex/repositories/savedEvents.ts`                                                                                            | `userSavedEvents` remains migration/rollback storage                                                                   |
| Historical repairs          | `convex/internal/eventRepairs/*`                                                                                                | Tiny `eventDomain` re-exports and existing registered API names remain until callers retire                            |

## Reconciliation architecture

The generic plan can express `create`, `attach`, `update`, `merge`, `coalesce`,
`keep_distinct`, and `manual_review`. Apply never trusts a frontend decision or
an old plan. The server reloads the occurrence, source revision/fingerprint,
candidate set and versions, venue binding, topology epoch, provenance, receipt
facts, saves, and publication inputs before it regenerates the decision and
plan in the mutation.

Rollout authorization is action-scoped. Create/attach/update capabilities are
earned only from a complete bounded server verification run. Merge/coalesce
require a separate server-produced consolidation proof plus explicit human
digest authorization. Operator reports and test-seeded counters cannot enable
apply. Any input write or topology change outside the proven frontier closes
the gate.

### Fail-closed reconciliation controls

Generic apply authorization and ingestion write authority are separate durable
gates. `authorizeServerVerifiedReconciliationRollout` enables only reviewed
generic operations; it always leaves the optional `ingestionApplyEnabled`
field false. A second digest/run/update-fenced internal mutation,
`enableServerVerifiedReconciliationIngestionApply`, repeats prerequisite,
immutable-input, receipt-topology, and exact topology-epoch checks before it can
enable ingestion writes. Ingress selects the generic authority only through the
non-throwing `reconciliationIngestionApplyIsEnabled` helper and reasserts the
specific operation inside the write transaction.

`disableServerVerifiedReconciliationRollout` is the emergency reverse
transition. It requires the exact current digest, run ID, and update fence, but
deliberately does not require a healthy live topology; it atomically clears both
operator and ingestion apply and moves the rollout to `blocked`. An interrupted
or drifted `scanning` run can be moved to the same disabled state with
`abandonReconciliationRolloutVerification`, which clears its cursor so a later
explicit restart cannot accidentally resume stale evidence. Neither control can
enable apply. `getReconciliationRolloutStatus` exposes one bounded, read-only
singleton snapshot for orchestration, including prerequisite, receipt-topology,
epoch, operation-capability, and both apply-gate states.

### Specialized mutation exceptions

| Operation                                      | Why it remains specialized                                                                                                                     | Safety owner and retirement condition                                                                                                                          |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Campaign aggregate coalescing/re-attestation   | Composite immutable campaign lineage, content aggregation, multiple receipts, and rollback attestation exceed a pairwise exact-equivalent plan | `convex/eventDomain/crossPostPromotion.ts` and campaign re-attestation migration; migrate only when generic plans represent the complete composite attestation |
| Nightlife lineup coalescing                    | Builds one timetable from distinct performer fragments while preserving multi-row lineage                                                      | `convex/eventDomain/nightlifeLineup.ts`; retire only after a generic composite-lineup action has final-state equivalence proof                                 |
| Admin/service reviewed merge                   | Existing API accepts an explicitly reviewed content patch and has a stable operator contract                                                   | `convex/eventDomain/lifecycleCommands.ts`; remains a compatibility path until admin callers use reviewed generic consolidation plans                           |
| Reviewed schedule/promotion/continuation folds | Historical, evidence-specific correction and exact rollback workflows                                                                          | Implementations are isolated in `convex/internal/eventRepairs/*`; only thin registered compatibility exports remain                                            |

The legacy ingestion occurrence matcher is also an explicit migration
exception. It assigns ambiguous multi-row receipt keys and permits a narrowly
fenced unverified-pending representative check that the canonical relationship
strategy intentionally does not claim. Its concrete retirement gate is:
`source-occurrence-reconciliation-apply-v1` reviewed for create, attach, and
update, followed by an atomic switch of ingestion writes to
`reconciliation:executeSourceOccurrence`.

## Historical repair boundary

All reviewed replay, rollback, one-off venue repair, source-grounding repair,
schedule/promotion/continuation fold, and approved-legacy-venue implementations
live under `convex/internal/eventRepairs`. `convex/eventDomain` contains only
small compatibility re-exports for these operations. Architecture QA prevents
those facades from regaining database, authentication, or async implementation.

## Migration and cutover matrix

| Durable key or workflow                     | Code-complete proof                                                                                                     | Production state                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `source-document-canonical-url-v1`          | Bounded canonical URL backfill with mismatch/error accounting                                                           | Not run                                               |
| `media-canonical-url-v1`                    | Bounded durable-media canonicalization                                                                                  | Not run                                               |
| `canonical-event-domain-fields-v1`          | Occurrence signature/index and publication fields                                                                       | Not run                                               |
| `venue-compatibility-seed-audit-v1`         | Proves exactly one durable venue target per compatibility seed and rejects duplicate claims                             | Not run                                               |
| `venue-identities-v1`                       | Indexed canonical names, aliases, historical aliases, and provider accounts                                             | Not run                                               |
| `campaign-lineage-reattestation-v1`         | Dry-run-capable, bounded, resumable, idempotent proof against immutable source evidence; insufficient rows quarantine   | Not run                                               |
| `event-venue-bindings-v1`                   | Canonical venue binding with ordinary and verified-campaign evidence paths                                              | Not run                                               |
| `source-occurrences-generic-v2`             | First-class occurrences from legacy links/receipts with campaign proof support                                          | Not run                                               |
| `source-occurrence-canonical-payload-v1`    | Canonical materialization payload attestation/backfill for exact create/update counterfactual verification               | Not run                                               |
| `source-occurrence-receipt-topology-v1`     | Epoch-fenced complete reverse-discoverability audit; destructive topology operations fail closed                        | Not run                                               |
| `saved-events-legacy-to-canonical-v1`       | Additive backfill, conflict/timestamp/duplicate audit, separately reviewed read and write cutovers, rollback generation | Not run; dual mode retained                           |
| `materialized-publication-v1`               | Backfill, policy/version parity audit, venue/identity dependency frontier, reviewed indexed-read cutover and rollback   | Not run; compatibility reads retained                 |
| `source-occurrence-reconciliation-apply-v1` | Full-outcome server scan, run-wide input/topology fence, action capabilities, consolidation proof, human review         | Disabled; no production verification or authorization |

All migrations are bounded and resumable. Dry-run or preview phases do not
authorize a cutover. Legacy tables and fields are not deleted by these flows.

The canonical source-document migration has one non-destructive historical
exception: an exact pre-August-2026 record shape for bare Instagram profile
snapshots that the retired discovery path had already classified as terminal
non-events. Those rows are retained unchanged and counted under
`legacy_instagram_profile_snapshot`. Any profile-shaped row with post evidence,
any row after the fixed cutoff, and every other malformed URL remains a
blocking mismatch. Current scraped-post writes require the central canonical
Instagram post URL policy, so the exception cannot admit new profile rows.

## Production operator driver

`scripts/event-domain-rollout-operator.mjs` is the only packaged driver for
these migrations and cutovers. It never deploys code, passes `--push`, selects
`--prod`, implicitly enables reconciliation, or retires compatibility storage. It accepts
only an absolute, mode-private env file containing exactly
`CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY`; any
`CONVEX_DEPLOYMENT`, deploy key, URL mismatch, duplicate state, nonzero
mismatch/error count, stale state version, cursor stall, page bound, or command
failure stops the run. Every command and gate is written atomically to a
mode-private, secret-redacted receipt.

After backup/rollback artifacts are verified, deploy the reviewed additive
schema and functions as a separate rollback point. The deploy dry-run and the
actual deploy must use the same reviewed self-hosted env file:

```bash
npm run qa:release
./node_modules/.bin/convex deploy --env-file "$EVENT_ZEKA_CONVEX_ENV" --dry-run --typecheck disable --codegen disable
./node_modules/.bin/convex deploy --env-file "$EVENT_ZEKA_CONVEX_ENV" --yes --typecheck disable --codegen disable
```

Set `EVENT_ZEKA_CONVEX_ENV` to the absolute 0600 env-file path,
`EVENT_ZEKA_CONVEX_URL` to its exact self-hosted URL, and
`EVENT_ZEKA_ROLLOUT_RECEIPTS` to an absolute 0700 directory. Capture status
before and after every stage:

```bash
npm run ops:event-domain-rollout -- status \
  --env-file "$EVENT_ZEKA_CONVEX_ENV" \
  --expected-url "$EVENT_ZEKA_CONVEX_URL" \
  --receipt-dir "$EVENT_ZEKA_ROLLOUT_RECEIPTS"
```

Run migration workflows in this exact order: `canonical`, `venues`,
`occurrences`, `saved-events`, `publication`, then `reconciliation`. Use this
invocation for one workflow at a time, substituting only the workflow name.
Every apply performs its own complete dry-run before writing and a zero-update
postflight afterward; standalone `preview` is available when the workflow's
earlier durable prerequisites already exist.

```bash
npm run ops:event-domain-rollout -- apply \
  --env-file "$EVENT_ZEKA_CONVEX_ENV" \
  --expected-url "$EVENT_ZEKA_CONVEX_URL" \
  --receipt-dir "$EVENT_ZEKA_ROLLOUT_RECEIPTS" \
  --workflow canonical \
  --confirm APPLY_EVENT_DOMAIN_ROLLOUT
```

`saved-events` and `publication` stop in `ready_for_review`. Read the exact
`updatedAt` from a new status receipt, review the equivalence evidence, then
use the corresponding explicit transition. Saved reads precede saved writes;
publication has only a read cutover.

```bash
npm run ops:event-domain-rollout -- apply \
  --env-file "$EVENT_ZEKA_CONVEX_ENV" --expected-url "$EVENT_ZEKA_CONVEX_URL" \
  --receipt-dir "$EVENT_ZEKA_ROLLOUT_RECEIPTS" \
  --workflow saved-read-cutover --confirm ENABLE_SAVED_EVENT_READ_CUTOVER \
  --expected-state-updated-at "$EXACT_STATE_UPDATED_AT" \
  --operator "$ROLLOUT_OPERATOR" --note "$ROLLOUT_REVIEW_NOTE"

npm run ops:event-domain-rollout -- apply \
  --env-file "$EVENT_ZEKA_CONVEX_ENV" --expected-url "$EVENT_ZEKA_CONVEX_URL" \
  --receipt-dir "$EVENT_ZEKA_ROLLOUT_RECEIPTS" \
  --workflow saved-write-cutover --confirm ENABLE_SAVED_EVENT_WRITE_CUTOVER \
  --expected-state-updated-at "$EXACT_STATE_UPDATED_AT" \
  --operator "$ROLLOUT_OPERATOR" --note "$ROLLOUT_REVIEW_NOTE"

npm run ops:event-domain-rollout -- apply \
  --env-file "$EVENT_ZEKA_CONVEX_ENV" --expected-url "$EVENT_ZEKA_CONVEX_URL" \
  --receipt-dir "$EVENT_ZEKA_ROLLOUT_RECEIPTS" \
  --workflow publication-read-cutover \
  --confirm ENABLE_PUBLICATION_READ_CUTOVER \
  --expected-state-updated-at "$EXACT_STATE_UPDATED_AT" \
  --operator "$ROLLOUT_OPERATOR" --note "$ROLLOUT_REVIEW_NOTE"
```

The `reconciliation` apply workflow performs only the bounded server
verification and stops at `ready_for_human_review_not_authorized`. Enabling is
two later, separately confirmed transitions. Each requires all three exact
state fences and the absolute path to a completed matching `status` receipt in
the same receipt directory. Run and review a new status receipt before each
transition; after generic authorization, capture a second status receipt and
use its newly advanced `updatedAt` for the ingestion transition.

```bash
npm run ops:event-domain-rollout -- apply \
  --env-file "$EVENT_ZEKA_CONVEX_ENV" --expected-url "$EVENT_ZEKA_CONVEX_URL" \
  --receipt-dir "$EVENT_ZEKA_ROLLOUT_RECEIPTS" \
  --workflow reconciliation-authorize \
  --confirm AUTHORIZE_RECONCILIATION_ROLLOUT \
  --expected-state-updated-at "$EXACT_STATE_UPDATED_AT" \
  --expected-evidence-digest "$EXACT_EVIDENCE_DIGEST" \
  --expected-verification-run-id "$EXACT_VERIFICATION_RUN_ID" \
  --reviewed-status-receipt "$REVIEWED_STATUS_RECEIPT" \
  --operator "$ROLLOUT_OPERATOR" --note "$ROLLOUT_REVIEW_NOTE"

npm run ops:event-domain-rollout -- apply \
  --env-file "$EVENT_ZEKA_CONVEX_ENV" --expected-url "$EVENT_ZEKA_CONVEX_URL" \
  --receipt-dir "$EVENT_ZEKA_ROLLOUT_RECEIPTS" \
  --workflow reconciliation-ingestion-enable \
  --confirm ENABLE_RECONCILIATION_INGESTION_APPLY \
  --expected-state-updated-at "$EXACT_STATE_UPDATED_AT" \
  --expected-evidence-digest "$EXACT_EVIDENCE_DIGEST" \
  --expected-verification-run-id "$EXACT_VERIFICATION_RUN_ID" \
  --reviewed-status-receipt "$REVIEWED_STATUS_RECEIPT" \
  --operator "$ROLLOUT_OPERATOR" --note "$ROLLOUT_REVIEW_NOTE"
```

Neither transition is part of `all` or `reconciliation`; the verifier can
never invoke them. Emergency disable and interrupted-scan abandonment are
available only with all three exact state fences from a current status receipt:

```bash
npm run ops:event-domain-rollout -- apply \
  --env-file "$EVENT_ZEKA_CONVEX_ENV" --expected-url "$EVENT_ZEKA_CONVEX_URL" \
  --receipt-dir "$EVENT_ZEKA_ROLLOUT_RECEIPTS" \
  --workflow reconciliation-disable \
  --confirm DISABLE_RECONCILIATION_ROLLOUT \
  --expected-state-updated-at "$EXACT_STATE_UPDATED_AT" \
  --expected-evidence-digest "$EXACT_EVIDENCE_DIGEST" \
  --expected-verification-run-id "$EXACT_VERIFICATION_RUN_ID" \
  --operator "$ROLLOUT_OPERATOR" --note "$ROLLOUT_ROLLBACK_NOTE"
```

Saved/publication rollback uses the same exact `updatedAt`, named operator, and
note contract with workflow/confirmation pairs
`saved-cutover-rollback`/`ROLLBACK_SAVED_EVENT_CUTOVER` and
`publication-cutover-rollback`/`ROLLBACK_PUBLICATION_READ_CUTOVER`.
`reconciliation-abandon` uses the same three reconciliation fences with
`ABANDON_RECONCILIATION_VERIFICATION`.

```bash
npm run ops:event-domain-rollout -- apply \
  --env-file "$EVENT_ZEKA_CONVEX_ENV" --expected-url "$EVENT_ZEKA_CONVEX_URL" \
  --receipt-dir "$EVENT_ZEKA_ROLLOUT_RECEIPTS" \
  --workflow saved-cutover-rollback --confirm ROLLBACK_SAVED_EVENT_CUTOVER \
  --expected-state-updated-at "$EXACT_STATE_UPDATED_AT" \
  --operator "$ROLLOUT_OPERATOR" --note "$ROLLOUT_ROLLBACK_NOTE"

npm run ops:event-domain-rollout -- apply \
  --env-file "$EVENT_ZEKA_CONVEX_ENV" --expected-url "$EVENT_ZEKA_CONVEX_URL" \
  --receipt-dir "$EVENT_ZEKA_ROLLOUT_RECEIPTS" \
  --workflow publication-cutover-rollback \
  --confirm ROLLBACK_PUBLICATION_READ_CUTOVER \
  --expected-state-updated-at "$EXACT_STATE_UPDATED_AT" \
  --operator "$ROLLOUT_OPERATOR" --note "$ROLLOUT_ROLLBACK_NOTE"

npm run ops:event-domain-rollout -- apply \
  --env-file "$EVENT_ZEKA_CONVEX_ENV" --expected-url "$EVENT_ZEKA_CONVEX_URL" \
  --receipt-dir "$EVENT_ZEKA_ROLLOUT_RECEIPTS" \
  --workflow reconciliation-abandon \
  --confirm ABANDON_RECONCILIATION_VERIFICATION \
  --expected-state-updated-at "$EXACT_STATE_UPDATED_AT" \
  --expected-evidence-digest "$EXACT_EVIDENCE_DIGEST" \
  --expected-verification-run-id "$EXACT_VERIFICATION_RUN_ID" \
  --operator "$ROLLOUT_OPERATOR" --note "$ROLLOUT_ROLLBACK_NOTE"
```

For an ordinary command failure, rerun the identical command with
`--resume /absolute/path/to/failed-receipt.json`; target, binary, workflow,
page bound, restart keys, and review fences must match. A stale lock after an
unclean process death is intentionally not removed automatically: first prove
the recorded process is gone, capture read-only status, reconcile the receipt
with durable state, and only then clear the lock under an incident record.

## Compatibility-data lifecycle

`lib/config/legacy-venue-alias-seeds.ts` is marked **LEGACY COMPATIBILITY
ONLY**. Runtime ingestion does not import it. The seed audit and venue-identity
migration turn reviewed aliases into durable `manual` identity rows. The data
can be removed only after production seed audit, identity migration, and venue
binding equivalence are clean. New venue facts must be added as durable venue
identities, not as application branches.

## Required production sequence

1. Deploy additive schema/code with reconciliation apply and all read/write
   cutovers disabled.
2. Backfill and audit canonical source/media URLs and canonical event fields.
3. Run the venue compatibility seed audit, venue identity migration, campaign
   lineage re-attestation, and event venue binding migration; quarantine rather
   than guess when evidence is insufficient.
4. Backfill first-class source occurrences, attest/backfill canonical event
   payloads, then complete a stable epoch-fenced receipt-topology audit.
5. Backfill/audit saved events, review and enable canonical reads, observe,
   then separately review canonical writes. Roll back through the retained dual
   repository if equivalence drifts.
6. Backfill/audit materialized publication, prove a stable dependency frontier,
   review indexed reads, and retain compatibility pagination for rollback.
7. Run full server reconciliation verification for the complete occurrence
   corpus. Review action-scoped evidence; separately prove and authorize
   merge/coalesce. Keep the separate ingestion gate disabled and begin only a
   limited staged generic apply after monitoring is ready.
8. Switch ingestion writes to the generic executor only after create/attach/
   update proof is clean, the bounded status snapshot is reviewed, and the
   separately fenced ingestion gate is enabled. Retain the explicit disable and
   abandoned-scan recovery paths; then retire the legacy ingestion matcher.
9. Remove legacy storage, wrappers, and specialized compatibility executors in
   later releases only after sustained production evidence.

## Remaining risks

- Production data may contain venue-seed ambiguity, incomplete immutable
  campaign evidence, source receipt topology gaps, save timestamp conflicts, or
  publication drift. Every corresponding migration fails closed.
- Generic apply is implemented but unverified against the production corpus;
  it remains disabled by design.
- Specialized campaign/lineup/admin merge semantics are not falsely modeled as
  exact generic pairwise actions.
- Embedded legacy receipt arrays remain a compatibility read cost until the
  first-class source-occurrence cutover is proven.
- Dynamic grounding remains available in compatibility paths and has higher
  per-event read cost than the materialized publication index.
- Convex codegen/schema validation still requires a safe non-production Convex
  deployment configuration; local static validation does not substitute for it.
