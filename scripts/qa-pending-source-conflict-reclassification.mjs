import assert from "node:assert/strict";

import {
  previewPendingCinemaSourceConflictReclassificationHandler,
  reclassifyPendingCinemaSourceConflictsHandler,
} from "../convex/internal/eventRepairs/pendingSourceConflictReclassification.ts";
import {
  preparePendingCinemaSourceConflictReclassification,
  preparePendingSourceConflictReclassification,
  buildPendingSourceConflictContext,
} from "../lib/events/pending-source-conflict-reclassification.ts";
import { eventEvidenceConflictIsBenign } from "../lib/events/event-evidence-conflict-policy.ts";
import { getEffectiveEventEvidenceV2Conflicts } from "../lib/events/event-update-precondition.ts";
import { repairPendingBenignSourceConflictHandler } from "../convex/internal/eventRepairs/pendingBenignSourceConflicts.ts";
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
                table === "scrapedPosts" ? [source] : table === "sourceOccurrences" ? [occurrence] : [])
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

function timeFixture() {
  const event = eventFixture(), fields = JSON.parse(event.normalizedFieldsJson);
  const timeConflict = { field: "time", poster_value: "20:00", caption_value: "21:00", reason: "Different clocks are reported." };
  const text = "QA Concert 13.10.2026 at QA Club; show starts 21:00";
  Object.assign(event, { title: "QA Concert", date: "2026-10-13", venue: "QA Club", time: "21:00", sourceCaption: text, sourceConflictFields: ["time"] });
  Object.assign(fields, { title: event.title, normalizedDate: event.date, normalizedVenue: event.venue, time: event.time, sourceGroundingSourceCaption: text,
    sourceConflictFields: ["time"], extractionSourceConflicts: [timeConflict], materialSourceConflicts: [timeConflict], splitEventTotal: 1, multiEventSplitDetected: false });
  event.normalizedFieldsJson = JSON.stringify(fields);
  event.rawExtractionJson = JSON.stringify({ is_event: true, source_conflicts: [timeConflict], field_confirmation: {
    start_time: { evidence_snippets: [{ source: "poster", text: "Doors open 20:00" }] } } });
  return event;
}
{
  const event = timeFixture(), repaired = preparePendingSourceConflictReclassification(event), fields = JSON.parse(repaired.normalizedFieldsJson);
  assert.equal(fields.materialSourceConflictCount, 0); assert.equal(fields.benignSourceConflictCount, 1); assert.equal(event.time, "21:00");
  assert.deepEqual(getEffectiveEventEvidenceV2Conflicts(fields, { ...event, sourceConflictFields: [], normalizedFieldsJson: repaired.normalizedFieldsJson }), []);
  for (const mutate of [
    e => { const r = JSON.parse(e.rawExtractionJson); r.field_confirmation.start_time.evidence_snippets = []; e.rawExtractionJson = JSON.stringify(r); },
    e => { const r = JSON.parse(e.rawExtractionJson); r.field_confirmation.start_time.evidence_snippets[0].text = "Show starts 20:00"; e.rawExtractionJson = JSON.stringify(r); },
    e => { const r = JSON.parse(e.rawExtractionJson); r.field_confirmation.start_time.evidence_snippets[0].text = "Doors open 20:0000"; e.rawExtractionJson = JSON.stringify(r); },
    e => { const f = JSON.parse(e.normalizedFieldsJson); f.time = "20:00"; e.time = "20:00"; e.normalizedFieldsJson = JSON.stringify(f); },
    e => { const f = JSON.parse(e.normalizedFieldsJson); f.splitEventTotal = 2; f.multiEventSplitDetected = true; e.normalizedFieldsJson = JSON.stringify(f); },
    e => { const f = JSON.parse(e.normalizedFieldsJson); f.timeEvidenceVerified = false; e.normalizedFieldsJson = JSON.stringify(f); },
    e => { const r = JSON.parse(e.rawExtractionJson); r.schedule_entries = [{ title: "First other occurrence" }, { title: "Second other occurrence" }]; e.rawExtractionJson = JSON.stringify(r); },
    e => { const r = JSON.parse(e.rawExtractionJson); r.field_confirmation.start_time.evidence_snippets.push({ source: "poster", text: "Show starts 20:00" }); e.rawExtractionJson = JSON.stringify(r); },
    e => { const r = JSON.parse(e.rawExtractionJson); delete r.field_confirmation; e.rawExtractionJson = JSON.stringify(r); const f = JSON.parse(e.normalizedFieldsJson); f.sourcePosterTexts = ["Doors open 20:00"]; e.normalizedFieldsJson = JSON.stringify(f); },
  ]) { const held = timeFixture(); mutate(held); assert.throws(() => preparePendingSourceConflictReclassification(held)); }
  const context = buildPendingSourceConflictContext(event, JSON.parse(event.normalizedFieldsJson));
  assert.equal(eventEvidenceConflictIsBenign({ field: "date", poster_value: "Tuesday 13 October", caption_value: "Tuesday 20 October", reason: "Different dates." }, context), false);
  assert.equal(eventEvidenceConflictIsBenign({ field: "date", poster_value: "Tuesday 31 February", caption_value: "Tuesday 13 October", reason: "Invalid poster date." }, context), false);
  assert.equal(eventEvidenceConflictIsBenign({ field: "date", poster_value: "2026-10-13", caption_value: "13.10.2026", reason: "Equivalent dates." }, context), true);
  assert.equal(eventEvidenceConflictIsBenign({ field: "venue", poster_value: "Other Club", caption_value: "QA Club", reason: "Different venues." }, context), false);
  assert.equal(eventEvidenceConflictIsBenign({ field: "time", poster_value: "20:00", caption_value: "21:00", reason: "Different starts." }, { ...context, sourcePosterTexts: ["Show starts 20:00"] }), false);
  assert.equal(eventEvidenceConflictIsBenign({ field: "time", poster_value: "20h", caption_value: "21h", reason: "Doors versus start." }, { ...context,
    sourceCaption: "QA Concert 13.10.2026 at QA Club; Pocetak 21h", sourcePosterTexts: ["Vrata 20h"] }), true);
}
{
  const event = eventFixture(), state = fakeContext(event), args = { id: event._id, expectedUpdatedAt: event.updatedAt, actor: "automatic_conflict_repair" };
  const before = structuredClone(event);
  state.records.get("source-1").analysisRevision = 2;
  assert.equal((await repairPendingBenignSourceConflictHandler(state.context, args)).outcome, "held");
  state.records.get("source-1").analysisRevision = 1; state.records.get("source-1").processingStatus = "retryable_failure";
  assert.equal((await repairPendingBenignSourceConflictHandler(state.context, args)).outcome, "held");
  state.records.get("source-1").processingStatus = "completed"; state.receipt.deferredChildCount = 1;
  assert.equal((await repairPendingBenignSourceConflictHandler(state.context, args)).outcome, "held"); state.receipt.deferredChildCount = 0;
  assert.equal((await repairPendingBenignSourceConflictHandler(state.context, { ...args, expectedUpdatedAt: args.expectedUpdatedAt - 1 })).outcome, "stale");
  assert.equal(state.audits.length, 0);
  assert.equal((await repairPendingBenignSourceConflictHandler(state.context, args)).outcome, "repaired");
  const updated = state.records.get(event._id);
  for (const key of ["title", "date", "time", "venue", "artists", "status", "rawExtractionJson"]) assert.deepEqual(updated[key], before[key]);
  const audit = JSON.parse(state.audits[0].patchJson);
  assert.deepEqual(audit.previousMaterialConflicts, [conflict]); assert.deepEqual(audit.nextBenignConflicts, [conflict]);
  assert.equal((await repairPendingBenignSourceConflictHandler(state.context, args)).outcome, "stale");
}
for (const marker of [{ reviewedAt: 1 }, { reviewedBy: "human" }, { humanReviewedLegacySourcePolicyVersion: 1 }, { humanReviewedStructuredSourcePolicyVersion: 1 },
  { normalizedFieldsJson: JSON.stringify({ ...JSON.parse(eventFixture().normalizedFieldsJson), humanReviewedStructuredSourcePolicyVersion: 1 }) }]) {
  const event = { ...eventFixture(), ...marker }, state = fakeContext(event);
  const result = await repairPendingBenignSourceConflictHandler(state.context, { id: event._id, expectedUpdatedAt: event.updatedAt, actor: "automatic_conflict_repair" });
  assert.equal(result.outcome, "held"); assert.equal(result.reason, "human_review_preserved"); assert.equal(state.audits.length, 0);
}
console.log("Generic source conflict repair QA passed.");

{
  const sameOccurrenceConflict = { field: "date", poster_value: "17. OKTOBAR", caption_value: "Subota, 10. Oktobar",
    reason: "Poster and caption give different calendar dates for the same occurrence." };
  const source = "RIKVERC svi putevi vode\nSubota, 10. Oktobar\nKlub Beton, Beton hala\nStart: 22h";
  for (const selectedDate of ["2026-10-10", "2026-10-17"]) {
    const event = eventFixture(), fields = JSON.parse(event.normalizedFieldsJson);
    Object.assign(event, { title: "RIKVERC svi putevi vode", date: selectedDate, time: "22:00-04:00", venue: "Beton",
      artists: [], sourceCaption: source, sourceConflictFields: [] });
    Object.assign(fields, { title: event.title, normalizedDate: event.date, normalizedVenue: event.venue,
      time: event.time, artists: [], sourceGroundingSourceCaption: source, sourceAccountName: "Rikverc Events",
      sourceAccountRole: "venue", splitEventTotal: 2, multiEventSplitDetected: true, extractionSourceConflicts: [sameOccurrenceConflict],
      extractionSourceConflictCount: 1, materialSourceConflicts: [], materialSourceConflictCount: 0,
      benignSourceConflicts: [sameOccurrenceConflict], benignSourceConflictCount: 1, sourceConflictFields: [] });
    const conflictingRows = [
      { date: "2026-10-10", title: event.title, venue: "Klub Beton", artists: [], source_text: "Subota, 10. Oktobar" },
      { date: "2026-10-17", title: event.title, venue: "Klub Beton", artists: [], source_text: "SUBOTA 17.OKTOBAR" },
    ];
    event.rawExtractionJson = JSON.stringify({ is_event: true, source_conflicts: [sameOccurrenceConflict], schedule_entries: conflictingRows });
    event.normalizedFieldsJson = JSON.stringify(fields);
    const context = buildPendingSourceConflictContext(event, fields);
    assert.equal(context.singleOccurrenceSource, false, "The fixture must retain the erroneous model split into two rows.");
    assert.equal(eventEvidenceConflictIsBenign(sameOccurrenceConflict, context), false,
      "Two explicit Saturdays a week apart remain a material contradiction despite model row splitting.");
    assert.equal(getEffectiveEventEvidenceV2Conflicts(fields, event), null,
      "An old approved record's benign marker must not bypass current source-conflict verification.");
    assert.throws(() => preparePendingSourceConflictReclassification({ ...event, status: "pending" }), /material conflict|verified cinema|non-cinema/u);

    Object.assign(fields, { extractionSourceConflicts: [], extractionSourceConflictCount: 0,
      materialSourceConflicts: [], materialSourceConflictCount: 0, benignSourceConflicts: [], benignSourceConflictCount: 0 });
    event.sourceCaption = fields.sourceGroundingSourceCaption = "Friday 16.10 Artist A; Saturday 17.10 Artist B at QA Club.";
    event.rawExtractionJson = JSON.stringify({ is_event: true, source_conflicts: [], schedule_entries: [
      { date: "2026-10-16", title: "Artist A", artists: ["Artist A"], venue: "QA Club", source_text: "Friday 16.10 Artist A" },
      { date: "2026-10-17", title: "Artist B", artists: ["Artist B"], venue: "QA Club", source_text: "Saturday 17.10 Artist B" },
    ] });
    event.normalizedFieldsJson = JSON.stringify(fields);
    assert.deepEqual(getEffectiveEventEvidenceV2Conflicts(fields, event), [],
      "A genuine source-announced multi-day lineup without contradictory same-occurrence claims remains unaffected.");
  }
}
console.log("Same-occurrence named-date conflict regression QA passed.");
