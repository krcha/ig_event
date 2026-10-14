import assert from "node:assert/strict";
import { claimNextWork, completeWork, getHolds } from "../convex/autonomousModeration.ts";
const originalNow = Date.now;
const originalSecret = process.env.CRON_SECRET;
const originalAdmins = process.env.ADMIN_CLERK_USER_IDS;
let now = Date.UTC(2026, 9, 13, 12);
Date.now = () => now;
const SECRET = "qa-autonomous-moderation-secret";
process.env.CRON_SECRET = SECRET;
process.env.ADMIN_CLERK_USER_IDS = "qa-admin";

function fixture({ category = "source_binding_repair", eventPatch = {}, sourcePatch = {}, holdPatch = {} } = {}) {
  const raw = JSON.stringify({ extraction_contract_version: "event_evidence_v2", is_event: true, source_conflicts: [] });
  const event = { _id: "event-1", status: "pending", updatedAt: 100, title: "QA Night", date: "2026-10-14", time: "21:00", venue: "QA Club", artists: [], instagramPostId: "post-1", sourceCaption: "QA Night at QA Club 14.10.2026", rawExtractionJson: raw, normalizedFieldsJson: JSON.stringify({ sourceGroundingInstagramHandle: "qa-club" }), ...eventPatch };
  const source = { _id: "source-1", handle: "qa-club", username: "qa-club", postId: "post-1", sourceRevision: 1, analysisRevision: 1, analysisContractVersion: "event_evidence_v2", analysisIsEvent: true, analysisModel: "gpt-6-luna", analysisResultJson: raw, processingStatus: "completed", processingOutcome: "receipt_complete", imageStorageId: "storage-1", analysisImageChecksumSha256: "a".repeat(64), analysisImageSourceUrl: "https://fixture.example/poster.jpg", blocksPaidFetch: false, updatedAt: 50, ...sourcePatch };
  const hold = { _id: "hold-1", eventId: event._id, expectedUpdatedAt: 100, sourcePostId: source._id, sourceRevision: 1, holdReason: "source_proof_incomplete", repairCategory: category, diagnosticJson: "{}", status: "queued", repairAttemptCount: 0, nextRetryAt: now - 1, observedAt: now - 10, createdAt: now - 10, updatedAt: now - 10, ...holdPatch };
  const tables = new Map([["events", new Map([[event._id, event]])], ["scrapedPosts", new Map([[source._id, source]])], ["automaticApprovalHolds", new Map([[hold._id, hold]])]]);
  const writes = [], reads = [];
  function get(id) { for (const rows of tables.values()) if (rows.has(id)) return rows.get(id); return null; }
  const indexes = new Set(["by_repairCategory_status_nextRetryAt", "by_event"]);
  const ctx = { auth: { getUserIdentity: async () => null }, db: {
    get: async (id) => get(id),
    query: (table) => ({ withIndex: (index, configure) => {
      assert.equal(table, "automaticApprovalHolds"); assert.ok(indexes.has(index));
      const predicates = [], builder = { eq(key, value) { predicates.push(row => row[key] === value); return this; }, lte(key, value) { predicates.push(row => row[key] <= value); return this; } };
      configure(builder);
      return { take: async (limit) => { assert.ok(Number.isSafeInteger(limit) && limit > 0 && limit <= 5); reads.push({ table, index, limit }); return [...tables.get(table).values()].filter(row => predicates.every(test => test(row))).slice(0, limit); } };
    } }),
    patch: async (id, patch) => {
      let table; for (const [name, rows] of tables) if (rows.has(id)) { table = name; break; }
      assert.ok(table); const next = { ...get(id) };
      for (const [key, value] of Object.entries(patch)) { if (value === undefined) delete next[key]; else next[key] = structuredClone(value); }
      tables.get(table).set(id, next); writes.push({ table, id, patch: structuredClone(patch) });
    },
    insert: async () => { throw new Error("Claims/completions must update existing rows"); },
  }, runAction: async () => { throw new Error("A queue mutation must never invoke paid transport"); } };
  return { ctx, tables, writes, reads, get, eventId: event._id, sourceId: source._id, holdId: hold._id,
    snapshot: () => structuredClone([...tables].map(([name, rows]) => [name, [...rows.values()]])) };
}
const claim = (state, extra = {}) => claimNextWork._handler(state.ctx, { owner: "qa-worker", serviceSecret: SECRET, ...extra });
const finish = (state, extra = {}) => completeWork._handler(state.ctx, { holdId: state.holdId, owner: "qa-worker", sourceRevision: 1, outcome: "retry", reason: "retry_cached_source", serviceSecret: SECRET, ...extra });

try {
  { const s = fixture(), before = s.snapshot();
    await assert.rejects(claimNextWork._handler(s.ctx, { owner: "qa-worker", serviceSecret: "wrong" }), /Authentication|Admin/u);
    await assert.rejects(completeWork._handler(s.ctx, { holdId: s.holdId, owner: "qa-worker", sourceRevision: 1, outcome: "held", reason: "x" }), /Authentication|Admin/u);
    await assert.rejects(getHolds._handler(s.ctx, { eventIds: [s.eventId], serviceSecret: "wrong" }), /Authentication|Admin/u);
    assert.deepEqual(s.snapshot(), before);
    s.ctx.auth.getUserIdentity = async () => ({ subject: "qa-viewer" });
    await assert.rejects(claim(s, { serviceSecret: "wrong" }), /Admin/u);
    await assert.rejects(claim(s, { owner: "x".repeat(201) }), /bounded recovery owner/u);
  }
  { const s = fixture(), sourceBefore = structuredClone(s.get(s.sourceId));
    const work = await claim(s);
    assert.deepEqual(work, { holdId: s.holdId, eventId: s.eventId, expectedUpdatedAt: 100, category: "source_binding_repair", sourcePostId: s.sourceId, sourceRevision: 1, handle: "qa-club" });
    assert.equal(s.get(s.holdId).repairAttemptCount, 1); assert.equal(s.get(s.holdId).leaseOwner, "qa-worker");
    assert.equal(s.get(s.sourceId).processingStatus, "pending"); assert.equal(s.get(s.sourceId).blocksPaidFetch, true);
    for (const key of ["analysisResultJson", "analysisRevision", "analysisImageSourceUrl", "analysisImageChecksumSha256", "imageStorageId"]) assert.deepEqual(s.get(s.sourceId)[key], sourceBefore[key]);
    assert.equal(await claim(s, { owner: "second-worker" }), null);
    assert.ok(s.writes.every(write => ["automaticApprovalHolds", "scrapedPosts"].includes(write.table)));
    assert.ok(s.reads.every(read => read.index === "by_repairCategory_status_nextRetryAt" && read.limit === 5));
    const before = s.snapshot();
    assert.deepEqual(await finish(s, { owner: "other" }), { recorded: false });
    assert.deepEqual(await finish(s, { sourceRevision: 2 }), { recorded: false });
    assert.deepEqual(s.snapshot(), before);
    s.get(s.sourceId).processingStatus = "completed";
    s.get(s.sourceId).processingOutcome = "receipt_complete";
    assert.deepEqual(await finish(s, { outcome: "repaired" }), { recorded: true });
    assert.equal(s.get(s.holdId).status, "resolved"); assert.equal(s.get(s.holdId).leaseOwner, undefined);
    assert.deepEqual(await finish(s, { outcome: "repaired" }), { recorded: false });
  }
  for (const eventPatch of [{ updatedAt: 101 }, { status: "approved" }]) {
    const s = fixture({ eventPatch }), sourceBefore = structuredClone(s.get(s.sourceId));
    assert.equal(await claim(s), null); assert.equal(s.get(s.holdId).lastRepairReason, "event_generation_changed");
    assert.deepEqual(s.get(s.sourceId), sourceBefore);
  }
  for (const eventPatch of [
    { reviewedAt: now }, { reviewedBy: "human" }, { humanReviewedLegacySourcePolicyVersion: 1 }, { humanReviewedStructuredSourcePolicyVersion: 1 },
    { normalizedFieldsJson: JSON.stringify({ humanReviewedLegacySourcePolicyVersion: 1 }) },
    { normalizedFieldsJson: JSON.stringify({ humanReviewedStructuredSourcePolicyVersion: 1 }) },
  ]) { const s = fixture({ eventPatch }), sourceBefore = structuredClone(s.get(s.sourceId));
    assert.equal(await claim(s), null); assert.equal(s.get(s.holdId).lastRepairReason, "human_review_preserved"); assert.deepEqual(s.get(s.sourceId), sourceBefore);
  }
  for (const sourcePatch of [
    { sourceRevision: 2, analysisRevision: 2 }, { analysisRevision: 2 }, { analysisContractVersion: "legacy" }, { analysisResultJson: undefined },
    { processingOutcome: "openai_transport_ambiguous" }, { processingOutcome: "terminal_permanent_failure" },
    { processingStatus: "processing", processingLeaseExpiresAt: now + 60000 },
  ]) { const s = fixture({ sourcePatch }), sourceBefore = structuredClone(s.get(s.sourceId));
    assert.equal(await claim(s), null); assert.equal(s.get(s.holdId).lastRepairReason, "current_saved_source_unavailable"); assert.deepEqual(s.get(s.sourceId), sourceBefore);
  }
  { const s = fixture({ sourcePatch: { processingOutcome: "source_media_partial" } }), before = structuredClone(s.get(s.sourceId));
    assert.equal(await claim(s), null); assert.equal(s.get(s.holdId).lastRepairReason, "unread_source_media_requires_review"); assert.deepEqual(s.get(s.sourceId), before);
  }
  { const s = fixture({ category: "source_conflict_review" }), before = s.snapshot();
    assert.equal(await claim(s), null); assert.deepEqual(s.snapshot(), before);
    assert.equal((await claim(s, { allowFocusedReviews: true })).category, "source_conflict_review");
    assert.equal(s.get(s.sourceId).processingStatus, "completed"); assert.equal(s.writes.filter(write => write.table === "scrapedPosts").length, 0);
  }
  { const s = fixture({ category: "source_conflict_review", sourcePatch: { processingStatus: "pending" } });
    assert.equal((await claim(s, { allowFocusedReviews: true })).category, "occurrence_completion");
  }
  { const s = fixture({ holdPatch: { repairAttemptCount: 3 } }), before = structuredClone(s.get(s.sourceId));
    assert.equal(await claim(s), null); assert.equal(s.get(s.holdId).lastRepairReason, "repair_attempt_limit"); assert.deepEqual(s.get(s.sourceId), before);
  }
  { const s = fixture();
    for (let count = 1; count <= 3; count++) { assert.ok(await claim(s)); assert.equal(s.get(s.holdId).repairAttemptCount, count); assert.deepEqual(await finish(s), { recorded: true });
      if (count < 3) { assert.equal(s.get(s.holdId).status, "queued"); now = s.get(s.holdId).nextRetryAt + 1; } else assert.equal(s.get(s.holdId).status, "held");
    }
    assert.equal(await claim(s), null);
  }
  { const s = fixture(); await claim(s); assert.deepEqual(await finish(s, { attempted: false, reason: "budget_denied" }), { recorded: true });
    assert.equal(s.get(s.holdId).repairAttemptCount, 0); assert.equal(s.get(s.holdId).status, "queued");
  }
  { const s = fixture(); await claim(s); now = s.get(s.holdId).leaseExpiresAt + 1;
    const before = s.snapshot(); assert.deepEqual(await finish(s), { recorded: false }); assert.deepEqual(s.snapshot(), before);
    assert.ok(await claim(s, { owner: "replacement-worker" })); assert.equal(s.get(s.holdId).repairAttemptCount, 2);
    assert.deepEqual(await finish(s), { recorded: false });
  }
  for (const mutate of [
    s => { s.get(s.sourceId).sourceRevision = 2; s.get(s.sourceId).analysisRevision = 2; },
    s => { s.get(s.sourceId).analysisRevision = 2; }, s => { s.get(s.eventId).updatedAt = 101; },
    s => { s.get(s.eventId).status = "approved"; }, s => { s.get(s.eventId).reviewedBy = "human"; },
    s => { s.get(s.eventId).normalizedFieldsJson = JSON.stringify({ humanReviewedStructuredSourcePolicyVersion: 1 }); },
  ]) { const s = fixture(); await claim(s); mutate(s); const before = s.snapshot();
    assert.deepEqual(await finish(s, { outcome: "repaired" }), { recorded: false }); assert.deepEqual(s.snapshot(), before);
  }
  { const s = fixture(); const result = await getHolds._handler(s.ctx, { eventIds: [s.eventId], serviceSecret: SECRET });
    assert.equal(result.length, 1); assert.equal(result[0].expectedUpdatedAt, 100); assert.equal(result[0].repairAttemptCount, 0);
    await assert.rejects(getHolds._handler(s.ctx, { eventIds: [s.eventId, s.eventId], serviceSecret: SECRET }), /unique/u);
    await assert.rejects(getHolds._handler(s.ctx, { eventIds: Array.from({ length: 51 }, (_, i) => `event-${i}`), serviceSecret: SECRET }), /at most 50/u);
  }
  console.log("Autonomous moderation QA passed: indexed claims, authentication, exact generations, human protection, immutable cached analysis, bounded retries, and ambiguous transport exclusion.");
} finally {
  Date.now = originalNow;
  if (originalSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = originalSecret;
  if (originalAdmins === undefined) delete process.env.ADMIN_CLERK_USER_IDS; else process.env.ADMIN_CLERK_USER_IDS = originalAdmins;
}
