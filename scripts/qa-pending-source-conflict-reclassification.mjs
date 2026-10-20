import assert from "node:assert/strict";

import {
  previewPendingCinemaSourceConflictReclassificationHandler,
  reclassifyPendingCinemaSourceConflictsHandler,
} from "../convex/internal/eventRepairs/pendingSourceConflictReclassification.ts";
import {
  preparePendingCinemaSourceConflictReclassification,
} from "../lib/events/pending-source-conflict-reclassification.ts";
import { buildInstagramSourceOccurrenceFingerprint } from "../lib/domain/occurrences/source-fingerprint.ts";

const conflict = {
  field: "date",
  poster_value: "10. SEPTEMBAR",
  caption_value: "24 – 30. septembar",
  reason: "Poster image shows 'U BIOSKOPIMA 10. SEPTEMBAR' while caption lists the DKC program 24–30 Sept.",
};
const caption = "Filmski program:: DKC → 24 – 30. septembar 18:00 OASIS: Don’t Look Back In Anger";
const title = "OASIS: Don’t Look Back In Anger";
const venue = "Dvorana Kulturnog centra, Kolarčeva 6";
const date = "2026-09-26";
const sourceIdentity = "instagram-source-identity-v1:Ddli2yVFbp3";
const sourceFingerprint = buildInstagramSourceOccurrenceFingerprint({ caption });
const sourceOccurrenceKey = "example-occurrence";

function eventFixture() {
  const normalized = {
    extractionContractVersion: "event_evidence_v2",
    sourceConflictResolutionVersion: 1,
    extractionSourceConflicts: [conflict],
    extractionSourceConflictCount: 1,
    materialSourceConflicts: [conflict],
    materialSourceConflictCount: 1,
    benignSourceConflicts: [],
    benignSourceConflictCount: 0,
    sourceConflictFields: ["date"],
    extractionIsEvent: true,
    extractionNonEventReason: null,
    dateEvidenceVerified: true,
    timeEvidenceVerified: true,
    identityEvidenceVerified: true,
    venueEvidenceVerified: true,
    structuredEvidenceVerified: false,
    sourceOccurrencePlanUnverified: false,
    sourceOccurrenceAmbiguousProvenance: false,
    normalizedIsValid: true,
    approvalTitleSensible: true,
    dateSuspiciousYear: false,
    title,
    normalizedDate: date,
    normalizedVenue: venue,
    time: "18:00",
    artists: [],
    sourceGroundingSourceCaption: caption,
    sourceAccountRole: "venue",
    sourceAccountName: "DKC",
    sourceGroundingInstagramHandle: "dkc",
    splitEventTotal: 10,
    multiEventSplitDetected: true,
    sourceOccurrenceKey,
    sourceOccurrenceSourceFingerprint: sourceFingerprint,
    moderationPendingReasons: ["requires_human_approval", "poster_caption_conflict"],
    moderationSignals: ["requires_human_approval", "poster_caption_conflict"],
    moderationAutoApproved: false,
    moderationAutoApproveRule: null,
  };
  return {
    _id: "event-1",
    status: "pending",
    title,
    date,
    time: "18:00",
    venue,
    artists: [],
    sourceCaption: caption,
    instagramPostId: "qa-postid",
    sourceConflictFields: ["date"],
    sourceOccurrenceKey,
    normalizedFieldsJson: JSON.stringify(normalized),
    rawExtractionJson: JSON.stringify({
      extraction_contract_version: "event_evidence_v2",
      is_event: true,
      source_conflicts: [conflict],
    }),
    updatedAt: 100,
  };
}

function fakeContext(event) {
  const receipt = {
    _id: "receipt-1",
    sourceIdentity,
    sourceFingerprint,
    expectedKeys: [sourceOccurrenceKey],
    expectedOccurrences: [{ key: sourceOccurrenceKey, title, date, time: "18:00", venue, artists: [] }],
    satisfiedKeys: [sourceOccurrenceKey],
    satisfiedOccurrences: [{ key: sourceOccurrenceKey, eventId: event._id }],
    deferredChildCount: 0,
    deferredChildKeys: [],
    createdAt: 1,
    updatedAt: 200,
  };
  const link = {
    _id: "link-1",
    eventId: event._id,
    sourceOccurrenceId: "occurrence-1",
    sourceIdentity,
    sourceFingerprint,
    sourceOccurrenceKey,
    updatedAt: 300,
  };
  const occurrence = {
    _id: "occurrence-1",
    state: "satisfied",
    canonicalEventId: event._id,
    sourceIdentity,
    sourceFingerprint,
    sourceOccurrenceKey,
    sourceDocumentId: "source-1",
    sourceRevision: 1,
  };
  const source = {
    _id: "source-1",
    handle: "dkc",
    username: "dkc",
    postId: event.instagramPostId,
    instagramPostUrl: "https://www.instagram.com/p/Ddli2yVFbp3/",
    caption,
    sourceRevision: 1,
    analysisRevision: 1,
    analysisContractVersion: "event_evidence_v2",
    analysisIsEvent: true,
    analysisModel: "gpt-5-mini-2025-08-07",
    analysisResultJson: event.rawExtractionJson,
  };
  const records = new Map([
    [event._id, event], [receipt._id, receipt], [link._id, link],
    [occurrence._id, occurrence], [source._id, source],
  ]);
  const audits = [];
  const context = {
    auth: { getUserIdentity: async () => null },
    db: {
      get: async (id) => records.get(id) ?? null,
      patch: async (id, patch) => records.set(id, { ...records.get(id), ...patch }),
      insert: async (table, record) => {
        assert.equal(table, "eventAuditLog");
        audits.push(record);
        return `audit-${audits.length}`;
      },
      query: (table) => ({
        withIndex: () => ({
          take: async (limit) =>
            (table === "instagramSourceOccurrenceReceipts" ? [receipt] :
              table === "instagramEventSources" ? [link] :
                table === "scrapedPosts" ? [source] : [])
              .slice(0, limit),
        }),
      }),
    },
  };
  return { context, records, receipt, link, audits };
}

const originalSecret = process.env.CRON_SECRET;
process.env.CRON_SECRET = "qa-pending-conflict-secret";
try {
  const event = eventFixture();
  const originalRaw = event.rawExtractionJson;
  const originalSourceFacts = { title: event.title, date: event.date, venue: event.venue, artists: event.artists };
  const prepared = preparePendingCinemaSourceConflictReclassification(event);
  const fields = JSON.parse(prepared.normalizedFieldsJson);
  assert.deepEqual(fields.materialSourceConflicts, []);
  assert.deepEqual(fields.benignSourceConflicts, [conflict]);
  assert.equal(fields.structuredEvidenceVerified, true);
  assert.deepEqual(fields.moderationPendingReasons, ["requires_human_approval"]);
  assert.equal(fields.moderationAutoApproved, false);
  assert.equal(fields.moderationAutoApproveRule, null);

  const unverifiedTitle = eventFixture();
  const unverifiedFields = JSON.parse(unverifiedTitle.normalizedFieldsJson);
  unverifiedFields.identityEvidenceVerified = false;
  unverifiedFields.title = "I I SINOVI";
  unverifiedFields.moderationPendingReasons.splice(1, 0, "invalid_identity_evidence");
  unverifiedFields.moderationSignals.splice(1, 0, "invalid_identity_evidence");
  unverifiedTitle.title = "I I SINOVI";
  unverifiedTitle.sourceCaption += " I I SINOVI";
  unverifiedFields.sourceGroundingSourceCaption = unverifiedTitle.sourceCaption;
  unverifiedTitle.normalizedFieldsJson = JSON.stringify(unverifiedFields);
  const unverifiedNext = JSON.parse(
    preparePendingCinemaSourceConflictReclassification(unverifiedTitle).normalizedFieldsJson,
  );
  assert.equal(unverifiedNext.identityEvidenceVerified, false);
  assert.equal(unverifiedNext.structuredEvidenceVerified, false);
  assert.deepEqual(unverifiedNext.moderationPendingReasons,
    ["requires_human_approval", "invalid_identity_evidence"]);

  const { context, records, receipt, link, audits } = fakeContext(event);
  receipt.deferredChildCount = 1;
  receipt.deferredChildKeys = ["deferred-sibling"];
  await assert.rejects(
    previewPendingCinemaSourceConflictReclassificationHandler(context, {
      sourceIdentity,
      eventIds: [event._id],
      serviceSecret: process.env.CRON_SECRET,
    }),
    /complete unique receipt/u,
  );
  receipt.deferredChildCount = 0;
  receipt.deferredChildKeys = [];
  const source = records.get("source-1");
  source.analysisRevision = 2;
  await assert.rejects(
    previewPendingCinemaSourceConflictReclassificationHandler(context, {
      sourceIdentity,
      eventIds: [event._id],
      serviceSecret: process.env.CRON_SECRET,
    }),
    /current source revision/u,
  );
  source.analysisRevision = 1;
  const preview = await previewPendingCinemaSourceConflictReclassificationHandler(context, {
    sourceIdentity,
    eventIds: [event._id],
    serviceSecret: process.env.CRON_SECRET,
  });
  assert.equal(preview.items.length, 1);
  assert.equal(preview.items[0].previousMaterialCount, 1);
  assert.equal(preview.items[0].nextBenignCount, 1);
  assert.equal(records.get(event._id).normalizedFieldsJson, event.normalizedFieldsJson);
  assert.equal(audits.length, 0);

  const applyArgs = {
    sourceIdentity: preview.sourceIdentity,
    expectedReceiptId: preview.expectedReceiptId,
    expectedReceiptUpdatedAt: preview.expectedReceiptUpdatedAt,
    expectedSourceFingerprint: preview.expectedSourceFingerprint,
    items: preview.items.map(({ previousMaterialCount, nextBenignCount, ...item }) => item),
    serviceSecret: process.env.CRON_SECRET,
  };
  await assert.rejects(
    reclassifyPendingCinemaSourceConflictsHandler(context, {
      ...applyArgs,
      expectedReceiptUpdatedAt: preview.expectedReceiptUpdatedAt - 1,
    }),
    /receipt version changed/u,
  );
  await assert.rejects(
    reclassifyPendingCinemaSourceConflictsHandler(context, {
      ...applyArgs,
      items: [{ ...applyArgs.items[0], expectedSourceLinkUpdatedAt: link.updatedAt - 1 }],
    }),
    /version changed/u,
  );
  await assert.rejects(
    reclassifyPendingCinemaSourceConflictsHandler(context, {
      ...applyArgs,
      items: [{ ...applyArgs.items[0], expectedUpdatedAt: event.updatedAt - 1 }],
    }),
    /version changed/u,
  );
  assert.equal(audits.length, 0);
  const result = await reclassifyPendingCinemaSourceConflictsHandler(context, applyArgs);
  assert.equal(result.updatedCount, 1);
  const updated = records.get(event._id);
  assert.equal(updated.status, "pending");
  assert.equal(updated.rawExtractionJson, originalRaw);
  assert.deepEqual(
    { title: updated.title, date: updated.date, venue: updated.venue, artists: updated.artists },
    originalSourceFacts,
  );
  assert.deepEqual(updated.sourceConflictFields, []);
  assert.deepEqual(JSON.parse(updated.normalizedFieldsJson).materialSourceConflicts, []);
  assert.equal(records.get(receipt._id).updatedAt, receipt.updatedAt);
  assert.equal(records.get(link._id).updatedAt, link.updatedAt);
  assert.equal(audits.length, 1);
  await assert.rejects(
    reclassifyPendingCinemaSourceConflictsHandler(context, applyArgs),
    /verified cinema candidate|version changed/u,
  );

  const wrongFilm = eventFixture();
  wrongFilm.title = "Unrelated film";
  assert.throws(
    () => preparePendingCinemaSourceConflictReclassification(wrongFilm),
    /verified cinema candidate|non-cinema material conflict/u,
  );
  const crossRowArtist = eventFixture();
  const artistFields = JSON.parse(crossRowArtist.normalizedFieldsJson);
  const artistConflict = {
    field: "artists",
    poster_value: "COJKE - ALL NIGHTER",
    caption_value: "@tavan.belgrade",
    reason: "Different artists appear in poster and caption.",
  };
  artistFields.extractionSourceConflicts = [artistConflict];
  artistFields.materialSourceConflicts = [artistConflict];
  artistFields.sourceConflictFields = ["artists"];
  crossRowArtist.sourceConflictFields = ["artists"];
  crossRowArtist.normalizedFieldsJson = JSON.stringify(artistFields);
  crossRowArtist.rawExtractionJson = JSON.stringify({ is_event: true, source_conflicts: [artistConflict] });
  assert.throws(
    () => preparePendingCinemaSourceConflictReclassification(crossRowArtist),
    /verified cinema candidate/u,
  );
  const tamperedRaw = eventFixture();
  tamperedRaw.rawExtractionJson = JSON.stringify({ is_event: true, source_conflicts: [] });
  assert.throws(
    () => preparePendingCinemaSourceConflictReclassification(tamperedRaw),
    /verified cinema candidate/u,
  );
  console.log("Pending cinema source-conflict reclassification QA passed.");
} finally {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
}
