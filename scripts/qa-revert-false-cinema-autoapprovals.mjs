import assert from "node:assert/strict";
import {
  applyFalseCinemaAutomaticApprovalReversalHandler,
  previewFalseCinemaAutomaticApprovalReversalHandler,
} from "../convex/internal/eventRepairs/revertFalseCinemaAutomaticApproval.ts";
import { buildInstagramSourceOccurrenceFingerprint } from "../lib/domain/occurrences/source-fingerprint.ts";

const eventIds = [
  "j574fb8vtkvxv039pzvknamq458ey23a",
  "j5773jdyck0k1sp39h9y55g7g98ezd5j",
  "j5781tvm1qjdyehn625kmjvc7x8ey9x8",
  "j57c0hgkd60ksyr3g5jb63wpqs8eynp4",
];
const dates = ["2026-09-29", "2026-09-28", "2026-09-30", "2026-09-27"];
const sourceIdentity = "instagram-source-identity-v1:Ddli2yVFbp3";
const sourceCaption = "Filmski program 24 – 30. septembar. 20:00 𝐈 𝐒𝐈𝐍𝐎𝐕𝐈";
const sourceUrl = "https://www.instagram.com/p/Ddli2yVFbp3/";
const scheduleEntries = dates.map((date) => ({
  title: "I I SINOVI",
  date,
  source_text: "20:00 I I SINOVI",
  date_evidence: { resolved_date: date },
}));
const rawExtractionJson = JSON.stringify({
  extraction_contract_version: "event_evidence_v2",
  is_event: true,
  schedule_entries: scheduleEntries,
});

function fixture() {
  const source = {
    _id: "source-cinema",
    handle: "kulturni_centar_beograda",
    username: "kulturni_centar_beograda",
    postId: "3991749943207770743",
    instagramPostUrl: sourceUrl,
    caption: sourceCaption,
    imageUrls: [],
    postedAt: "2026-09-23T12:00:00.000Z",
    sourceRevision: 1,
    analysisRevision: 1,
    analysisContractVersion: "event_evidence_v2",
    analysisIsEvent: true,
    analysisModel: "gpt-5-mini-2025-08-07",
    analysisResultJson: rawExtractionJson,
    createdAt: 1,
    updatedAt: 2,
  };
  const fingerprint = buildInstagramSourceOccurrenceFingerprint(source);
  const expectedOccurrences = eventIds.map((id, index) => ({
    key: `key-${index}`,
    date: dates[index],
    title: "I I SINOVI",
    time: "20:00",
    venue: "DKC",
    artists: [],
  }));
  const receipt = {
    _id: "mh75d6rya6k597g4639w2we9ss8ezydx",
    sourceIdentity,
    sourceFingerprint: fingerprint,
    expectedKeys: expectedOccurrences.map((item) => item.key),
    expectedOccurrences,
    satisfiedKeys: expectedOccurrences.map((item) => item.key),
    satisfiedOccurrences: expectedOccurrences.map((item, index) => ({
      key: item.key, eventId: eventIds[index],
    })),
    deferredChildCount: 0,
    deferredChildKeys: [],
    createdAt: 1,
    updatedAt: 3,
  };
  const events = eventIds.map((id, index) => ({
    _id: id,
    title: "I I SINOVI",
    date: dates[index],
    time: "20:00",
    venue: "DKC",
    artists: [],
    eventType: "film",
    status: "approved",
    publicationState: "publishable",
    sourceCaption,
    sourcePostedAt: source.postedAt,
    instagramPostId: source.postId,
    instagramPostUrl: sourceUrl,
    sourceOccurrenceKey: expectedOccurrences[index].key,
    sourceConflictFields: [],
    rawExtractionJson,
    normalizedFieldsJson: JSON.stringify({
      extractionContractVersion: "event_evidence_v2",
      extractionIsEvent: true,
      sourceGroundingInstagramHandle: source.handle,
      sourceOccurrenceKey: expectedOccurrences[index].key,
      sourceOccurrenceSourceFingerprint: fingerprint,
      splitEventIndex: index + 1,
      rowSourceText: "20:00 I I SINOVI",
      title: "I I SINOVI",
      normalizedDate: dates[index],
      time: "20:00",
      normalizedVenue: "DKC",
      artists: [],
      identityEvidenceVerified: false,
      structuredEvidenceVerified: false,
      automaticUniqueApprovalPolicyVersion: 1,
      moderationAutoApproved: true,
      moderationAutoApproveRule: "server_verified_unique_v1",
      moderationPendingReasons: [],
      moderationSignals: ["missing_image_allowed", "invalid_identity_evidence"],
    }),
    automaticUniqueApprovalPolicyVersion: 1,
    createdAt: 1,
    updatedAt: 10 + index,
  }));
  const links = eventIds.map((id, index) => ({
    _id: `link-${index}`,
    eventId: id,
    sourceIdentity,
    sourceFingerprint: fingerprint,
    sourceOccurrenceKey: expectedOccurrences[index].key,
    sourceOccurrenceId: `occurrence-${index}`,
    updatedAt: 20 + index,
  }));
  const occurrences = eventIds.map((id, index) => ({
    _id: `occurrence-${index}`,
    canonicalEventId: id,
    state: "satisfied",
    sourceDocumentId: source._id,
    sourceRevision: 1,
    sourceIdentity,
    sourceFingerprint: fingerprint,
    sourceOccurrenceKey: expectedOccurrences[index].key,
  }));
  const tables = {
    events,
    scrapedPosts: [source],
    instagramSourceOccurrenceReceipts: [receipt],
    instagramEventSources: links,
    sourceOccurrences: occurrences,
  };
  const records = new Map(Object.values(tables).flat().map((row) => [row._id, row]));
  const audits = [];
  const ctx = {
    auth: { getUserIdentity: async () => null },
    db: {
      get: async (id) => records.get(id) ?? null,
      patch: async (id, patch) => {
        const row = records.get(id);
        assert.ok(row);
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) delete row[key];
          else row[key] = structuredClone(value);
        }
      },
      insert: async (table, value) => {
        assert.equal(table, "eventAuditLog");
        audits.push(value);
        return `audit-${audits.length}`;
      },
      query: (table) => ({
        withIndex: (_index, callback) => {
          const equals = [];
          const builder = { eq: (key, value) => { equals.push([key, value]); return builder; } };
          callback(builder);
          return {
            take: async (limit) => (tables[table] ?? [])
              .filter((row) => equals.every(([key, value]) => row[key] === value))
              .slice(0, limit),
          };
        },
      }),
    },
  };
  return { ctx, audits, records, source, receipt, events, links, occurrences };
}

const originalSecret = process.env.CRON_SECRET;
process.env.CRON_SECRET = "qa-false-cinema-reversal-secret";
try {
  const state = fixture();
  await assert.rejects(
    previewFalseCinemaAutomaticApprovalReversalHandler(state.ctx, { serviceSecret: "wrong" }),
    /Authentication required/u,
  );
  const preview = await previewFalseCinemaAutomaticApprovalReversalHandler(state.ctx, {
    serviceSecret: process.env.CRON_SECRET,
  });
  assert.equal(preview.items.length, 4);
  const beforeSource = structuredClone(state.source);
  const beforeReceipt = structuredClone(state.receipt);
  const beforeLinks = structuredClone(state.links);
  const beforeOccurrences = structuredClone(state.occurrences);
  const versions = preview.items.map(({ title, date, ...item }) => item);
  const applyArgs = {
    sourceId: preview.sourceId,
    sourceUpdatedAt: preview.sourceUpdatedAt,
    receiptId: preview.receiptId,
    receiptUpdatedAt: preview.receiptUpdatedAt,
    sourceFingerprint: preview.sourceFingerprint,
    items: versions,
    serviceSecret: process.env.CRON_SECRET,
  };
  await assert.rejects(
    applyFalseCinemaAutomaticApprovalReversalHandler(state.ctx, {
      ...applyArgs,
      items: [{ ...versions[0], expectedUpdatedAt: versions[0].expectedUpdatedAt - 1 }, ...versions.slice(1)],
    }),
    /event version changed/u,
  );
  await assert.rejects(
    applyFalseCinemaAutomaticApprovalReversalHandler(state.ctx, {
      ...applyArgs, receiptUpdatedAt: preview.receiptUpdatedAt - 1,
    }),
    /receipt version changed/u,
  );
  assert.equal(state.audits.length, 0);
  const result = await applyFalseCinemaAutomaticApprovalReversalHandler(state.ctx, applyArgs);
  assert.equal(result.updatedCount, 4);
  for (const event of state.events) {
    assert.equal(event.status, "pending");
    assert.equal(event.automaticUniqueApprovalPolicyVersion, undefined);
    assert.notEqual(event.publicationState, "publishable");
    const fields = JSON.parse(event.normalizedFieldsJson);
    assert.equal(fields.automaticUniqueApprovalPolicyVersion, undefined);
    assert.equal(fields.moderationAutoApproved, false);
    assert.equal(fields.moderationAutoApproveRule, null);
    assert.deepEqual(fields.moderationPendingReasons,
      ["requires_human_approval", "invalid_identity_evidence"]);
    assert.deepEqual(fields.moderationSignals,
      ["requires_human_approval", "missing_image_allowed", "invalid_identity_evidence"]);
    assert.equal(fields.identityEvidenceVerified, false);
    assert.equal(fields.structuredEvidenceVerified, false);
    assert.equal(event.title, "I I SINOVI");
    assert.equal(event.rawExtractionJson, rawExtractionJson);
  }
  assert.deepEqual(state.source, beforeSource);
  assert.deepEqual(state.receipt, beforeReceipt);
  assert.deepEqual(state.links, beforeLinks);
  assert.deepEqual(state.occurrences, beforeOccurrences);
  assert.equal(state.audits.length, 4);
  await assert.rejects(
    applyFalseCinemaAutomaticApprovalReversalHandler(state.ctx, applyArgs),
    /changed/u,
  );
  console.log("False cinema autoapproval reversal QA passed: exact four, version fences, pending publication, unchanged source topology.");
} finally {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
}
