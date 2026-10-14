import assert from "node:assert/strict";
import { claim, markStarted, finish, getContext, applyCompleted } from "../convex/sourceConflictReviews.ts";
import { hasPersistedFocusedConflictReviewProof } from "../convex/internal/focusedConflictReviewProof.ts";
import { buildInstagramSourceOccurrenceFingerprint } from "../lib/domain/occurrences/source-fingerprint.ts";
import { buildFocusedSourceConflictContextFingerprint, FOCUSED_SOURCE_CONFLICT_POLICY } from "../lib/events/focused-source-conflict-review.ts";
import { getBudgetDayKey } from "../lib/pipeline/instagram-ingestion-durability.ts";

const secret = "qa-focused-ledger-secret", oldSecret = process.env.CRON_SECRET, oldNow = Date.now;
const BASE_NOW = Date.UTC(2026, 9, 13, 10), LEASE_MS = 5 * 60_000;
let now = BASE_NOW;
process.env.CRON_SECRET = secret; Date.now = () => now;
const conflict = { field: "time", poster_value: "21:00", caption_value: "22:00", reason: "Different source times." };
function database() {
  now = BASE_NOW;
  let tables = new Map(), sequence = 0;
  const rows = (name) => [...(tables.get(name)?.values() ?? [])];
  const put = (name, row) => { if (!tables.has(name)) tables.set(name, new Map()); tables.get(name).set(row._id, structuredClone(row)); return row._id; };
  const get = (id) => { for (const table of tables.values()) if (table.has(id)) return table.get(id); return null; };
  const query = (name) => {
    const conditions = [];
    const range = { eq: (field, value) => { conditions.push((row) => row[field] === value); return range; } };
    const cursor = { withIndex: (index, callback) => { assert.ok(index.startsWith("by_")); callback?.(range); return cursor; }, order: () => cursor,
      take: async (limit) => { assert.ok(Number.isSafeInteger(limit) && limit >= 1 && limit <= 65); return rows(name).filter((row) => conditions.every((test) => test(row))).slice(0, limit); },
      unique: async () => { const found = await cursor.take(2); assert.ok(found.length <= 1); return found[0] ?? null; } };
    return cursor;
  };
  const ctx = { auth: { getUserIdentity: async () => null }, storage: { getUrl: async (id) => `https://storage.example/${id}` }, db: {
    get: async (id) => get(id), query, normalizeId: (_name, id) => typeof id === "string" && id.length ? id : null,
    patch: async (id, patch) => { const row = get(id); assert.ok(row); for (const table of tables.values()) if (table.has(id)) table.set(id, { ...row, ...patch }); },
    insert: async (name, value) => put(name, { ...value, _id: `${name}-${++sequence}`, _creationTime: now }) } };
  // This is synthetic transaction staging, not a live Convex rollback test.
  const invoke = async (registered, args) => { const snapshot = structuredClone(tables);
    try { return await registered._handler(ctx, { ...args, serviceSecret: secret }); } catch (error) { tables = snapshot; throw error; } };
  const caption = "Orbit Night\n17.10.2026\nStarts 22:00", fingerprint = buildInstagramSourceOccurrenceFingerprint({ caption });
  const sourceIdentity = "instagram-source-identity-v1:qaFocused123", key = "occurrence-qa";
  const raw = JSON.stringify({ extraction_contract_version: "event_evidence_v2", is_event: true, non_event_reason: "", source_conflicts: [conflict], schedule_entries: [],
    date_evidence: { source: "caption", exact_text: "17.10.2026", resolved_date: "2026-10-17", is_relative: false },
    time_evidence: { source: "caption", exact_text: "Starts 22:00", status: "start_time_stated" } });
  const fields = { extractionContractVersion: "event_evidence_v2", sourceConflictResolutionVersion: 1, extractionSourceConflicts: [conflict], extractionSourceConflictCount: 1,
    materialSourceConflicts: [conflict], materialSourceConflictCount: 1, benignSourceConflicts: [], benignSourceConflictCount: 0, sourceConflictFields: ["time"], extractionIsEvent: true, extractionNonEventReason: null,
    title: "Orbit Night", normalizedDate: "2026-10-17", time: "22:00", normalizedVenue: "Orbit Club", artists: [], dateEvidenceVerified: true, timeEvidenceVerified: true,
    identityEvidenceVerified: true, venueEvidenceVerified: true, structuredEvidenceVerified: false, sourceOccurrencePlanUnverified: false, sourceOccurrenceAmbiguousProvenance: false,
    normalizedIsValid: true, approvalTitleSensible: true, dateSuspiciousYear: false, sourceGroundingSourceCaption: caption, sourceGroundingInstagramHandle: "orbitclub",
    sourceAccountRole: "venue", sourceAccountName: "Orbit Club", splitEventTotal: 1, multiEventSplitDetected: false, sourceOccurrenceKey: key, sourceOccurrenceSourceFingerprint: fingerprint,
    moderationPendingReasons: ["requires_human_approval", "poster_caption_conflict"], moderationSignals: ["requires_human_approval", "poster_caption_conflict"], moderationAutoApproved: false, moderationAutoApproveRule: null };
  put("events", { _id: "event-1", _creationTime: 1, status: "pending", title: "Orbit Night", date: "2026-10-17", time: "22:00", venue: "Orbit Club", artists: [], instagramPostId: "qa-post",
    instagramPostUrl: "https://www.instagram.com/p/qaFocused123/", sourceCaption: caption, sourcePostedAt: "2026-10-13T10:00:00.000Z", sourceConflictFields: ["time"], sourceOccurrenceKey: key,
    normalizedFieldsJson: JSON.stringify(fields), rawExtractionJson: raw, createdAt: 1, updatedAt: 100 });
  put("scrapedPosts", { _id: "source-1", _creationTime: 1, handle: "orbitclub", username: "orbitclub", postId: "qa-post", instagramPostUrl: "https://www.instagram.com/p/qaFocused123/",
    caption, imageUrls: [], postedAt: "2026-10-13T10:00:00.000Z", sourceRevision: 1, analysisRevision: 1, analysisContractVersion: "event_evidence_v2", analysisIsEvent: true,
    analysisModel: "gpt-6-luna", analysisResultJson: raw, processingStatus: "completed", imageStorageId: "storage-1", analysisImageSourceUrl: "https://cdn.example/poster.jpg",
    analysisImageChecksumSha256: "a".repeat(64), createdAt: 1, updatedAt: 100 });
  put("mediaAssets", { _id: "asset-1", sourceKey: "instagram-post:qa-post", storageId: "storage-1", checksumSha256: "a".repeat(64) });
  put("instagramSourceOccurrenceReceipts", { _id: "receipt-1", sourceIdentity, sourceFingerprint: fingerprint, expectedKeys: [key],
    expectedOccurrences: [{ key, title: "Orbit Night", date: "2026-10-17", time: "22:00", venue: "Orbit Club", artists: [] }], satisfiedKeys: [key], satisfiedOccurrences: [{ key, eventId: "event-1" }],
    deferredChildCount: 0, deferredChildKeys: [], createdAt: 1, updatedAt: 200 });
  put("instagramEventSources", { _id: "link-1", eventId: "event-1", sourceOccurrenceId: "occurrence-1", sourceIdentity, sourceFingerprint: fingerprint, sourceOccurrenceKey: key, updatedAt: 300 });
  put("sourceOccurrences", { _id: "occurrence-1", state: "satisfied", canonicalEventId: "event-1", sourceIdentity, sourceFingerprint: fingerprint, sourceOccurrenceKey: key, sourceDocumentId: "source-1", sourceRevision: 1 });
  return { ctx, invoke, rows, get, put, snapshot: () => JSON.stringify([...tables].map(([name, table]) => [name, [...table.values()]])) };
}
async function argumentsFor(db, owner = "owner-1", globalDailyLimit = 10, dailyReviewLimit = 20) {
  const loaded = await db.invoke(getContext, { sourcePostId: "source-1", sourceRevision: 1 });
  return { sourcePostId: "source-1", sourceRevision: 1, reviewKey: loaded.reviewKey, owner,
    expectedContextFingerprint: buildFocusedSourceConflictContextFingerprint(loaded.context), globalDailyLimit, dailyReviewLimit };
}
function reviewResult(context) {
  const event = context.events[0];
  return { policy_version: FOCUSED_SOURCE_CONFLICT_POLICY, events: [{ event_id: event.id,
    selected_facts: { title: event.title, date: event.date, time: event.time, venue: event.venue, artists: event.artists }, resolutions: [{ event_id: event.id, conflict_index: 0, field: "time",
      disposition: "separate_context", selected_value: event.time, poster_quote: "Orbit Night 17.10.2026\nDoors 21:00", caption_quote: "Starts 22:00", slide_index: 0, reason: "Explicit doors and performance roles." }] }] };
}
function budget(db, provider) { return db.rows("ingestionDailyBudgets").find((row) => row.provider === provider); }
function assertCounters(db, reserved, charged, released = 0) { for (const provider of ["openai", "openai_conflict_review"]) {
  const row = budget(db, provider); assert.equal(row.reservedMicros, reserved); assert.equal(row.chargedMicros, charged); assert.equal(row.releasedMicros, released); } }
try {
  const db = database(), args = await argumentsFor(db), beforeRaw = db.get("source-1").analysisResultJson;
  const originalFacts = JSON.stringify([db.get("event-1").title, db.get("event-1").date, db.get("event-1").time, db.get("event-1").venue, db.get("event-1").artists]);
  const originalReceipt = JSON.stringify(db.get("receipt-1")), originalLink = JSON.stringify(db.get("link-1"));
  await assert.rejects(claim._handler(db.ctx, { ...args, serviceSecret: "wrong" }), /Authentication/);
  assert.equal((await db.invoke(claim, args)).status, "claimed"); assertCounters(db, 1, 0);
  assert.equal((await db.invoke(claim, { ...args, owner: "owner-2" })).reason, "source_review_busy"); assertCounters(db, 1, 0);
  await assert.rejects(db.invoke(markStarted, { reviewKey: args.reviewKey, owner: "owner-2" }), /start fence/); assertCounters(db, 1, 0);
  await db.ctx.db.patch("event-1", { updatedAt: 101 });
  await db.invoke(markStarted, { reviewKey: args.reviewKey, owner: args.owner }); assertCounters(db, 0, 1);
  await assert.rejects(db.invoke(markStarted, { reviewKey: args.reviewKey, owner: args.owner }), /start fence/); assertCounters(db, 0, 1);
  assert.equal((await db.invoke(claim, { ...args, owner: "owner-2" })).reason, "source_review_already_attempted");
  const row = db.rows("sourceConflictReviews")[0], resultJson = JSON.stringify(reviewResult(JSON.parse(row.contextJson)));
  const rawResponseJson = JSON.stringify({ id: "response-1", status: "completed", output_text: resultJson });
  assert.equal((await db.invoke(finish, { reviewKey: args.reviewKey, owner: "owner-2", resultJson, rawResponseJson })).recorded, false);
  assert.equal((await db.invoke(finish, { reviewKey: args.reviewKey, owner: args.owner, resultJson, rawResponseJson, responseId: "response-1" })).recorded, true);
  assertCounters(db, 0, 1);
  await db.invoke(finish, { reviewKey: args.reviewKey, owner: args.owner, resultJson: "changed", rawResponseJson: "changed" });
  assert.equal(db.rows("sourceConflictReviews")[0].rawResponseJson, rawResponseJson);
  assert.equal((await db.invoke(applyCompleted, { reviewKey: args.reviewKey }))[0].outcome, "repaired");
  const version = db.get("event-1").updatedAt, auditCount = db.rows("eventAuditLog").length;
  assert.equal(auditCount, 1); assert.deepEqual(db.get("event-1").sourceConflictFields, []);
  assert.equal(await hasPersistedFocusedConflictReviewProof(db.ctx, db.get("event-1")), true);
  assert.equal((await db.invoke(applyCompleted, { reviewKey: args.reviewKey }))[0].outcome, "already_repaired");
  assert.equal(db.get("event-1").updatedAt, version); assert.equal(db.rows("eventAuditLog").length, auditCount);
  await db.ctx.db.patch("event-1", { status: "approved" });
  assert.equal((await db.invoke(applyCompleted, { reviewKey: args.reviewKey }))[0].outcome, "already_repaired");
  assert.equal(await hasPersistedFocusedConflictReviewProof(db.ctx, db.get("event-1")), true);
  await db.ctx.db.patch("asset-1", { checksumSha256: "b".repeat(64) });
  assert.equal(await hasPersistedFocusedConflictReviewProof(db.ctx, db.get("event-1")), false);
  assert.equal((await db.invoke(applyCompleted, { reviewKey: args.reviewKey }))[0].outcome, "held");
  await db.ctx.db.patch("asset-1", { checksumSha256: "a".repeat(64) }); await db.ctx.db.patch("event-1", { title: "Different Show" });
  assert.equal((await db.invoke(applyCompleted, { reviewKey: args.reviewKey }))[0].outcome, "held");
  await db.ctx.db.patch("event-1", { title: "Orbit Night" });
  assert.equal(db.get("source-1").analysisResultJson, beforeRaw); assert.equal(db.get("event-1").rawExtractionJson, beforeRaw);
  assert.equal(JSON.stringify([db.get("event-1").title, db.get("event-1").date, db.get("event-1").time, db.get("event-1").venue, db.get("event-1").artists]), originalFacts);
  assert.equal(JSON.stringify(db.get("receipt-1")), originalReceipt); assert.equal(JSON.stringify(db.get("link-1")), originalLink);
  assert.equal(db.rows("eventAuditLog").length, auditCount); assertCounters(db, 0, 1);
  await db.ctx.db.patch("event-1", { normalizedFieldsJson: "not-json" });
  assert.equal((await db.invoke(applyCompleted, { reviewKey: args.reviewKey }))[0].reason, "current_event_evidence_invalid");
  assert.equal(db.rows("eventAuditLog").length, auditCount);

  const preflight = database(), pa = await argumentsFor(preflight), stable = preflight.snapshot();
  await assert.rejects(preflight.invoke(claim, { ...pa, expectedContextFingerprint: "stale" }), /facts changed before claim/); assert.equal(preflight.snapshot(), stable);
  await preflight.invoke(claim, pa); await preflight.ctx.db.patch("event-1", { title: "Changed During Media Prep" });
  await assert.rejects(preflight.invoke(markStarted, { reviewKey: pa.reviewKey, owner: pa.owner }), /facts changed before transport/);
  assertCounters(preflight, 1, 0); assert.equal(preflight.rows("sourceConflictReviews")[0].requestStartedAt, undefined);
  await preflight.invoke(finish, { reviewKey: pa.reviewKey, owner: pa.owner, error: "media preparation failed" }); assertCounters(preflight, 0, 0, 1);
  for (const provider of ["openai", "openai_conflict_review"]) assert.equal(budget(preflight, provider).reconciledCount, 1);
  await preflight.invoke(finish, { reviewKey: pa.reviewKey, owner: pa.owner, error: "duplicate failure" }); assertCounters(preflight, 0, 0, 1);
  for (const marker of [{ reviewedBy: "human" }, { normalizedFieldsJson: JSON.stringify({ humanReviewedStructuredSourcePolicyVersion: 1 }) }]) {
    const human = database(), ha = await argumentsFor(human); await human.invoke(claim, ha); await human.ctx.db.patch("event-1", marker);
    await assert.rejects(human.invoke(markStarted, { reviewKey: ha.reviewKey, owner: ha.owner }), /No current pending source conflicts/);
    assertCounters(human, 1, 0); await human.invoke(finish, { reviewKey: ha.reviewKey, owner: ha.owner, error: "human review superseded" }); assertCounters(human, 0, 0, 1);
  }
  const expired = database(), ea = await argumentsFor(expired); await expired.invoke(claim, ea); now += LEASE_MS + 1;
  assert.equal((await expired.invoke(claim, { ...ea, owner: "owner-2" })).status, "claimed"); assertCounters(expired, 1, 0);
  for (const provider of ["openai", "openai_conflict_review"]) assert.equal(budget(expired, provider).reservationCount, 1);
  await assert.rejects(expired.invoke(markStarted, { reviewKey: ea.reviewKey, owner: ea.owner }), /start fence/);
  await expired.invoke(markStarted, { reviewKey: ea.reviewKey, owner: "owner-2" }); assertCounters(expired, 0, 1);
  await expired.invoke(finish, { reviewKey: ea.reviewKey, owner: "owner-2", error: "provider timeout" });
  assert.equal(expired.rows("sourceConflictReviews")[0].status, "transport_unknown"); assertCounters(expired, 0, 1);
  assert.equal((await expired.invoke(claim, { ...ea, owner: "owner-3" })).reason, "source_review_already_attempted");
  for (const [provider, limit, charged, global, reviewLimit] of [["openai", 1, 1, 1, 20], ["openai_conflict_review", 20, 20, 100, 20], ["openai_conflict_review", 50, 50, 100, 1000]]) {
    const capped = database(), ca = await argumentsFor(capped, "owner-1", global, reviewLimit), dayKey = getBudgetDayKey(new Date(now));
    capped.put("ingestionDailyBudgets", { _id: "budget-cap", key: `${provider}:${dayKey}`, provider, dayKey, limitMicros: limit, reservedMicros: 0, chargedMicros: charged, releasedMicros: 0, reservationCount: charged, reconciledCount: charged, createdAt: now, updatedAt: now });
    const before = capped.snapshot(); assert.equal((await capped.invoke(claim, ca)).reason, "budget_exhausted"); assert.equal(capped.snapshot(), before);
  }
  const blocked = database(), ba = await argumentsFor(blocked);
  blocked.put("ingestionProviderLeases", { _id: "lease-block", provider: "openai", owner: "previous", leaseExpiresAt: now - 1, blockedAt: now - 1000, cooldownUntil: now + 60_000, blockedStatus: 401, circuitState: "open", createdAt: now, updatedAt: now });
  const blockSnapshot = blocked.snapshot(); assert.equal((await blocked.invoke(claim, ba)).reason, "provider_blocked"); assert.equal(blocked.snapshot(), blockSnapshot);
  const halfOpen = database(), ha = await argumentsFor(halfOpen);
  halfOpen.put("ingestionProviderLeases", { _id: "lease-half", provider: "openai", owner: "previous", leaseExpiresAt: now - 1, blockedAt: now - 1000, cooldownUntil: now - 1, blockedStatus: 401, blockedCode: "old_block", circuitState: "open", createdAt: now, updatedAt: now });
  await halfOpen.invoke(claim, ha); assert.equal(halfOpen.get("lease-half").circuitState, "half_open");
  await halfOpen.invoke(finish, { reviewKey: ha.reviewKey, owner: ha.owner, error: "no transport" }); assertCounters(halfOpen, 0, 0, 1);
  assert.equal(halfOpen.get("lease-half").circuitState, "closed"); assert.equal(halfOpen.get("lease-half").blockedStatus, undefined); assert.equal(halfOpen.get("lease-half").cooldownUntil, undefined);
  const quota = database(), qa = await argumentsFor(quota); await quota.invoke(claim, qa); await quota.invoke(markStarted, { reviewKey: qa.reviewKey, owner: qa.owner });
  await quota.invoke(finish, { reviewKey: qa.reviewKey, owner: qa.owner, error: "provider quota", rawResponseJson: "quota response", blockedStatus: 429 });
  assert.equal(quota.rows("ingestionProviderLeases")[0].circuitState, "open"); assert.equal(quota.rows("ingestionProviderLeases")[0].blockedStatus, 429); assertCounters(quota, 0, 1);
  console.log("Focused source-conflict ledger QA passed.");
  const interrupted = database(), ia = await argumentsFor(interrupted);
  await interrupted.invoke(claim, ia); await interrupted.invoke(markStarted, { reviewKey: ia.reviewKey, owner: ia.owner });
  const lease = interrupted.rows("ingestionProviderLeases")[0];
  await interrupted.ctx.db.patch(lease._id, { blockedAt: now, blockedStatus: 429, blockedCode: "operator_block", cooldownUntil: now + 60_000, circuitState: "open" });
  const retained = interrupted.rows("sourceConflictReviews")[0];
  await interrupted.invoke(finish, { reviewKey: ia.reviewKey, owner: ia.owner,
    resultJson: JSON.stringify(reviewResult(JSON.parse(retained.contextJson))), rawResponseJson: "retained completed response" });
  assert.equal(interrupted.get(lease._id).circuitState, "open"); assert.equal(interrupted.get(lease._id).blockedStatus, 429);
  assert.equal(interrupted.get(lease._id).blockedCode, "operator_block"); assert.equal(interrupted.get(lease._id).cooldownUntil, now + 60_000);
} finally { Date.now = oldNow; if (oldSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = oldSecret; }
