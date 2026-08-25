import assert from "node:assert/strict";
import { repairApprovedLegacyEventVenueAndOccurrence } from "../convex/events.ts";
import { isCanonicallyGroundedApprovedEvent } from "../convex/publicEventGrounding.ts";
import { sourceOccurrenceRepresentativeMatchesExpected } from "../lib/events/source-occurrence-representation.ts";

process.env.CRON_SECRET = "qa-approved-legacy-venue-repair-secret";

const now = 2_000;
const originalDateNow = Date.now;
Date.now = () => now;
const eventId = "qa-approved-legacy-event";
const venueId = "qa-la-variete";
const sourceId = "qa-la-variete-source";
const scrapedPostId = "qa-la-variete-post";
const sourceLinkId = "qa-la-variete-link";
const receiptId = "qa-la-variete-receipt";
const sourceHandle = "lavariete.belgrade";
const sourceIdentity = "instagram-source-identity-v1:qa-la-variete";
const sourceFingerprint = `instagram-source-v2:${"a".repeat(64)}`;
const sourceOccurrenceKey = `instagram-occurrence-v2:${"b".repeat(64)}`;
const instagramPostId = "qa-la-variete-instagram-post";
const instagramPostUrl = "https://www.instagram.com/p/qa-la-variete/";
const sourcePostedAt = "2026-08-08T21:40:03.000Z";
const sourceCaption =
  "ZLOSTAVLJANJE 31. decembra u 21:00, Mlada scena La Variété. Vidimo se u Francuskoj 6!";
const artists = ["Milica Janković"];

function normalizedFields() {
  return {
    artists,
    dateSuspiciousYear: false,
    humanReviewedLegacySourcePolicyVersion: 1,
    moderationPendingReasons: [
      "requires_human_approval",
      "caption_source_event_mismatch",
    ],
    normalizedDate: "2099-12-31",
    normalizedIsValid: true,
    normalizedVenue: "Francuska 6",
    rawVenue: "Francuska 6",
    sourceGroundingEvidence: "instagram_caption",
    sourceGroundingInstagramHandle: sourceHandle,
    sourceGroundingInstagramPostId: instagramPostId,
    sourceGroundingInstagramPostUrl: instagramPostUrl,
    sourceGroundingSourceCaption: sourceCaption,
    sourceGroundingSourceKind: "caption",
    sourceGroundingVerified: false,
    sourceGroundingVersion: 4,
    time: "21:00",
    title: "ZLOSTAVLJANJE",
    titleUsedFallback: false,
  };
}

function makeFixture(overrides = {}) {
  const rawExtractionJson = JSON.stringify({
    extraction_contract_version: "legacy_qa_fixture_v1",
    is_event: true,
    venue: "Francuska 6",
  });
  const event = {
    _id: eventId,
    _creationTime: 1,
    artists,
    createdAt: 1,
    date: "2099-12-31",
    eventType: "arts & culture",
    humanReviewedLegacySourcePolicyVersion: 1,
    instagramPostId,
    instagramPostUrl,
    moderationNote: "Human approved the exact persisted legacy Instagram source.",
    normalizedFieldsJson: JSON.stringify(normalizedFields()),
    rawExtractionJson,
    reviewedAt: 1_500,
    reviewedBy: "QA moderator",
    sourceCaption,
    sourceOccurrenceKey,
    sourcePostedAt,
    sourceConflictFields: [],
    status: "approved",
    time: "21:00",
    title: "ZLOSTAVLJANJE",
    updatedAt: 1_600,
    venue: "Francuska 6",
  };
  const venue = {
    _id: venueId,
    _creationTime: 1,
    category: "venue",
    createdAt: 1,
    instagramHandle: sourceHandle,
    location: "Francuska 6",
    name: "La Variete",
    normalizedInstagramHandle: sourceHandle,
    publicStatus: "published",
    scrapeActive: true,
    updatedAt: 1_700,
  };
  const source = {
    _id: sourceId,
    _creationTime: 1,
    active: true,
    activatedAt: 1,
    createdAt: 1,
    discoveredAt: 1,
    handle: sourceHandle,
    role: "venue",
    updatedAt: 1_800,
    venueId,
  };
  const scrapedPost = {
    _id: scrapedPostId,
    _creationTime: 1,
    analysisResultJson: rawExtractionJson,
    analysisRevision: 1,
    caption: sourceCaption,
    createdAt: 1,
    handle: sourceHandle,
    instagramPostUrl,
    postId: instagramPostId,
    postedAt: sourcePostedAt,
    sourceRevision: 1,
    updatedAt: 1,
    username: sourceHandle,
  };
  const sourceLink = {
    _id: sourceLinkId,
    _creationTime: 1,
    eventId,
    instagramPostId,
    instagramPostUrl,
    linkedAt: 1_900,
    sourceFingerprint,
    sourceIdentity,
    sourceOccurrenceKey,
    updatedAt: 1_900,
  };
  const expectedOccurrence = {
    artists,
    date: event.date,
    key: sourceOccurrenceKey,
    time: event.time,
    title: event.title,
    venue: event.venue,
  };
  const receipt = {
    _id: receiptId,
    _creationTime: 1,
    createdAt: 1_900,
    deferredChildCount: 0,
    deferredChildKeys: [],
    expectedKeys: [sourceOccurrenceKey],
    expectedOccurrences: [expectedOccurrence],
    satisfiedKeys: [sourceOccurrenceKey],
    satisfiedOccurrences: [{ eventId, key: sourceOccurrenceKey }],
    sourceFingerprint,
    sourceIdentity,
    updatedAt: 1_900,
  };
  return {
    event: { ...event, ...(overrides.event ?? {}) },
    receipt: { ...receipt, ...(overrides.receipt ?? {}) },
    scrapedPost: { ...scrapedPost, ...(overrides.scrapedPost ?? {}) },
    source: { ...source, ...(overrides.source ?? {}) },
    sourceLink: { ...sourceLink, ...(overrides.sourceLink ?? {}) },
    venue: { ...venue, ...(overrides.venue ?? {}) },
  };
}

function readIndexCriteria(configure) {
  const criteria = {};
  const q = {
    eq(field, value) {
      criteria[field] = value;
      return q;
    },
  };
  configure(q);
  return criteria;
}

function makeHarness(overrides = {}) {
  const fixture = makeFixture(overrides);
  const records = new Map(
    Object.values(fixture).map((record) => [record._id, structuredClone(record)]),
  );
  const audits = [];
  const patches = [];
  const tableRecords = {
    events: [fixture.event],
    instagramEventSources: [fixture.sourceLink],
    instagramSourceOccurrenceReceipts: [fixture.receipt],
    instagramSources: [fixture.source],
    scrapedPosts: [fixture.scrapedPost],
  };
  const ctx = {
    auth: { getUserIdentity: async () => null },
    db: {
      async get(id) {
        return records.get(id) ?? null;
      },
      async insert(table, value) {
        assert.equal(table, "eventAuditLog");
        audits.push(structuredClone(value));
        return `qa-audit-${audits.length}`;
      },
      async patch(id, patch) {
        const current = records.get(id);
        if (!current) throw new Error(`Unexpected patch for ${id}`);
        patches.push({ id, patch: structuredClone(patch) });
        records.set(id, { ...current, ...structuredClone(patch) });
      },
      query(table) {
        return {
          withIndex(_index, configure) {
            const criteria = readIndexCriteria(configure);
            const rows = (tableRecords[table] ?? [])
              .map((record) => records.get(record._id))
              .filter(Boolean)
              .filter((record) =>
                Object.entries(criteria).every(
                  ([field, value]) => record[field] === value,
                ),
              );
            return {
              async collect() {
                return rows.map((record) => structuredClone(record));
              },
              async take(limit) {
                return rows.slice(0, limit).map((record) => structuredClone(record));
              },
              async unique() {
                if (rows.length > 1) throw new Error("Expected a unique QA row.");
                return rows[0] ? structuredClone(rows[0]) : null;
              },
            };
          },
        };
      },
    },
  };
  return { audits, ctx, fixture, patches, records };
}

function repairArgs(fixture) {
  return {
    id: eventId,
    expectedCurrentVenue: fixture.event.venue,
    expectedNormalizedFieldsJson: fixture.event.normalizedFieldsJson,
    expectedReceiptId: receiptId,
    expectedReceiptUpdatedAt: fixture.receipt.updatedAt,
    expectedScrapedPostAnalysisRevision: fixture.scrapedPost.analysisRevision,
    expectedScrapedPostId: scrapedPostId,
    expectedScrapedPostSourceRevision: fixture.scrapedPost.sourceRevision,
    expectedSourceFingerprint: sourceFingerprint,
    expectedSourceId: sourceId,
    expectedSourceIdentity: sourceIdentity,
    expectedSourceLinkId: sourceLinkId,
    expectedSourceLinkUpdatedAt: fixture.sourceLink.updatedAt,
    expectedSourceOccurrenceKey: sourceOccurrenceKey,
    expectedSourceUpdatedAt: fixture.source.updatedAt,
    expectedTargetVenueUpdatedAt: fixture.venue.updatedAt,
    expectedUpdatedAt: fixture.event.updatedAt,
    moderationNote:
      "Corrected address-only venue evidence to the exact canonical venue owned by the source account.",
    serviceSecret: process.env.CRON_SECRET,
    targetVenueId: venueId,
  };
}

const success = makeHarness();
assert.equal(
  await isCanonicallyGroundedApprovedEvent(
    success.ctx,
    success.records.get(eventId),
  ),
  true,
  "The source fixture must be publicly grounded before repair.",
);
const result = await repairApprovedLegacyEventVenueAndOccurrence._handler(
  success.ctx,
  repairArgs(success.fixture),
);
assert.deepEqual(result, {
  receiptUpdatedAt: now,
  status: "approved",
  updated: true,
  updatedAt: now,
});
const repairedEvent = success.records.get(eventId);
const repairedReceipt = success.records.get(receiptId);
assert.equal(repairedEvent.venue, "La Variete");
assert.equal(repairedEvent.venueId, venueId);
assert.equal(repairedEvent.venueInstagramHandle, sourceHandle);
assert.equal(repairedEvent.venueLocation, "Francuska 6");
const repairedFields = JSON.parse(repairedEvent.normalizedFieldsJson);
assert.equal(repairedFields.rawVenue, "Francuska 6");
assert.equal(repairedFields.normalizedVenue, "La Variete");
assert.equal(repairedFields.canonicalVenueLocation, "Francuska 6");
assert.equal(repairedFields.rawVenueMatchesCanonicalLocation, true);
assert.equal(repairedFields.manualVenueCanonicalizationVersion, 1);
assert.equal(repairedReceipt.expectedOccurrences[0].venue, "La Variete");
assert.deepEqual(repairedReceipt.satisfiedOccurrences, [
  { eventId, key: sourceOccurrenceKey },
]);
assert.equal(
  sourceOccurrenceRepresentativeMatchesExpected(
    repairedEvent,
    repairedReceipt.expectedOccurrences[0],
  ),
  true,
);
assert.equal(await isCanonicallyGroundedApprovedEvent(success.ctx, repairedEvent), true);
assert.equal(success.audits.length, 1);
assert.equal(success.audits[0].action, "approved_legacy_venue_repaired");
assert.deepEqual(
  success.patches.map((patch) => patch.id),
  [eventId, receiptId],
  "The repair must update only the event and its exact occurrence receipt.",
);

for (const [label, overrides, expectedError] of [
  [
    "promoter source",
    { source: { role: "promoter" } },
    /source no longer owns/iu,
  ],
  [
    "different canonical location",
    { venue: { location: "Cetinjska 15" } },
    /target venue is not the exact public source venue/iu,
  ],
  [
    "changed occurrence receipt",
    { receipt: { sourceFingerprint: `instagram-source-v2:${"d".repeat(64)}` } },
    /source occurrence receipt changed/iu,
  ],
  [
    "changed source link",
    { sourceLink: { sourceFingerprint: `instagram-source-v2:${"c".repeat(64)}` } },
    /event source link changed/iu,
  ],
]) {
  const harness = makeHarness(overrides);
  const before = structuredClone([...harness.records.entries()]);
  await assert.rejects(
    repairApprovedLegacyEventVenueAndOccurrence._handler(
      harness.ctx,
      repairArgs(harness.fixture),
    ),
    expectedError,
    label,
  );
  assert.deepEqual([...harness.records.entries()], before, `${label} must be atomic.`);
  assert.equal(harness.audits.length, 0);
  assert.equal(harness.patches.length, 0);
}

const siblingBinding = makeHarness();
const siblingBindingReceipt = siblingBinding.records.get(receiptId);
const siblingOccurrenceKey = `instagram-occurrence-v2:${"c".repeat(64)}`;
siblingBinding.records.set(receiptId, {
  ...siblingBindingReceipt,
  expectedKeys: [...siblingBindingReceipt.expectedKeys, siblingOccurrenceKey],
  expectedOccurrences: [
    ...siblingBindingReceipt.expectedOccurrences,
    {
      ...siblingBindingReceipt.expectedOccurrences[0],
      key: siblingOccurrenceKey,
      time: "23:00",
    },
  ],
  satisfiedKeys: [...siblingBindingReceipt.satisfiedKeys, siblingOccurrenceKey],
  satisfiedOccurrences: [
    ...siblingBindingReceipt.satisfiedOccurrences,
    { eventId, key: siblingOccurrenceKey },
  ],
});
await assert.rejects(
  repairApprovedLegacyEventVenueAndOccurrence._handler(
    siblingBinding.ctx,
    repairArgs(siblingBinding.fixture),
  ),
  /source occurrence receipt changed/iu,
  "A single event bound to a sibling occurrence must fail closed.",
);
assert.equal(siblingBinding.patches.length, 0);
assert.equal(siblingBinding.audits.length, 0);

await assert.rejects(
  repairApprovedLegacyEventVenueAndOccurrence._handler(
    success.ctx,
    repairArgs(success.fixture),
  ),
  /reviewed version|changed before repair/iu,
  "A replay with stale optimistic versions must fail closed.",
);

Date.now = originalDateNow;

console.log(
  "QA passed: approved legacy address-to-venue repair is canonical, receipt-consistent, atomic, and version guarded.",
);
