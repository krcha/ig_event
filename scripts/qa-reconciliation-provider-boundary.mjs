import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(path, "utf8");
}

const canonicalModules = [
  "convex/reconciliation.ts",
  "convex/internal/reconciliationCanonicalEventWriter.ts",
  "convex/internal/reconciliationCanonicalExecutor.ts",
  "convex/internal/reconciliationFullOutcome.ts",
  "convex/internal/reconciliationObservedOutcomeVerifier.ts",
  "convex/internal/reconciliationOccurrenceContext.ts",
  "convex/internal/reconciliationSourceAudit.ts",
  "convex/internal/reconciliationSourceExecutor.ts",
  "convex/internal/reconciliationSourceOutcome.ts",
  "convex/internal/reconciliationSourcePersistence.ts",
  "convex/internal/reconciliationVerificationInputs.ts",
  "lib/domain/reconciliation/engine.ts",
  "lib/domain/reconciliation/evidence-digest.ts",
  "lib/domain/reconciliation/full-outcome.ts",
  "lib/domain/reconciliation/index.ts",
  "lib/domain/reconciliation/manual-review.ts",
  "lib/domain/reconciliation/occurrence-relation.ts",
  "lib/domain/reconciliation/strategies.ts",
  "lib/domain/reconciliation/types.ts",
];

const physicalProviderOwnership =
  /Doc<\s*["']scrapedPosts["']|["']scrapedPosts["']|["']instagramEventSources["']|["']instagramSourceOccurrenceReceipts["']|["']sourceProcessingReceipts["']|normalizeInstagramPostUrl|sourceGroundingInstagramHandle|normalizedVenueInstagramHandle|normalizedSourceAccountHandle|withSourceAccountHandle/u;

for (const path of canonicalModules) {
  assert.doesNotMatch(
    read(path),
    physicalProviderOwnership,
    `${path} must consume the provider-neutral source/provenance boundary instead of owning Instagram persistence or normalization.`,
  );
}

const adapterPath = "convex/repositories/reconciliationSourceContext.ts";
const adapterSource = read(adapterPath);
for (const expectedOwnership of [
  /adaptInstagramScrapedPostToSourceDocument/u,
  /query\("scrapedPosts"\)/u,
  /query\("instagramEventSources"\)/u,
  /query\("instagramSourceOccurrenceReceipts"\)/u,
  /normalizeInstagramPostUrl/u,
  /sourceGroundingInstagramHandle/u,
  /normalizedVenueInstagramHandle/u,
  /readReconciliationVenueAccountIdentity/u,
]) {
  assert.match(
    adapterSource,
    expectedOwnership,
    `${adapterPath} must remain the explicit physical-provider compatibility owner.`,
  );
}

const approvalAdapterSource = read(
  "lib/events/approval-occurrence-conflict.ts",
);
assert.match(approvalAdapterSource, /adaptLegacyApprovalOccurrence/u);
assert.match(approvalAdapterSource, /sourceGroundingInstagramHandle/u);

const executorSource = read(
  "convex/internal/reconciliationSourceExecutor.ts",
);
const auditSource = read("convex/internal/reconciliationSourceAudit.ts");
const outcomeSource = read("convex/internal/reconciliationSourceOutcome.ts");
const writerSource = read(
  "convex/internal/reconciliationCanonicalEventWriter.ts",
);
const canonicalExecutorSource = read(
  "convex/internal/reconciliationCanonicalExecutor.ts",
);
const fullOutcomeSource = read(
  "convex/internal/reconciliationFullOutcome.ts",
);

for (const source of [executorSource, auditSource]) {
  assert.match(source, /loadReconciliationSourceDocument/u);
  assert.match(source, /loadExactReconciliationProvenanceLink/u);
}
assert.match(outcomeSource, /ReconciliationSourceDocument/u);
assert.match(outcomeSource, /ReconciliationProvenanceLink/u);
assert.match(writerSource, /\.canonicalEventFields/u);
assert.doesNotMatch(
  writerSource,
  /sourceDocument\.(?:handle|username|postId|instagramPostUrl|imageUrls)/u,
  "The canonical event writer must apply the neutral source projection, not inspect a physical provider row.",
);
assert.match(
  canonicalExecutorSource,
  /readSourceAccountIdentityFromNormalizedFields/u,
);
assert.match(
  canonicalExecutorSource,
  /readReconciliationVenueAccountIdentity/u,
);
assert.match(
  canonicalExecutorSource,
  /PreparedReconciliationEventTopology/u,
);
assert.doesNotMatch(
  canonicalExecutorSource,
  /EventOccurrenceTopology/u,
  "The canonical executor must retain only an opaque prepared provenance proof.",
);
assert.match(
  fullOutcomeSource,
  /assertReconciliationReceiptSatisfiable/u,
);
assert.match(
  fullOutcomeSource,
  /sourceOccurrenceHasFinalProvenance/u,
);

console.log(
  "Reconciliation provider-boundary QA passed (neutral SourceDocument/provenance contracts, neutral source/venue account identities, opaque topology proof, and adapter-owned physical Instagram compatibility).",
);
