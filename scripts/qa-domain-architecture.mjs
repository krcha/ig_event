import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function read(path) {
  return readFileSync(path, "utf8");
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/u.test(entry.name) ? [path] : [];
  });
}

function lineCount(path) {
  return read(path).split(/\r?\n/u).length;
}

const runnerSource = read("lib/pipeline/run-instagram-ingestion.ts");
assert.ok(
  lineCount("lib/pipeline/run-instagram-ingestion.ts") < 250,
  "The ingestion entrypoint must remain a facade/orchestrator, not regain parser and persistence ownership.",
);
assert.match(runnerSource, /pipeline\/ingestion\/batch-orchestrator/u);
assert.match(runnerSource, /pipeline\/ingestion\/structured-facts/u);
assert.doesNotMatch(runnerSource, /function parse(?:Date|Time|Schedule)/u);

const providerSource = read("lib/pipeline/ingestion/source-provider.ts");
const sourceDocumentsSource = read(
  "lib/pipeline/ingestion/source-documents.ts",
);
const sourceDocumentDomainSource = read("lib/domain/source-documents.ts");
const sourceOccurrencePlanningSource = read(
  "lib/pipeline/source-occurrence-planning.ts",
);
const freshFetchSource = read("lib/pipeline/ingestion/fresh-fetch.ts");
assert.match(providerSource, /interface SourceProviderAdapter/u);
assert.match(providerSource, /instagramSourceProviderAdapter/u);
assert.match(providerSource, /adaptInstagramScrapedPostToSourceDocument/u);
assert.match(providerSource, /documents: providerRows\.map/u);
assert.match(providerSource, /loadRecentInstagramSourceDocuments/u);
assert.match(providerSource, /projectForCompatibilityParser/u);
assert.doesNotMatch(
  providerSource,
  /compatibilityDocument/u,
  "Provider rows must not bypass SourceDocument through a parallel compatibility payload.",
);
assert.match(providerSource, /document\.evidence\.caption/u);
assert.match(providerSource, /document\.evidence\.mediaUrls/u);
assert.match(sourceDocumentsSource, /mapSavedScrapedPostToSourceDocument/u);
assert.match(
  sourceDocumentsSource,
  /scrapedPosts` is the persisted Instagram implementation/u,
);
assert.match(
  sourceDocumentsSource,
  /projectForCompatibilityParser\(\s*mapSavedScrapedPostToSourceDocument\(record\)/u,
  "Persisted parser inputs must cross the SourceDocument boundary too.",
);
assert.match(
  sourceDocumentDomainSource,
  /function buildSourceDocumentIdentity/u,
);
assert.match(sourceOccurrencePlanningSource, /buildSourceDocumentIdentity/u);
assert.doesNotMatch(
  sourceOccurrencePlanningSource,
  /return `instagram-source-identity-v1:/u,
  "Occurrence planning must not own a second source-identity implementation.",
);
assert.match(freshFetchSource, /sourceBatch\.documents\.map/u);
assert.match(freshFetchSource, /fetchedSourceIdentities/u);

for (const path of [
  ...sourceFiles("lib/pipeline/ingestion"),
  ...sourceFiles("convex/eventDomain"),
  ...sourceFiles("convex/internal/eventRepairs"),
  ...sourceFiles("convex/internal/migrations"),
  ...sourceFiles("lib/domain/reconciliation"),
  ...sourceFiles("lib/domain/venues"),
]) {
  assert.ok(
    lineCount(path) <= 1_500,
    `${path} exceeds the replacement-god-module guardrail.`,
  );
}

const migrationFacadePath = "convex/internal/migrations/eventDomain.ts";
const migrationFacadeSource = read(migrationFacadePath);
const migrationResponsibilityModules = {
  canonicalFields: read("convex/internal/migrations/canonicalFields.ts"),
  eventDomainShared: read("convex/internal/migrations/eventDomainShared.ts"),
  eventVenueBindings: read("convex/internal/migrations/eventVenueBindings.ts"),
  sourceOccurrenceBackfill: read(
    "convex/internal/migrations/sourceOccurrenceBackfill.ts",
  ),
  sourceOccurrenceCanonicalPayload: read(
    "convex/internal/migrations/sourceOccurrenceCanonicalPayload.ts",
  ),
  sourceOccurrenceTopologyAudit: read(
    "convex/internal/migrations/sourceOccurrenceTopologyAudit.ts",
  ),
  venueIdentity: read("convex/internal/migrations/venueIdentity.ts"),
};
assert.ok(
  lineCount(migrationFacadePath) <= 120,
  "The registered event-domain migration API must remain a thin facade.",
);
for (const moduleName of Object.keys(migrationResponsibilityModules)) {
  assert.match(
    migrationFacadeSource,
    new RegExp(`from ["']\\./${moduleName}["']`, "u"),
    `The migration facade must delegate to ${moduleName}.`,
  );
}
assert.doesNotMatch(
  migrationFacadeSource,
  /ctx\.db|canonicalizeSourceUrl|LEGACY_VENUE_ALIAS_SEEDS|rebindCanonicalVenue|syncSourceOccurrencePlan|finalizeSourceOccurrenceTopologyAudit/u,
  "The registered migration facade must not regain migration implementation.",
);
assert.doesNotMatch(
  migrationResponsibilityModules.eventDomainShared,
  /internalMutation|scrapedPosts|mediaAssets|venueIdentities|instagramEventSources|sourceOccurrences|instagramSourceOccurrenceReceipts/u,
  "Shared migration infrastructure must not own a domain-specific migration.",
);
assert.match(
  migrationResponsibilityModules.canonicalFields,
  /backfillSourceDocumentCanonicalUrlsBatchHandler[\s\S]*backfillMediaCanonicalUrlsBatchHandler[\s\S]*backfillCanonicalEventFieldsBatchHandler/u,
);
assert.doesNotMatch(
  migrationResponsibilityModules.canonicalFields,
  /LEGACY_VENUE_ALIAS_SEEDS|rebindCanonicalVenue|syncSourceOccurrencePlan|finalizeSourceOccurrenceTopologyAudit/u,
  "Canonical-field migrations must not own venue or occurrence topology work.",
);
assert.match(
  migrationResponsibilityModules.venueIdentity,
  /auditVenueCompatibilitySeedsHandler[\s\S]*backfillVenueIdentitiesBatchHandler/u,
);
assert.doesNotMatch(
  migrationResponsibilityModules.venueIdentity,
  /rebindCanonicalVenue|syncSourceOccurrencePlan|finalizeSourceOccurrenceTopologyAudit/u,
  "Venue identity migration must not own event binding or occurrence topology work.",
);
assert.match(
  migrationResponsibilityModules.eventVenueBindings,
  /backfillEventVenueBindingsBatchHandler[\s\S]*rebindCanonicalVenue[\s\S]*event-venue-bindings-v1/u,
);
assert.doesNotMatch(
  migrationResponsibilityModules.eventVenueBindings,
  /LEGACY_VENUE_ALIAS_SEEDS|syncSourceOccurrencePlan|finalizeSourceOccurrenceTopologyAudit/u,
  "Event venue binding migration must stay focused on provenance-safe binding.",
);
assert.match(
  migrationResponsibilityModules.sourceOccurrenceBackfill,
  /backfillSourceOccurrencesBatchHandler[\s\S]*syncSourceOccurrencePlan[\s\S]*source-occurrences-generic-v2/u,
);
assert.doesNotMatch(
  migrationResponsibilityModules.sourceOccurrenceBackfill,
  /LEGACY_VENUE_ALIAS_SEEDS|rebindCanonicalVenue|finalizeSourceOccurrenceTopologyAudit/u,
  "Source-occurrence backfill must not own venue identity or topology-audit finalization.",
);
assert.match(
  migrationResponsibilityModules.sourceOccurrenceCanonicalPayload,
  /source-occurrence-canonical-payload-v1/u,
);
assert.match(
  migrationResponsibilityModules.sourceOccurrenceCanonicalPayload,
  /backfillSourceOccurrenceCanonicalPayloadsBatchHandler/u,
);
assert.doesNotMatch(
  migrationResponsibilityModules.sourceOccurrenceCanonicalPayload,
  /LEGACY_VENUE_ALIAS_SEEDS|rebindCanonicalVenue|finalizeSourceOccurrenceTopologyAudit|syncSourceOccurrencePlan/u,
  "Canonical payload migration must only attest existing occurrence topology.",
);
assert.match(
  migrationResponsibilityModules.sourceOccurrenceTopologyAudit,
  /auditSourceOccurrenceReceiptTopologyBatchHandler[\s\S]*finalizeSourceOccurrenceTopologyAudit/u,
);
assert.doesNotMatch(
  migrationResponsibilityModules.sourceOccurrenceTopologyAudit,
  /LEGACY_VENUE_ALIAS_SEEDS|rebindCanonicalVenue|syncSourceOccurrencePlan/u,
  "Receipt topology audit must stay read/audit-focused and not own backfill writes.",
);

for (const repairName of [
  "evidencePolicy",
  "reviewedContinuationFold",
  "reviewedPromotionFold",
  "reviewedScheduleFold",
  "reviewedStructuredCorrections",
  "sourceGroundingReprocess",
  "trustedV2VenueRepair",
]) {
  const facadePath = `convex/eventDomain/${repairName}.ts`;
  const implementationPath = `convex/internal/eventRepairs/${repairName}.ts`;
  const facadeSource = read(facadePath);
  assert.match(facadeSource, /internal\/eventRepairs/u);
  assert.ok(
    lineCount(facadePath) <= 12,
    `${facadePath} must remain a thin compatibility export.`,
  );
  assert.doesNotMatch(
    facadeSource,
    /ctx\.db|requireAdminOrServiceSecret|async function/u,
    `${facadePath} must not regain historical repair implementation.`,
  );
  assert.match(
    read(implementationPath),
    /requireAdminOrServiceSecret/u,
    `${implementationPath} must retain the reviewed repair authorization boundary.`,
  );
}

const eventsFacadeSource = read("convex/events.ts");
assert.match(
  eventsFacadeSource,
  /from "\.\/internal\/eventRepairs\/approvedLegacyVenue"/u,
  "The approved legacy repair must stay directly isolated under internal/eventRepairs.",
);
assert.doesNotMatch(
  eventsFacadeSource,
  /eventDomain\/approvedLegacyVenue/u,
  "The approved legacy repair must not regain a steady-state eventDomain implementation.",
);

const strategySource = read("lib/domain/reconciliation/strategies.ts");
const legacyRelationshipSource = read(
  "lib/events/approval-occurrence-conflict.ts",
);
const legacyIngestionMatcherSource = read(
  "lib/pipeline/ingestion/occurrence-matching.ts",
);
assert.match(strategySource, /classifyOccurrenceRelationshipInvariant/u);
assert.doesNotMatch(strategySource, /approval-occurrence-conflict/u);
assert.match(
  legacyRelationshipSource,
  /classifyOccurrenceRelationshipInvariant/u,
);
assert.doesNotMatch(
  legacyRelationshipSource,
  /function normalize(?:Artist|Title|Time)/u,
  "The old relationship module must remain a wrapper, not a second classifier.",
);
assert.match(
  legacyIngestionMatcherSource,
  /LEGACY_INGESTION_OCCURRENCE_MATCHER_CLASSIFICATION[\s\S]*compatibility_pre_generic_reconciliation_apply_cutover/u,
  "The legacy ingestion selector must be explicitly classified until generic apply owns ingestion writes.",
);
assert.match(
  legacyIngestionMatcherSource,
  /LEGACY_INGESTION_OCCURRENCE_MATCHER_CUTOVER_CONDITION[\s\S]*source-occurrence-reconciliation-apply-v1 reviewed for create, attach, and update; ingestion writes switched atomically to reconciliation:executeSourceOccurrence/u,
  "The legacy ingestion selector must retain a concrete reviewed cutover condition.",
);
assert.doesNotMatch(
  legacyIngestionMatcherSource,
  /from ["'][^"']*domain\/reconciliation\/(?:engine|strategies)["']/u,
  "Do not imply shared reconciliation authority by calling the generic engine before its ingestion-write cutover.",
);

const sourceUrlSource = read("lib/domain/source-url.ts");
const imageCompatibilitySource = read("lib/images/apify-images.ts");
const duplicateCompatibilitySource = read("lib/events/deduplication-shared.ts");
assert.match(sourceUrlSource, /SOURCE_URL_CANONICALIZATION_VERSION/u);
assert.match(imageCompatibilitySource, /canonicalizeSourceUrl/u);
assert.match(duplicateCompatibilitySource, /canonicalizeSourceUrl/u);

const venueNormalizationSource = read("lib/pipeline/venue-normalization.ts");
const venueDomainNormalizationSource = read(
  "lib/domain/venues/normalization.ts",
);
const venueResolverSource = read("lib/domain/venues/venue-resolver.ts");
const venueIngestionAdapterSource = read(
  "lib/domain/venues/ingestion-adapter.ts",
);
const venueSeedSource = read("lib/config/legacy-venue-alias-seeds.ts");
const legacyVenueOverrideSource = read("lib/pipeline/venue-name-overrides.ts");
const ingestionVenueContextSource = read(
  "lib/pipeline/ingestion/venue-context.ts",
);
const publicEventsSource = read("lib/events/public-events.ts");
const venueMigrationSource = migrationResponsibilityModules.venueIdentity;
assert.match(venueSeedSource, /LEGACY COMPATIBILITY ONLY/u);
assert.match(
  legacyVenueOverrideSource,
  /MIGRATION \/ OPERATOR COMPATIBILITY ONLY/u,
);
assert.doesNotMatch(
  ingestionVenueContextSource,
  /venue-name-overrides/u,
  "Steady-state ingestion must resolve durable venue identities, not tracked CSV overrides.",
);
assert.doesNotMatch(
  publicEventsSource,
  /venue-name-overrides/u,
  "Public display must not rewrite durable venue names from tracked CSV overrides.",
);
assert.ok(
  lineCount("lib/pipeline/venue-normalization.ts") <= 12,
  "The old pipeline venue-normalization path must remain a thin compatibility facade.",
);
assert.match(venueNormalizationSource, /domain\/venues\/normalization/u);
assert.match(
  venueDomainNormalizationSource,
  /function normalizeVenueFromEvidence/u,
);
assert.match(venueResolverSource, /from "\.\/normalization"/u);
assert.doesNotMatch(
  venueIngestionAdapterSource,
  /normalizeVenueFromEvidence/u,
  "The ingestion adapter must call the universal resolver, not run a competing evidence policy first.",
);
assert.doesNotMatch(
  venueNormalizationSource,
  /LEGACY_VENUE_ALIAS_SEEDS/u,
  "Runtime venue normalization must resolve durable identity snapshots, not migration seeds.",
);
for (const path of sourceFiles("lib/pipeline/ingestion")) {
  assert.doesNotMatch(
    read(path),
    /legacy-venue-(?:alias-seeds|identities)/u,
    `${path} must not import migration-only venue compatibility facts at runtime.`,
  );
}
assert.match(venueMigrationSource, /LEGACY_VENUE_ALIAS_SEEDS/u);
assert.match(
  venueMigrationSource,
  /Reviewed compatibility aliases become durable manual identity data/u,
);
assert.match(venueMigrationSource, /\? "manual"/u);
assert.match(venueMigrationSource, /auditVenueCompatibilitySeeds/u);
assert.match(venueMigrationSource, /VENUE_COMPATIBILITY_SEED_AUDIT_KEY/u);

const forbiddenIncidentLiteral =
  /kc grad|freestyler|muzej jugoslavije|chillton|ski staza|ben akiba|la variete|para_klub/iu;
for (const path of [
  ...sourceFiles("lib/domain"),
  "convex/reconciliation.ts",
  "convex/internal/reconciliationCanonicalExecutor.ts",
]) {
  assert.doesNotMatch(
    read(path),
    forbiddenIncidentLiteral,
    `${path} contains incident-specific domain behavior; venue facts belong in identity/config data.`,
  );
}

const schemaSource = read("convex/schema.ts");
assert.match(schemaSource, /by_publicationState_date/u);
assert.match(schemaSource, /by_publicationState_promotionTier/u);
assert.match(schemaSource, /campaignLineageReattestations/u);
assert.match(schemaSource, /publicationMigrationState/u);

console.log(
  "Domain architecture QA passed (facades, historical repair isolation, provider boundary, module cohesion, single classifier/source-URL authority, compatibility venue lifecycle, and indexed cutover schema).",
);
