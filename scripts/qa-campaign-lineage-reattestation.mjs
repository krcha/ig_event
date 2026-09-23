import assert from "node:assert/strict";

import {
  reattestCampaignLineageBatch,
} from "../convex/internal/migrations/campaignLineage.ts";
import {
  CROSS_POST_PROMOTION_COALESCING_POLICY_VERSION,
} from "../lib/events/cross-post-promotion-coalescing.ts";
import { loadVerifiedCampaignLineageReattestation } from "../convex/internal/campaignLineageReattestationProof.ts";
import { auditSourceOccurrenceReceiptTopologyBatchHandler } from "../convex/internal/migrations/sourceOccurrenceTopologyAudit.ts";
import { deleteExpiredEventWithSavedReferences } from "../convex/eventDomain/persistence.ts";
import { sourceOccurrenceProvenanceRepository } from "../convex/repositories/sourceOccurrenceProvenance.ts";
import { auditRetentionReceiptCoverageBatch } from "../convex/internal/retentionReceiptCoverage.ts";

const primaryId = "event_primary";
const venueId = "venue_qa";
const operationId = "auto-cross-post-v1:qa-campaign";
const expected = {
  artists: ["QA Artist"],
  date: "2026-09-19",
  key: "qa-occurrence-a",
  time: "22:00",
  title: "QA Campaign Night",
  venue: "QA Venue",
};

function campaignSource(index) {
  const suffix = index === 0 ? "a" : "b";
  return {
    eventId: index === 0 ? primaryId : "event_variant",
    eventUpdatedAt: index === 0 ? 10 : 11,
    instagramPostId: `QaPost${suffix.toUpperCase()}`,
    instagramPostUrl: `https://www.instagram.com/p/QaPost${suffix.toUpperCase()}/`,
    receiptId: `receipt_${suffix}`,
    receiptUpdatedAt: 20 + index,
    sourceFingerprint: `fingerprint-${suffix}`,
    sourceHandle: `qa_source_${suffix}`,
    sourceIdentity: `qa-source-${suffix}`,
    sourceLinkId: `link_${suffix}`,
    sourceLinkUpdatedAt: 30 + index,
    sourceOccurrenceKey: `qa-occurrence-${suffix}`,
  };
}

function makeFixture() {
  const sources = [campaignSource(0), campaignSource(1)];
  const attestation = {
    campaignAnchors: ["#qa-campaign", "ticket:qa"],
    campaignPostIds: sources.map((source) => source.instagramPostId),
    lineageDepth: 1,
    operationId,
    policyVersion: CROSS_POST_PROMOTION_COALESCING_POLICY_VERSION,
    primaryEventId: primaryId,
    publicBinding: {
      artists: [...expected.artists],
      date: expected.date,
      time: expected.time,
      title: expected.title,
      venue: expected.venue,
    },
    sources,
    targetVenueId: venueId,
    totalSourceCount: 2,
  };
  const normalizedFieldsJson = JSON.stringify({
    artists: [...expected.artists],
    crossPostCampaignAggregateAttestation: attestation,
    normalizedDate: expected.date,
    normalizedVenue: expected.venue,
    time: expected.time,
    title: expected.title,
  });
  const events = [
    {
      _creationTime: 1,
      _id: primaryId,
      artists: [...expected.artists],
      date: expected.date,
      eventType: "nightlife",
      instagramPostId: sources[0].instagramPostId,
      normalizedFieldsJson,
      normalizedVenueIdentity: "qa venue",
      normalizedVenueInstagramHandle: "qa_venue",
      status: "pending",
      time: expected.time,
      title: expected.title,
      updatedAt: sources[0].eventUpdatedAt,
      venue: expected.venue,
      venueId,
    },
    {
      _creationTime: 2,
      _id: "event_variant",
      artists: [...expected.artists],
      date: expected.date,
      eventType: "nightlife",
      instagramPostId: sources[1].instagramPostId,
      normalizedFieldsJson: JSON.stringify({
        artists: [...expected.artists],
        normalizedDate: expected.date,
        normalizedVenue: expected.venue,
        time: expected.time,
        title: expected.title,
      }),
      status: "pending",
      time: expected.time,
      title: expected.title,
      updatedAt: sources[1].eventUpdatedAt,
      venue: expected.venue,
      venueId,
    },
  ];
  const links = sources.map((source) => ({
    _creationTime: 10,
    _id: source.sourceLinkId,
    eventId: source.eventId,
    instagramPostId: source.instagramPostId,
    instagramPostUrl: source.instagramPostUrl,
    sourceFingerprint: source.sourceFingerprint,
    sourceHandle: source.sourceHandle,
    sourceIdentity: source.sourceIdentity,
    sourceOccurrenceKey: source.sourceOccurrenceKey,
    updatedAt: source.sourceLinkUpdatedAt,
  }));
  const receipts = sources.map((source, index) => {
    const sourceExpected = { ...expected, key: source.sourceOccurrenceKey };
    const earlierExpected = {
      ...expected,
      key: "qa-earlier-occurrence",
      time: "18:00",
      title: "QA Earlier Occurrence",
    };
    const expectedOccurrences =
      index === 1 ? [earlierExpected, sourceExpected] : [sourceExpected];
    return {
      _creationTime: 20,
      _id: source.receiptId,
      createdAt: 1,
      deferredChildCount: 0,
      deferredChildKeys: [],
      expectedKeys: expectedOccurrences.map((item) => item.key),
      expectedOccurrences,
      satisfiedKeys: [source.sourceOccurrenceKey],
      satisfiedOccurrences: [
        { eventId: primaryId, key: source.sourceOccurrenceKey },
      ],
      sourceFingerprint: source.sourceFingerprint,
      sourceIdentity: source.sourceIdentity,
      updatedAt: source.receiptUpdatedAt,
    };
  });
  const posts = sources.map((source, index) => ({
    _creationTime: 30 + index,
    _id: `post_${index}`,
    createdAt: 1,
    handle: source.sourceHandle,
    imageUrls: [],
    instagramPostUrl: source.instagramPostUrl,
    postId: source.instagramPostId,
    sourceRevision: 1,
    updatedAt: 1,
    username: source.sourceHandle,
  }));
  const venue = {
    _creationTime: 40,
    _id: venueId,
    category: "club",
    createdAt: 1,
    instagramHandle: "qa_venue",
    name: expected.venue,
    publicStatus: "published",
    scrapeActive: true,
    updatedAt: 1,
  };
  const identity = {
    _creationTime: 41,
    _id: "venue_identity",
    active: true,
    createdAt: 1,
    kind: "canonical_name",
    normalizedValue: "qa venue",
    rawValue: expected.venue,
    source: "venue_record",
    updatedAt: 1,
    venueId,
  };
  const venueMigration = {
    _creationTime: 42,
    _id: "venue_migration",
    completedAt: 1,
    createdAt: 1,
    errorCount: 0,
    isDone: true,
    key: "venue-identities-v1",
    mismatchCount: 0,
    phase: "venue_identities",
    scannedCount: 1,
    updatedAt: 1,
    updatedCount: 1,
  };
  return {
    campaignLineageReattestations: [],
    eventDomainMigrationState: [venueMigration],
    events,
    instagramEventSources: links,
    instagramSourceOccurrenceReceipts: receipts,
    scrapedPosts: posts,
    sourceOccurrences: [],
    sourceOccurrenceTopologyEpoch: [],
    venueIdentities: [identity],
    venues: [venue],
  };
}

function makeDb(initial) {
  const tableNames = Object.keys(initial);
  const tables = Object.fromEntries(
    tableNames.map((table) => [
      table,
      new Map(initial[table].map((row) => [row._id, structuredClone(row)])),
    ]),
  );
  let nextId = 1;

  function rowsFor(table, filters, direction) {
    const rows = [...tables[table].values()].filter((row) =>
      Object.entries(filters).every(([field, value]) => row[field] === value),
    );
    rows.sort((left, right) => {
      const comparison = String(left._id).localeCompare(String(right._id));
      return direction === "desc" ? -comparison : comparison;
    });
    return rows;
  }

  const db = {
    normalizeId(_table, id) {
      return typeof id === "string" && id.length > 0 ? id : null;
    },
    async get(id) {
      for (const table of Object.values(tables)) {
        if (table.has(id)) return table.get(id);
      }
      return null;
    },
    async insert(table, value) {
      const id = `${table}_inserted_${nextId++}`;
      tables[table].set(id, {
        _creationTime: 1000 + nextId,
        _id: id,
        ...structuredClone(value),
      });
      return id;
    },
    async patch(id, patch) {
      for (const table of Object.values(tables)) {
        if (!table.has(id)) continue;
        table.set(id, { ...table.get(id), ...structuredClone(patch) });
        return;
      }
      throw new Error(`Missing QA row ${id}.`);
    },
    async delete(id) {
      for (const table of Object.values(tables)) {
        if (table.delete(id)) return;
      }
      throw new Error(`Missing QA deletion ${id}.`);
    },
    query(table) {
      if (!tables[table]) tables[table] = new Map();
      const filters = {};
      let direction = "asc";
      const chain = {
        withIndex(_index, apply) {
          const builder = {
            eq(field, value) {
              filters[field] = value;
              return builder;
            },
          };
          apply(builder);
          return chain;
        },
        order(nextDirection) {
          direction = nextDirection;
          return chain;
        },
        async paginate({ cursor, numItems }) {
          const offset = cursor ? Number.parseInt(cursor, 10) : 0;
          const rows = rowsFor(table, filters, direction);
          const page = rows.slice(offset, offset + numItems);
          const nextOffset = offset + page.length;
          return {
            continueCursor: String(nextOffset),
            isDone: nextOffset >= rows.length,
            page,
          };
        },
        async take(limit) {
          return rowsFor(table, filters, direction).slice(0, limit);
        },
        async collect() {
          return rowsFor(table, filters, direction);
        },
        async unique() {
          const rows = rowsFor(table, filters, direction);
          assert.ok(rows.length <= 1);
          return rows[0] ?? null;
        },
};
      return chain;
    },
  };
  return { db, tables };
}

const state = makeDb(makeFixture());

const preview = await reattestCampaignLineageBatch._handler(
  { db: state.db },
  { cursor: null, dryRun: true, limit: 8 },
);
assert.equal(preview.reattestedCount, 1);
assert.equal(preview.quarantinedCount, 0);
assert.equal(state.tables.sourceOccurrences.size, 0);
assert.equal(state.tables.campaignLineageReattestations.size, 0);

const applied = await reattestCampaignLineageBatch._handler(
  { db: state.db },
  { cursor: null, dryRun: false, limit: 1 },
);
assert.equal(applied.reattestedCount, 1);
assert.equal(applied.quarantinedCount, 0);
assert.equal(applied.isDone, false);
await assert.rejects(
  reattestCampaignLineageBatch._handler(
    { db: state.db },
    { cursor: "999", dryRun: false, limit: 8 },
  ),
  /cursor does not match durable state/iu,
);
const completed = await reattestCampaignLineageBatch._handler(
  { db: state.db },
  { dryRun: false, limit: 8 },
);
assert.equal(completed.isDone, true);
assert.equal(state.tables.sourceOccurrences.size, 2);
assert.ok(
  [...state.tables.sourceOccurrences.values()].every(
    (occurrence) =>
      occurrence.canonicalEventId === primaryId &&
      occurrence.state === "satisfied" &&
      occurrence.venueId === venueId &&
      occurrence.venueResolutionStatus === "resolved",
  ),
);
assert.equal(
  [...state.tables.sourceOccurrences.values()].find(
    (occurrence) => occurrence.sourceOccurrenceKey === "qa-occurrence-b",
  ).occurrenceOrdinal,
  1,
  "Campaign re-attestation must preserve the exact receipt position instead of forcing ordinal zero.",
);
assert.ok(
  [...state.tables.instagramEventSources.values()].every(
    (link) => Boolean(link.sourceOccurrenceId),
  ),
);
const topology = [...state.tables.sourceOccurrenceTopologyEpoch.values()][0];
assert.equal(topology.currentEpoch, topology.verifiedEpoch);
assert.equal(
  [...state.tables.campaignLineageReattestations.values()][0].outcome,
  "reattested",
);

const rerun = await reattestCampaignLineageBatch._handler(
  { db: state.db },
  { dryRun: false, limit: 8, restartCompleted: true },
);
assert.equal(rerun.alreadyReattestedCount, 1);
assert.equal(rerun.reattestedCount, 0);
assert.equal(state.tables.sourceOccurrences.size, 2);

const variantOccurrence = [...state.tables.sourceOccurrences.values()].find(
  (occurrence) => occurrence.sourceOccurrenceKey === "qa-occurrence-b",
);
await state.db.patch(variantOccurrence._id, {
  occurrenceTitleFamily: "drifted-title-family",
});
const semanticRepair = await reattestCampaignLineageBatch._handler(
  { db: state.db },
  { dryRun: false, limit: 8, restartCompleted: true },
);
assert.equal(
  semanticRepair.reattestedCount,
  1,
  "A linked occurrence with semantic/signature drift is not already re-attested.",
);
assert.notEqual(
  state.tables.sourceOccurrences.get(variantOccurrence._id)
    .occurrenceTitleFamily,
  "drifted-title-family",
);

const quarantinedState = makeDb(makeFixture());
await quarantinedState.db.patch("post_1", { sourceRevision: 0 });
const quarantinePreview = await reattestCampaignLineageBatch._handler(
  { db: quarantinedState.db },
  { cursor: null, dryRun: true, limit: 8 },
);
assert.equal(quarantinePreview.quarantinedCount, 1);
assert.equal(quarantinedState.tables.campaignLineageReattestations.size, 0);
const quarantined = await reattestCampaignLineageBatch._handler(
  { db: quarantinedState.db },
  { cursor: null, dryRun: false, limit: 8 },
);
assert.equal(quarantined.quarantinedCount, 1);
assert.equal(quarantinedState.tables.sourceOccurrences.size, 0);
assert.equal(
  [...quarantinedState.tables.campaignLineageReattestations.values()][0]
    .outcome,
  "quarantined",
);

function makeVerifiedRetentionFixture() {
  const fixture = makeFixture();
  fixture.eventAuditLog = [];
  fixture.savedEvents = [];
  fixture.userSavedEvents = [];
  fixture.instagramSourceOccurrenceReceipts[1].expectedOccurrences[0].date = "2026-12-31";
  const attestation = JSON.parse(fixture.events[0].normalizedFieldsJson)
    .crossPostCampaignAggregateAttestation;
  for (let index = 0; index < fixture.events.length; index += 1) {
    const event = fixture.events[index];
    const primary = index === 0;
    event.instagramPostUrl = fixture.instagramEventSources[index].instagramPostUrl;
    event.status = primary ? "approved" : "rejected";
    event.moderationNote = `[cross_post_campaign_${primary ? "primary" : "variant"}:v${attestation.policyVersion}] ${operationId} - QA reviewed campaign`;
    const eventBefore = structuredClone(event);
    eventBefore.status = "approved";
    const fieldsBefore = JSON.parse(eventBefore.normalizedFieldsJson);
    delete fieldsBefore.crossPostCampaignAggregateAttestation;
    eventBefore.normalizedFieldsJson = JSON.stringify(fieldsBefore);
    fixture.eventAuditLog.push({
      _id: `campaign-original-audit-${index}`,
      _creationTime: index + 1,
      eventId: event._id,
      action: primary ? "cross_post_campaign_coalesced" : "cross_post_campaign_variant_rejected",
      createdAt: 1,
      patchJson: JSON.stringify({
        operationId,
        policyVersion: attestation.policyVersion,
        aggregateAttestation: attestation,
        sourceGroundingVerifiedAtCoalescing: true,
        eventBefore,
        sourceLinkBefore: fixture.instagramEventSources[index],
        receiptBefore: fixture.instagramSourceOccurrenceReceipts[index],
        receiptAfter: fixture.instagramSourceOccurrenceReceipts[index],
      }),
    });
  }
  return makeDb(fixture);
}

const retirementState = makeVerifiedRetentionFixture();
await reattestCampaignLineageBatch._handler(
  { db: retirementState.db },
  { dryRun: false, limit: 8 },
);
assert.ok(await loadVerifiedCampaignLineageReattestation(
  { db: retirementState.db },
  await retirementState.db.get(primaryId),
), "Retention must start from a real complete versioned campaign proof.");
const campaignCoverage = await auditSourceOccurrenceReceiptTopologyBatchHandler(
  { db: retirementState.db },
  { dryRun: false, limit: 4 },
);
assert.equal(campaignCoverage.mismatchCount, 0);
assert.equal(campaignCoverage.unchangedCount, 2);
assert.equal(campaignCoverage.isDone, true);

const duplicateReceipt = structuredClone(retirementState.tables.instagramSourceOccurrenceReceipts.get("receipt_b"));
duplicateReceipt._id = "receipt_b_duplicate";
duplicateReceipt.expectedOccurrences[1].date = "2026-12-31";
retirementState.tables.instagramSourceOccurrenceReceipts.set(duplicateReceipt._id, duplicateReceipt);
const duplicateReceiptCoverage = await auditSourceOccurrenceReceiptTopologyBatchHandler(
  { db: retirementState.db }, { dryRun: true, limit: 4 },
);
assert.equal(duplicateReceiptCoverage.mismatchCount, 2, "Neither duplicate receipt may borrow another receipt's campaign proof.");
const beforeDuplicateRetirement = structuredClone(Object.fromEntries(Object.entries(retirementState.tables).map(([name, rows]) => [name, [...rows.values()]])));
await assert.rejects(() => deleteExpiredEventWithSavedReferences(
  { db: retirementState.db }, retirementState.tables.events.get(primaryId),
  { isoDate: "2026-09-22", minutesSinceMidnight: 0 },
), /receipt changed/);
assert.deepEqual(Object.fromEntries(Object.entries(retirementState.tables).map(([name, rows]) => [name, [...rows.values()]])), beforeDuplicateRetirement, "Duplicate-receipt retirement must fail before every write.");
retirementState.tables.instagramSourceOccurrenceReceipts.delete(duplicateReceipt._id);

const unexpiredCampaign = await sourceOccurrenceProvenanceRepository.prepareExpiredCampaignRetirement(
  { db: retirementState.db },
  await retirementState.db.get(primaryId),
  { isoDate: expected.date, minutesSinceMidnight: 21 * 60 },
);
assert.equal(unexpiredCampaign, null, "A campaign with an unexpired event must remain intact.");

const proofBeforeCorruption = structuredClone([...retirementState.tables.campaignLineageReattestations.values()][0]);
await retirementState.db.patch(proofBeforeCorruption._id, { evidenceDigest: "0000000000000000" });
const corruptCoverage = await auditSourceOccurrenceReceiptTopologyBatchHandler(
  { db: retirementState.db },
  { dryRun: true, limit: 4 },
);
assert.equal(corruptCoverage.mismatchCount, 1, "A campaign marker without its exact verified proof cannot pass the receipt audit.");
const beforeBlockedDelete = structuredClone([...retirementState.tables.events.values()]);
const blockedDelete = await deleteExpiredEventWithSavedReferences(
  { db: retirementState.db },
  await retirementState.db.get(primaryId),
  { isoDate: "2026-09-22", minutesSinceMidnight: 0 },
);
assert.equal(blockedDelete.retainedEventCount, 1);
assert.deepEqual([...retirementState.tables.events.values()], beforeBlockedDelete);
await retirementState.db.patch(proofBeforeCorruption._id, proofBeforeCorruption);

const survivingReceipt = retirementState.tables.instagramSourceOccurrenceReceipts.get("receipt_b");
// An unsatisfied future sibling is deliberately outside the retired campaign.
// It must survive unchanged rather than having the entire source receipt erased.
const expectedSurvivingChild = structuredClone(survivingReceipt.expectedOccurrences[0]);
assert.equal(expectedSurvivingChild.date, "2026-12-31");
for (let attempt = 0; ; attempt += 1) {
  assert.ok(attempt < 10);
  const coverage = await auditRetentionReceiptCoverageBatch._handler({ db: retirementState.db }, {});
  if (coverage.isDone) { assert.equal(coverage.ready, true); break; }
}
const deletedCampaign = await deleteExpiredEventWithSavedReferences(
  { db: retirementState.db },
  await retirementState.db.get("event_variant"),
  { isoDate: "2026-09-22", minutesSinceMidnight: 0 },
);
assert.deepEqual(deletedCampaign.deletedEventIds.sort(), [primaryId, "event_variant"].sort());
assert.equal(retirementState.tables.events.size, 0);
assert.equal(retirementState.tables.instagramEventSources.size, 0);
assert.equal(retirementState.tables.sourceOccurrences.size, 2);
assert.ok([...retirementState.tables.sourceOccurrences.values()].every((row) =>
  row.state === "superseded" && row.canonicalEventId === undefined,
), "Expired campaign source occurrences remain detached tombstones.");
assert.deepEqual(retirementState.tables.instagramSourceOccurrenceReceipts.get("receipt_b").expectedOccurrences, [expectedSurvivingChild]);
assert.ok([...retirementState.tables.instagramSourceOccurrenceReceipts.values()].every((row) => row.satisfiedOccurrences.length === 0));
assert.equal([...retirementState.tables.eventAuditLog.values()].filter((row) => row.action === "expired_campaign_event_deleted").length, 2);

console.log(
  "Campaign-lineage re-attestation QA passed (dry-run, exact evidence materialization, idempotency, semantic repair, verified topology, and quarantine).",
);
