import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { buildSourceDocumentIdentity } from "../lib/domain/source-documents.ts";
import { parseCanonicalEventPayload } from "../lib/domain/occurrences/canonical-event-payload.ts";
import {
  prepareEventsForInsert,
  produceStructuredFactsForInsert,
} from "../lib/pipeline/run-instagram-ingestion.ts";
import { mapSavedScrapedPostToSourceDocument } from "../lib/pipeline/ingestion/source-documents.ts";
import {
  fetchInstagramSourceDocuments,
  instagramSourceProviderAdapter,
  loadRecentInstagramSourceDocuments,
} from "../lib/pipeline/ingestion/source-provider.ts";
import {
  bindSourceOccurrenceFactMetadata,
  bindSourceOccurrenceMetadata,
  buildSourceOccurrenceIdentity,
  buildSourceOccurrenceKeyForTesting,
  buildSourceOccurrencePlan,
  buildSourceOccurrencePlanFromFacts,
} from "../lib/pipeline/source-occurrence-planning.ts";
import { prepareStructuredFactsForPersistence } from "../lib/pipeline/ingestion/structured-fact-persistence.ts";
import {
  bindStructuredFactOccurrenceMetadata,
  buildStructuredFactOccurrencePlan,
} from "../lib/pipeline/ingestion/structured-fact-occurrence.ts";

const facade = readFileSync("lib/pipeline/run-instagram-ingestion.ts", "utf8");
assert.ok(
  facade.split(/\r?\n/u).length < 300,
  "the compatibility facade must remain orchestration-only",
);

const moduleNames = readdirSync("lib/pipeline/ingestion")
  .filter((name) => name.endsWith(".ts"))
  .sort();
for (const expected of [
  "source-provider.ts",
  "source-documents.ts",
  "parsing-date.ts",
  "parsing-time.ts",
  "parsing-schedule.ts",
  "parsing-source-evidence.ts",
  "structured-facts.ts",
  "durable-saved-posts.ts",
  "reporting.ts",
]) {
  assert.ok(
    moduleNames.includes(expected),
    `missing ingestion boundary ${expected}`,
  );
}
for (const name of moduleNames) {
  const lines = readFileSync(`lib/pipeline/ingestion/${name}`, "utf8").split(
    /\r?\n/u,
  ).length;
  assert.ok(
    lines <= 1_500,
    `${name} is becoming a replacement god module (${lines} lines)`,
  );
}

assert.equal(instagramSourceProviderAdapter.provider, "instagram");
assert.equal(typeof instagramSourceProviderAdapter.fetchDocuments, "function");
assert.equal(
  typeof instagramSourceProviderAdapter.loadRecentDocuments,
  "function",
);
assert.equal(
  typeof instagramSourceProviderAdapter.projectForCompatibilityParser,
  "function",
);

const savedSourceDocument = mapSavedScrapedPostToSourceDocument({
  _id: "saved-source-1",
  handle: "qa_venue",
  postId: "QA_SOURCE_1",
  caption: "QA Event • 04.09.2026 • 21:00 • QA Artist • QA Venue",
  altText: "Poster for QA Event",
  imageUrls: ["https://images.apifyusercontent.com/qa-source.jpg"],
  instagramPostUrl: "https://www.instagram.com/p/QA_SOURCE_1/?utm_source=qa",
  sourceKey: "hostile-legacy-source-key",
  username: "qa_venue",
  createdAt: 100,
  updatedAt: 100,
  sourceRevision: 3,
});
assert.equal(savedSourceDocument.provider, "instagram");
assert.equal(savedSourceDocument.providerAccount, "qa_venue");
assert.equal(savedSourceDocument.providerDocumentId, "QA_SOURCE_1");
assert.equal(savedSourceDocument.sourceRevision, 3);
assert.equal(
  savedSourceDocument.canonicalSource.canonicalUrl,
  "https://www.instagram.com/p/QA_SOURCE_1/",
);
assert.equal(
  savedSourceDocument.sourceIdentity,
  buildSourceDocumentIdentity("instagram", savedSourceDocument.canonicalSource),
);
assert.equal(
  savedSourceDocument.sourceIdentity,
  "instagram-source-identity-v1:QA_SOURCE_1",
  "legacy sourceKey metadata must never override canonical source identity",
);
assert.equal(
  savedSourceDocument.legacyMetadata?.sourceKey,
  "hostile-legacy-source-key",
);

const evidenceEntry = (evidence) => ({
  confidence: 0.95,
  found_in: ["caption"],
  evidence,
  evidence_snippets: [{ source: "caption", text: evidence }],
  notes: "QA evidence",
});
const caption = "QA Event • 04.09.2026 • 21:00 • QA Artist • QA Venue";
const post = {
  postId: "QA_SOURCE_1",
  caption,
  altText: null,
  imageUrl: null,
  imageUrls: [],
  postType: "image",
  locationName: "QA Venue",
  instagramPostUrl: "https://www.instagram.com/p/QA_SOURCE_1/",
  postedAt: "2026-08-28T10:00:00.000Z",
  username: "qa_venue",
};
assert.equal(
  buildSourceOccurrenceIdentity(post),
  savedSourceDocument.sourceIdentity,
  "SourceDocument and occurrence planning must use the same identity authority",
);

let providerFetchCalls = 0;
const acquiredBatch = await fetchInstagramSourceDocuments(
  { handle: "qa_venue" },
  {
    fetchProviderRows: async (request) => {
      providerFetchCalls += 1;
      assert.equal(request.handle, "qa_venue");
      return [post];
    },
    now: () => 456,
  },
);
assert.equal(providerFetchCalls, 1);
assert.equal(acquiredBatch.documents.length, 1);
assert.equal(acquiredBatch.rawDocumentCount, 1);
assert.equal(acquiredBatch.documents[0].capturedAt, 456);
assert.equal(
  acquiredBatch.documents[0].sourceIdentity,
  buildSourceOccurrenceIdentity(post),
  "provider acquisition must cross SourceDocument before compatibility parsing",
);
const projectedParserDocument =
  instagramSourceProviderAdapter.projectForCompatibilityParser(
    acquiredBatch.documents[0],
  );
assert.deepEqual(
  projectedParserDocument,
  post,
  "the Instagram parser DTO must be derived from the SourceDocument evidence",
);
assert.notEqual(
  projectedParserDocument,
  post,
  "the provider row must not pass through the SourceDocument boundary by reference",
);
assert.throws(
  () =>
    instagramSourceProviderAdapter.projectForCompatibilityParser({
      ...acquiredBatch.documents[0],
      sourceIdentity: "instagram-source-identity-v1:tampered",
    }),
  /changed source identity/u,
  "the compatibility projection must reject identity drift",
);
const recoveredBatch = await loadRecentInstagramSourceDocuments(
  { handles: ["qa_venue"] },
  {
    loadProviderRows: async () => ({
      importedPosts: 1,
      importedPostsByHandle: { qa_venue: [post] },
      runsScanned: 2,
    }),
    now: () => 789,
  },
);
assert.equal(recoveredBatch.runsScanned, 2);
assert.equal(recoveredBatch.importedPosts, 1);
assert.equal(
  recoveredBatch.documentsByHandle.qa_venue[0].sourceIdentity,
  savedSourceDocument.sourceIdentity,
  "historical provider recovery must cross the same SourceDocument identity boundary",
);
const extracted = {
  extraction_contract_version: "legacy_qa_fixture_v1",
  is_event: true,
  non_event_reason: "",
  title: "QA Event",
  date: "04.09.2026",
  time: "21:00",
  venue: "QA Venue",
  city: "Belgrade",
  country: "Serbia",
  price: "",
  currency: "",
  artists: ["QA Artist"],
  category: "nightlife",
  description: "QA event description.",
  confidence: 0.95,
  reasoning_notes: "QA extraction",
  source_caption: caption,
  source_url: post.instagramPostUrl,
  date_evidence: {
    exact_text: "04.09.2026",
    source: "caption",
    is_relative: false,
    resolved_date: "2026-09-04",
  },
  time_evidence: {
    status: "start_time_stated",
    exact_text: "21:00",
    source: "caption",
  },
  source_conflicts: [],
  shared_schedule_context: {
    venue: {
      applies_to_all: false,
      value: "",
      evidence: "",
      source: "unknown",
    },
    time: { applies_to_all: false, value: "", evidence: "", source: "unknown" },
  },
  schedule_entries: [],
  field_confirmation: {
    title: evidenceEntry("QA Event"),
    location: evidenceEntry("QA Venue"),
    location_name: evidenceEntry("QA Venue"),
    price: evidenceEntry("No price"),
    start_time: evidenceEntry("21:00"),
    short_description: evidenceEntry("QA event description"),
    artists: evidenceEntry("QA Artist"),
  },
};
const prepareArguments = [
  post,
  extracted,
  null,
  { qa_venue: "QA Venue" },
  {},
  { qa_venue: "QA Venue" },
  {
    eventDateFilterNow: new Date("2026-08-28T10:00:00.000Z"),
    sourceRolesByHandle: { qa_venue: "venue" },
  },
];
const structured = produceStructuredFactsForInsert(...prepareArguments);
const compatibility = prepareEventsForInsert(...prepareArguments);
assert.deepEqual(
  prepareStructuredFactsForPersistence(structured),
  compatibility,
  "the legacy export must delegate to the typed-fact persistence adapter",
);
assert.equal(structured.length, 1);
assert.equal(structured[0].kind, "event");
assert.deepEqual(
  {
    artistClaims: structured[0].facts.artistClaims,
    eventTypeClaim: structured[0].facts.eventTypeClaim,
    localDate: structured[0].facts.localDate,
    startTime: structured[0].facts.startTime,
    timeRelation: structured[0].facts.timeRelation,
    titleClaim: structured[0].facts.titleClaim,
    venueClaim: structured[0].facts.venueClaim,
  },
  {
    artistClaims: ["QA Artist"],
    eventTypeClaim: "nightlife",
    localDate: "2026-09-04",
    startTime: "21:00",
    timeRelation: "exact",
    titleClaim: "QA Event",
    venueClaim: "QA Venue",
  },
);
assert.ok(structured[0].facts.evidence.some((entry) => entry.field === "date"));
assert.ok(
  structured[0].facts.evidence.some((entry) => entry.field === "start_time"),
);
assert.equal(structured[0].facts.policy.approvalDisposition, "pending");
assert.equal(
  typeof structured[0].facts.policy.structuredEvidenceVerified,
  "boolean",
);
const boundFacts = bindStructuredFactOccurrenceMetadata(post, structured);
const factPrepared = prepareStructuredFactsForPersistence(boundFacts);
const legacyBound = bindSourceOccurrenceMetadata(post, compatibility);
assert.deepEqual(
  boundFacts,
  bindSourceOccurrenceFactMetadata(post, structured),
  "the ingestion adapter must delegate to the fact-native occurrence binder",
);
assert.deepEqual(
  factPrepared.map((result) => result.normalizedFields.sourceOccurrenceKey),
  legacyBound.map((result) => result.normalizedFields.sourceOccurrenceKey),
  "occurrence keys derived from facts must preserve the existing signature",
);
const factPlan = buildStructuredFactOccurrencePlan(post, boundFacts);
assert.deepEqual(
  {
    ...factPlan,
    expectedOccurrences: factPlan.expectedOccurrences.map(
      ({ canonicalEventJson: _canonicalEventJson, ...occurrence }) =>
        occurrence,
    ),
  },
  buildSourceOccurrencePlanFromFacts(post, boundFacts),
  "the ingestion adapter must preserve the fact-native plan while adding canonical materialization inputs",
);
const canonicalPayload = parseCanonicalEventPayload(
  factPlan.expectedOccurrences[0].canonicalEventJson,
);
assert.ok(
  canonicalPayload,
  "fact-native ingestion must persist a validated canonical materialization payload",
);
assert.equal(
  canonicalPayload.requestedStatus,
  boundFacts[0].facts.policy.approvalDisposition,
);
assert.deepEqual(
  JSON.parse(canonicalPayload.normalizedFieldsJson),
  boundFacts[0].normalizedFields,
  "canonical materialization must preserve normalized provenance fields",
);
const legacyPlan = buildSourceOccurrencePlan(post, legacyBound);
assert.deepEqual(
  factPlan.expectedOccurrences.map(
    ({ artists, date, key, time, title, venue }) => ({
      artists,
      date,
      key,
      time,
      title,
      venue,
    }),
  ),
  legacyPlan.expectedOccurrences,
  "fact-native planning must preserve legacy occurrence keys and semantic bindings",
);
assert.deepEqual(
  JSON.parse(factPlan.expectedOccurrences[0].factsJson),
  boundFacts[0].facts,
  "the durable plan must carry the exact typed fact payload, not a legacy event tuple",
);

const noTimeStructured = produceStructuredFactsForInsert(
  {
    ...post,
    caption: "QA Event • 04.09.2026 • QA Artist • QA Venue",
  },
  {
    ...extracted,
    time: "",
    source_caption: "QA Event • 04.09.2026 • QA Artist • QA Venue",
    time_evidence: {
      status: "not_stated",
      exact_text: "",
      source: "unknown",
    },
  },
  ...prepareArguments.slice(2),
);
assert.equal(noTimeStructured[0].kind, "event");
assert.equal(noTimeStructured[0].facts.timeRelation, "unknown");
assert.equal("startTime" in noTimeStructured[0].facts, false);
assert.equal(
  prepareStructuredFactsForPersistence(noTimeStructured)[0].event.time,
  "TBD",
  "unknown time remains a persistence concern and must not become an exact fact",
);
const noTimeBound = bindStructuredFactOccurrenceMetadata(
  post,
  noTimeStructured,
);
assert.equal(
  noTimeBound[0].normalizedFields.sourceOccurrenceKey,
  buildSourceOccurrenceKeyForTesting(
    post,
    noTimeStructured[0].facts.localDate,
    "TBD",
    noTimeStructured[0].normalizedFields,
  ),
  "unknown-time facts must retain the legacy TBD occurrence signature",
);
const noTimeFactPlan = buildStructuredFactOccurrencePlan(post, noTimeBound);
assert.equal(noTimeFactPlan.expectedOccurrences[0].time, "TBD");
assert.equal(
  parseCanonicalEventPayload(
    noTimeFactPlan.expectedOccurrences[0].canonicalEventJson,
  )?.time,
  "TBD",
  "unknown-time canonical materialization must retain the compatibility TBD marker",
);
assert.deepEqual(
  JSON.parse(noTimeFactPlan.expectedOccurrences[0].factsJson),
  JSON.parse(JSON.stringify(noTimeBound[0].facts)),
);
assert.equal(
  JSON.parse(noTimeFactPlan.expectedOccurrences[0].factsJson).timeRelation,
  "unknown",
  "the durable fact payload must not relabel a TBD compatibility time as exact",
);
assert.equal(
  Object.hasOwn(
    JSON.parse(noTimeFactPlan.expectedOccurrences[0].factsJson),
    "startTime",
  ),
  false,
);

const postProcessorSource = readFileSync(
  "lib/pipeline/ingestion/post-processor.ts",
  "utf8",
);
const structuredFactsSource = readFileSync(
  "lib/pipeline/ingestion/structured-facts.ts",
  "utf8",
);
assert.match(
  postProcessorSource,
  /prepareStructuredFactsForPersistence\(structuredFacts\)/u,
);
assert.match(postProcessorSource, /bindStructuredFactOccurrenceMetadata/u);
assert.match(postProcessorSource, /structuredFacts,/u);
assert.doesNotMatch(
  postProcessorSource,
  /map\(\(\{\s*prepared\s*\}\)\s*=>\s*prepared\)/u,
);
assert.doesNotMatch(
  structuredFactsSource,
  /projectPreparedEventToStructuredFacts/u,
);
assert.ok(
  structuredFactsSource.split(/\r?\n/u).length < 1_000,
  "structured-facts.ts must remain a focused extraction coordinator",
);
assert.ok(
  postProcessorSource.split(/\r?\n/u).length < 900,
  "post-processor.ts must remain an extraction coordinator, not own reconciliation persistence",
);
const occurrencePersisterSource = readFileSync(
  "lib/pipeline/ingestion/occurrence-persister.ts",
  "utf8",
);
assert.match(occurrencePersisterSource, /buildStructuredFactOccurrencePlan/u);
assert.match(
  occurrencePersisterSource,
  /applyPreparedOccurrenceMetadataToStructuredFacts/u,
);
const structuredFactOccurrenceSource = readFileSync(
  "lib/pipeline/ingestion/structured-fact-occurrence.ts",
  "utf8",
);
assert.match(structuredFactOccurrenceSource, /bindSourceOccurrenceFactMetadata/u);
assert.match(structuredFactOccurrenceSource, /buildSourceOccurrencePlanFromFacts/u);
assert.doesNotMatch(structuredFactOccurrenceSource, /bindSourceOccurrenceMetadata/u);
assert.doesNotMatch(structuredFactOccurrenceSource, /buildSourceOccurrencePlan\(/u);
assert.doesNotMatch(
  structuredFactOccurrenceSource,
  /buildStructuredFactOccurrencePlan[\s\S]{0,300}PrepareEventResult/u,
);
assert.ok(
  occurrencePersisterSource.split(/\r?\n/u).length < 900,
  "occurrence persistence must remain a cohesive bounded module",
);

console.log("Ingestion architecture boundary QA passed.");
