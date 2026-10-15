import assert from "node:assert/strict";
import { buildInstagramSourceOccurrenceFingerprint } from "../lib/domain/occurrences/source-fingerprint.ts";
import {
  getReviewedPendingPerformerCorrectionContextHandler,
  repairReviewedPendingPerformerCorrectionHandler,
} from "../convex/internal/eventRepairs/reviewedPendingPerformerCorrection.ts";

function fixture() {
  const url = "https://www.instagram.com/p/DeY0xd0MM2_/";
  const caption = "Thursday | 15.10. — @posle22; Friday | 16.10. — @guzva011";
  const checksum = "98afefa7988d856fd40fcf679116cba6b73fa9d1224c779cd8ceeac3d295229b";
  const rawExtractionJson = JSON.stringify({ extraction_contract_version: "event_evidence_v2",
    is_event: true, source_url: url, source_caption: caption,
    schedule_entries: [{ date: "2026-10-15", title: "POSLE 22", artists: ["TLESSI"] }] });
  const source = { _id: "source", handle: "vinyl.belgrade", username: "vinyl.belgrade",
    postId: "4006183966233120191", instagramPostUrl: url, caption, imageUrls: [],
    postedAt: "2026-10-12T08:45:47.000Z", sourceRevision: 1, analysisRevision: 1,
    analysisContractVersion: "event_evidence_v2", analysisIsEvent: true,
    analysisModel: "gpt-6-luna", analysisResultJson: rawExtractionJson,
    analysisImageSourceUrl: "https://instagram.example/poster.jpg", analysisImageChecksumSha256: checksum,
    imageStorageId: "storage", processingStatus: "retryable_failure",
    processingOutcome: "incomplete_occurrence_receipt", createdAt: 1, updatedAt: 2 };
  const sourceIdentity = "instagram-source-identity-v1:DeY0xd0MM2_";
  const sourceFingerprint = buildInstagramSourceOccurrenceFingerprint(source);
  const expectedOccurrences = Array.from({ length: 5 }, (_, index) => ({
    key: `key-${index}`, date: `2026-10-${14 + index}`, time: "TBD", venue: "Vinyl",
    title: index === 1 ? "POSLE 22" : `Program ${index}`,
    artists: index === 1 ? ["TLESSI"] : [`Artist ${index}`],
    factsJson: JSON.stringify({ artistClaims: index === 1 ? ["TLESSI"] : [`Artist ${index}`],
      localDate: `2026-10-${14 + index}`, titleClaim: index === 1 ? "POSLE 22" : `Program ${index}`,
      evidence: [], policy: { approvalDisposition: "pending", pendingReasons: [], signals: [], structuredEvidenceVerified: true } }),
    canonicalEventJson: JSON.stringify({ normalizedFieldsJson: "{}", requestedStatus: "pending",
      sourceConflictFields: [], timeConfidence: 0, timeSource: "unknown", timeStatus: "unknown" }),
  }));
  const receipt = { _id: "receipt", sourceIdentity, sourceFingerprint,
    expectedKeys: expectedOccurrences.map((row) => row.key), expectedOccurrences,
    satisfiedKeys: expectedOccurrences.slice(1).map((row) => row.key),
    satisfiedOccurrences: expectedOccurrences.slice(1).map((row, index) => ({ key: row.key, eventId: `event-${index + 1}` })),
    deferredChildCount: 0, deferredChildKeys: [], createdAt: 1, updatedAt: 3 };
  const events = expectedOccurrences.slice(1).map((expected, index) => ({
    _id: `event-${index + 1}`, title: expected.title, date: expected.date, time: "TBD",
    timeSource: "unknown", timeEvidenceKind: "not_stated", timeStatus: "unknown",
    venue: "Vinyl", venueId: "venue", normalizedVenueIdentity: "vinyl",
    artists: [...expected.artists], description: index === 0 ? "Club program featuring TLESSI." : "Original description",
    eventType: "nightlife", status: index === 0 ? "pending" : "approved",
    sourceCaption: caption, sourcePostedAt: source.postedAt, instagramPostId: source.postId,
    instagramPostUrl: url, sourceOccurrenceKey: expected.key, rawExtractionJson,
    imageUrl: "https://storage.example/poster", imageStorageId: "storage",
    normalizedFieldsJson: JSON.stringify({ extractionContractVersion: "event_evidence_v2", extractionIsEvent: true,
      sourceGroundingVersion: 5, sourceGroundingEvidence: "persisted_openai_event_evidence_v2",
      sourceGroundingInstagramHandle: "vinyl.belgrade", sourceGroundingSourceCaption: caption,
      sourceOccurrenceKey: expected.key, sourceOccurrenceSourceFingerprint: sourceFingerprint,
      sourceOccurrencePlanUnverified: index === 0,
      title: expected.title, normalizedDate: expected.date, normalizedVenue: "Vinyl", time: "TBD",
      artists: expected.artists, extractionMode: "poster", moderationAutoApproved: false,
      moderationPendingReasons: ["requires_human_approval", "unusable_event_title"],
      moderationSignals: ["time_tbd"], sourceGroundingVerified: false,
      rowSourceText: "15.10. POSLE 22 — TLESSI" }), createdAt: 1, updatedAt: 10 + index,
  }));
  const occurrences = expectedOccurrences.map((expected, index) => ({
    _id: `occ-${index}`, sourceIdentity, sourceFingerprint, sourceOccurrenceKey: expected.key,
    sourceDocumentId: source._id, sourceRevision: 1, state: index === 0 ? "expected" : "satisfied",
    ...(index > 0 ? { canonicalEventId: `event-${index}` } : {}),
    factsJson: expected.factsJson, canonicalEventJson: expected.canonicalEventJson,
    normalizedOccurrenceJson: JSON.stringify(expected), occurrenceArtistFingerprint: index === 1 ? "tlessi" : `artist${index}`,
    updatedAt: 20 + index,
  }));
  const links = events.map((event, index) => ({ _id: `link-${index + 1}`, eventId: event._id,
    sourceIdentity, sourceFingerprint, sourceOccurrenceKey: event.sourceOccurrenceKey,
    sourceOccurrenceId: occurrences[index + 1]._id, instagramPostId: source.postId,
    instagramPostUrl: url, sourceHandle: source.handle, updatedAt: 30 + index }));
  const asset = { _id: "asset", sourceKey: `instagram-post:${source.postId}`, storageId: "storage",
    checksumSha256: checksum, url: events[0].imageUrl };
  const epoch = { _id: "epoch", key: "source-occurrence-topology-v1", currentEpoch: 0, verifiedEpoch: 0 };
  const tables = { events, scrapedPosts: [source], instagramEventSources: links,
    instagramSourceOccurrenceReceipts: [receipt], sourceOccurrences: occurrences,
    mediaAssets: [asset], sourceOccurrenceTopologyEpoch: [epoch], eventAuditLog: [] };
  const writes = [];
  const ctx = { auth: { getUserIdentity: async () => null }, db: {
    get: async (id) => Object.values(tables).flat().find((row) => row._id === id) ?? null,
    patch: async (id, patch) => { const row = Object.values(tables).flat().find((item) => item._id === id);
      assert.ok(row, `missing ${id}`); Object.assign(row, structuredClone(patch)); writes.push({ id, patch: structuredClone(patch) }); },
    insert: async (table, row) => { tables[table].push({ ...structuredClone(row), _id: `${table}-${tables[table].length}` }); return `${table}-new`; },
    query: (table) => ({ withIndex: (_name, callback) => {
      const equals = []; const builder = { eq: (key, value) => { equals.push([key, value]); return builder; } };
      callback(builder); return { take: async (limit) => {
        assert.ok(limit <= 65, "all reads remain bounded");
        return tables[table].filter((row) => equals.every(([key, value]) => row[key] === value)).slice(0, limit);
      } };
    } }),
  } };
  const args = { id: events[0]._id, expectedUpdatedAt: events[0].updatedAt,
    expectedNormalizedFieldsJson: events[0].normalizedFieldsJson, expectedSourceLinkId: links[0]._id,
    expectedSourceLinkUpdatedAt: links[0].updatedAt, expectedReceiptId: receipt._id,
    expectedReceiptUpdatedAt: receipt.updatedAt, expectedSourceId: source._id,
    expectedSourceUpdatedAt: source.updatedAt, expectedSourceRevision: 1,
    expectedOccurrenceId: occurrences[1]._id, expectedOccurrenceUpdatedAt: occurrences[1].updatedAt,
    expectedFactsJson: occurrences[1].factsJson, expectedPosterChecksumSha256: checksum,
    nextArtists: ["TILESSI"], nextDescription: "Club program featuring TILESSI.",
    posterRowEvidence: "15.10. POSLE 22 — TILESSI", posterArtistEvidence: ["TILESSI"],
    moderationNote: "Retained dated poster row visually confirms TILESSI, correcting OCR only; keep pending.",
    serviceSecret: "qa-pending-performer-secret" };
  return { ctx, args, tables, events, links, receipt, occurrences, source, asset, writes };
}

const originalSecret = process.env.CRON_SECRET;
const originalAdminIds = process.env.ADMIN_CLERK_USER_IDS;
process.env.CRON_SECRET = "qa-pending-performer-secret";
try {
  const state = fixture();
  const before = structuredClone(state.tables);
  const context = await getReviewedPendingPerformerCorrectionContextHandler(state.ctx, {
    id: state.args.id, serviceSecret: state.args.serviceSecret,
  });
  assert.equal(context.receipt.expectedKeys.length, 5);
  assert.equal(context.receipt.satisfiedKeys.length, 4);
  assert.equal(state.writes.length, 0, "planning is read-only");
  const result = await repairReviewedPendingPerformerCorrectionHandler(state.ctx, state.args);
  assert.equal(result.status, "pending");
  assert.equal(state.events[0].status, "pending");
  assert.notEqual(state.events[0].publicationState, "publishable");
  assert.deepEqual(state.events[0].artists, ["TILESSI"]);
  assert.deepEqual(JSON.parse(state.events[0].normalizedFieldsJson).artists, ["TILESSI"]);
  assert.equal(JSON.parse(state.events[0].normalizedFieldsJson).sourceGroundingVerified, false);
  assert.equal(JSON.parse(state.events[0].normalizedFieldsJson).moderationAutoApproved, false);
  assert.ok(JSON.parse(state.events[0].normalizedFieldsJson).moderationPendingReasons.includes("unusable_event_title"));
  assert.equal(state.occurrences[1].occurrenceArtistFingerprint, "tilessi");
  assert.deepEqual(JSON.parse(state.occurrences[1].normalizedOccurrenceJson).artists, ["TILESSI"]);
  assert.deepEqual(JSON.parse(state.occurrences[1].factsJson).artistClaims, ["TLESSI"]);
  assert.equal(state.occurrences[1].factsJson, before.sourceOccurrences[1].factsJson);
  assert.equal(state.occurrences[1].canonicalEventJson, before.sourceOccurrences[1].canonicalEventJson);
  assert.deepEqual(state.source, before.scrapedPosts[0], "analysis, lease, retry and source unchanged");
  assert.deepEqual(state.links, before.instagramEventSources);
  assert.deepEqual(state.events.slice(1), before.events.slice(1), "all siblings byte-exact");
  assert.deepEqual(state.occurrences.filter((_, i) => i !== 1), before.sourceOccurrences.filter((_, i) => i !== 1));
  for (const field of ["rawExtractionJson", "sourceCaption", "sourcePostedAt", "instagramPostId", "instagramPostUrl",
    "date", "time", "timeSource", "timeEvidenceKind", "timeStatus", "venue", "venueId", "imageUrl", "imageStorageId"]) {
    assert.deepEqual(state.events[0][field], before.events[0][field], `preserve ${field}`);
  }
  assert.deepEqual(state.receipt.satisfiedKeys, before.instagramSourceOccurrenceReceipts[0].satisfiedKeys);
  assert.deepEqual(state.receipt.satisfiedOccurrences, before.instagramSourceOccurrenceReceipts[0].satisfiedOccurrences);
  assert.deepEqual(state.receipt.expectedKeys, before.instagramSourceOccurrenceReceipts[0].expectedKeys);
  assert.equal(state.receipt.expectedOccurrences.length, 5);
  assert.deepEqual(state.receipt.expectedOccurrences[1].artists, ["TILESSI"]);
  assert.deepEqual(state.receipt.expectedOccurrences.filter((_, i) => i !== 1),
    before.instagramSourceOccurrenceReceipts[0].expectedOccurrences.filter((_, i) => i !== 1));
  assert.equal(state.tables.eventAuditLog.length, 1);
  assert.deepEqual(JSON.parse(state.tables.eventAuditLog[0].patchJson).previousArtists, ["TLESSI"]);
  const afterContext = await getReviewedPendingPerformerCorrectionContextHandler(state.ctx, {
    id: state.args.id, serviceSecret: state.args.serviceSecret,
  });
  assert.deepEqual(afterContext.event.artists, ["TILESSI"]);
  assert.deepEqual(JSON.parse(afterContext.occurrence.factsJson).artistClaims, ["TLESSI"]);
  const adminState = fixture();
  process.env.ADMIN_CLERK_USER_IDS = "qa-admin";
  adminState.ctx.auth.getUserIdentity = async () => ({ subject: "qa-admin" });
  await assert.rejects(getReviewedPendingPerformerCorrectionContextHandler(adminState.ctx, {
    id: adminState.args.id, serviceSecret: "wrong",
  }), /service authentication/u);
  await assert.rejects(repairReviewedPendingPerformerCorrectionHandler(adminState.ctx, {
    ...adminState.args, serviceSecret: "wrong",
  }), /service authentication/u);
  assert.equal(adminState.writes.length, 0, "a logged-in admin cannot bypass service-only evidence repair");
  await assert.rejects(repairReviewedPendingPerformerCorrectionHandler(state.ctx, state.args), /changed|version/u);

  for (const patch of [
    { serviceSecret: "wrong" }, { expectedUpdatedAt: 9 }, { expectedNormalizedFieldsJson: "{}" },
    { expectedSourceLinkUpdatedAt: 1 }, { expectedReceiptUpdatedAt: 1 },
    { expectedSourceUpdatedAt: 1 }, { expectedSourceRevision: 2 }, { expectedOccurrenceUpdatedAt: 1 },
    { expectedFactsJson: "{}" }, { expectedPosterChecksumSha256: "a".repeat(64) },
    { nextArtists: [] }, { nextArtists: [""] }, { nextArtists: [" TILESSI"] },
    { nextArtists: ["TILESSI", "TILESSI"] }, { posterArtistEvidence: ["another artist"] },
    { posterRowEvidence: "16.10. POSLE 22 — TILESSI" }, { posterRowEvidence: "15.10. OTHER — TILESSI" },
    { nextDescription: "" }, { moderationNote: "short" },
  ]) {
    const invalid = fixture();
    await assert.rejects(repairReviewedPendingPerformerCorrectionHandler(invalid.ctx, { ...invalid.args, ...patch }));
    assert.equal(invalid.writes.length, 0, JSON.stringify(patch));
  }
  for (const corrupt of [
    (s) => { s.events[0].status = "approved"; },
    (s) => { s.events[0].rawExtractionJson = "{}"; },
    (s) => { s.events[0].sourceCaption = "changed caption"; },
    (s) => { s.source.analysisRevision = 0; },
    (s) => { s.source.updatedAt += 1; },
    (s) => { s.source.processingStatus = "processing"; },
    (s) => { s.asset.checksumSha256 = "b".repeat(64); },
    (s) => { s.occurrences[1].sourceRevision = 0; },
    (s) => { s.receipt.satisfiedOccurrences[1].eventId = "missing sibling"; },
    (s) => { s.events[1].normalizedFieldsJson = "{}"; s.events[1].artists = ["wrong sibling"]; },
  ]) {
    const invalid = fixture(); corrupt(invalid);
    await assert.rejects(repairReviewedPendingPerformerCorrectionHandler(invalid.ctx, invalid.args));
    assert.equal(invalid.writes.length, 0, "corrupt evidence rejected before writes");
  }
  console.log("QA passed: reviewed pending performer correction fences current retained poster evidence, preserves immutable facts and incomplete receipt/siblings, and keeps pending.");
} finally {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
  if (originalAdminIds === undefined) delete process.env.ADMIN_CLERK_USER_IDS;
  else process.env.ADMIN_CLERK_USER_IDS = originalAdminIds;
}
