import assert from "node:assert/strict";
import "../convex/events.ts";
import { getContext, consolidate } from "../convex/reviewedDrugstoreNovember2026Repairs.ts";
import { DRUGSTORE_NOVEMBER_2026_REVIEW as review } from "../convex/internal/eventRepairs/reviewedDrugstoreNovember2026Repairs.ts";
import { buildEventOccurrenceIndexPatch } from "../convex/sourceOccurrences.ts";
import { buildInstagramSourceOccurrenceFingerprint } from "../lib/domain/occurrences/source-fingerprint.ts";
import { isCrossPostCampaignLineageEvent } from "../lib/events/cross-post-campaign-aggregate-attestation.ts";
import { updateEvent } from "../convex/events.ts";

const clone = (value) => structuredClone(value);
const secret = "qa-drugstore-november-secret";
const originalSecret = process.env.CRON_SECRET;
const originalAdmin = process.env.ADMIN_CLERK_USER_IDS;
const originalNow = Date.now;
process.env.CRON_SECRET = secret;
process.env.ADMIN_CLERK_USER_IDS = "qa-drugstore-admin";
Date.now = () => Date.parse("2026-11-06T12:00:00.000Z");

export function drugstoreHarness(seed) {
  const tables = new Map(Object.entries(seed).map(([name, rows]) => [name, new Map(rows.map((row) => [row._id, clone(row)]))]));
  const getTable = (name) => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name); };
  const find = (id) => [...tables.values()].find((table) => table.has(id));
  let counter = 0;
  const result = (name, predicates = []) => {
    const rows = () => [...getTable(name).values()].filter((row) => predicates.every((predicate) => predicate(row))).map(clone);
    return {
      withIndex(_index, callback) {
        const filters = [];
        const builder = Object.fromEntries(["eq", "gt", "gte", "lt", "lte"].map((op) => [op, (field, value) => {
          filters.push((row) => op === "eq" ? row[field] === value : op === "gt" ? row[field] > value : op === "gte" ? row[field] >= value : op === "lt" ? row[field] < value : row[field] <= value);
          return builder;
        }]));
        callback(builder); return result(name, [...predicates, ...filters]);
      },
      order() { return this; },
      async take(limit) { return rows().slice(0, limit); },
      async first() { return rows()[0] ?? null; },
      async unique() { const found = rows(); assert.ok(found.length < 2); return found[0] ?? null; },
      async collect() { throw new Error("Unbounded QA query forbidden."); },
    };
  };
  const db = {
    normalizeId(name, id) { return getTable(name).has(id) ? id : null; },
    async get(id) { return clone(find(id)?.get(id) ?? null); },
    query: (name) => result(name),
    async patch(id, patch) {
      const table = find(id); assert.ok(table, `Missing patch row ${id}`);
      const value = { ...table.get(id), ...clone(patch) };
      for (const [key, item] of Object.entries(value)) if (item === undefined) delete value[key];
      table.set(id, value);
    },
    async delete(id) { assert.ok(find(id)?.delete(id)); },
    async insert(name, value) { const id = `qa-drugstore-${name}-${++counter}`; getTable(name).set(id, { _id: id, _creationTime: Date.now(), ...clone(value) }); return id; },
  };
  const ctx = { db, auth: { getUserIdentity: async () => null } };
  const adminCtx = { db, auth: { getUserIdentity: async () => ({ subject: "qa-drugstore-admin" }) } };
  const snapshot = () => clone([...tables].filter(([, table]) => table.size).map(([name, table]) => [name, [...table]]));
  async function transaction(handler, args, context = ctx) {
    const before = snapshot(); const beforeCounter = counter;
    try { return await handler(context, args); }
    catch (error) { tables.clear(); for (const [name, entries] of before) tables.set(name, new Map(entries)); counter = beforeCounter; throw error; }
  }
  return { ctx, adminCtx, db, tables, snapshot, transaction };
}

export function drugstoreFixture() {
  const seed = { events: [], venues: [], scrapedPosts: [], instagramEventSources: [], instagramSourceOccurrenceReceipts: [], sourceOccurrences: [], savedEvents: [], userSavedEvents: [] };
  const venue = { _id: review.venueId, _creationTime: 1, name: review.venueName, instagramHandle: review.venueHandle,
    publicStatus: "published", isActive: true, latitude: 44.82, longitude: 20.49, updatedAt: 1, createdAt: 1 };
  seed.venues.push(venue);
  for (const [index, pin] of review.rows.entries()) {
    const caption = index === 3 ? "SUBOTA, 7. NOVEMBAR - ANTIBO BEOGRAD ACID FOV - DRAGSTOR"
      : `${pin.title} SUBOTA 7. NOVEMBAR ${pin.time === "TBD" ? "" : pin.time} ${pin.venue}`;
    const sourceIdentity = `instagram-source-identity-v1:${pin.code}`;
    const sourceFingerprint = buildInstagramSourceOccurrenceFingerprint({ caption });
    const instagramPostUrl = `https://www.instagram.com/p/${pin.code}/`;
    const source = { _id: `qa-drugstore-post-${index}`, _creationTime: 1, handle: review.sourceHandle, username: review.sourceHandle,
      postId: pin.postId, caption, instagramPostUrl, postedAt: "2026-11-05T12:00:00.000Z", sourceRevision: 1, analysisRevision: 1,
      analysisContractVersion: "event_evidence_v2", analysisIsEvent: true, analysisModel: "gpt-6-luna",
      analysisResultJson: JSON.stringify({ extraction_contract_version: "event_evidence_v2", is_event: true, source_url: instagramPostUrl, source_caption: caption }),
      imageUrls: [], createdAt: 1, updatedAt: 1 };
    seed.scrapedPosts.push(source);
    const fields = { title: pin.title, time: pin.time, artists: [], normalizedDate: review.date, normalizedVenue: pin.venue,
      extractionMode: "caption", extractionContractVersion: "event_evidence_v2", extractionIsEvent: true,
      sourceGroundingVersion: 5, sourceGroundingEvidence: "persisted_openai_event_evidence_v2", normalizedIsValid: true,
      dateSuspiciousYear: false, dateEvidenceVerified: true, dateEvidenceResolvedDate: review.date,
      sourceGroundingSourceCaption: caption, sourceGroundingInstagramPostId: pin.postId, sourceGroundingInstagramPostUrl: instagramPostUrl,
      sourceGroundingInstagramHandle: review.sourceHandle, sourceOccurrenceKey: pin.key, sourceOccurrenceSourceFingerprint: sourceFingerprint };
    const event = { _id: pin.id, _creationTime: 1, title: pin.title, date: review.date, time: pin.time, artists: [], venue: pin.venue,
      status: pin.status, eventType: index === 1 ? "event" : "nightlife", description: `Original ${pin.title}`, instagramPostId: pin.postId, instagramPostUrl,
      sourceCaption: caption, sourcePostedAt: source.postedAt, sourceOccurrenceKey: pin.key, rawExtractionJson: source.analysisResultJson,
      normalizedFieldsJson: JSON.stringify(fields), createdAt: 1, updatedAt: 1 };
    Object.assign(event, buildEventOccurrenceIndexPatch(event)); seed.events.push(event);
    seed.sourceOccurrences.push({ _id: `qa-drugstore-occurrence-${index}`, _creationTime: 1, sourceIdentity, sourceFingerprint, sourceOccurrenceKey: pin.key,
      canonicalEventId: pin.id, state: "satisfied", sourceDocumentId: source._id, sourceRevision: 1, venueResolutionStatus: "unresolved",
      normalizedOccurrenceJson: JSON.stringify({ title: pin.title, date: review.date, time: pin.time, artists: [], venue: pin.venue, venueId: null, eventType: event.eventType }),
      factsJson: JSON.stringify({ originalObservedRow: index }), canonicalEventJson: JSON.stringify({ originalCanonicalRow: index }),
      provider: "instagram", canonicalSourceUrl: instagramPostUrl, occurrenceOrdinal: 1, ...buildEventOccurrenceIndexPatch(event), createdAt: 1, updatedAt: 1 });
    seed.instagramEventSources.push({ _id: `qa-drugstore-link-${index}`, _creationTime: 1, eventId: pin.id, sourceIdentity, sourceFingerprint,
      sourceOccurrenceKey: pin.key, sourceOccurrenceId: `qa-drugstore-occurrence-${index}`, instagramPostId: pin.postId, instagramPostUrl, updatedAt: 1 });
    seed.instagramSourceOccurrenceReceipts.push({ _id: `qa-drugstore-receipt-${index}`, _creationTime: 1, sourceIdentity, sourceFingerprint,
      expectedKeys: [pin.key], expectedOccurrences: [{ key: pin.key, title: pin.title, date: review.date, time: pin.time, venue: pin.venue, artists: [] }],
      satisfiedKeys: [pin.key], satisfiedOccurrences: [{ key: pin.key, eventId: pin.id }], deferredChildCount: 0, deferredChildKeys: [], createdAt: 1, updatedAt: 1 });
  }
  const sibling = { ...clone(seed.events[0]), _id: "qa-drugstore-independent", title: "Independent screening", time: "18:30", eventType: "arts & culture", sourceOccurrenceKey: "qa-drugstore-independent-key",
    humanReviewedStructuredSourcePolicyVersion: 1, reviewedAt: 1, reviewedBy: "qa-reviewer", moderationNote: "Independent earlier screening has a complete reviewed source binding." };
  sibling.normalizedFieldsJson = JSON.stringify({ ...JSON.parse(sibling.normalizedFieldsJson), title: sibling.title, time: sibling.time, sourceOccurrenceKey: sibling.sourceOccurrenceKey, humanReviewedStructuredSourcePolicyVersion: 1 });
  Object.assign(sibling, buildEventOccurrenceIndexPatch(sibling)); seed.events.push(sibling);
  const receipt = seed.instagramSourceOccurrenceReceipts[0];
  receipt.expectedKeys.push(sibling.sourceOccurrenceKey); receipt.satisfiedKeys.push(sibling.sourceOccurrenceKey);
  receipt.expectedOccurrences.push({ key: sibling.sourceOccurrenceKey, title: sibling.title, date: sibling.date, time: sibling.time, venue: sibling.venue, artists: [] });
  receipt.satisfiedOccurrences.push({ key: sibling.sourceOccurrenceKey, eventId: sibling._id });
  seed.sourceOccurrences.push({ ...clone(seed.sourceOccurrences[0]), _id: "qa-drugstore-independent-occurrence", sourceOccurrenceKey: sibling.sourceOccurrenceKey,
    canonicalEventId: sibling._id, normalizedOccurrenceJson: JSON.stringify({ title: sibling.title, date: sibling.date, time: sibling.time, artists: [], venue: sibling.venue, venueId: null, eventType: sibling.eventType }) });
  seed.instagramEventSources.push({ ...clone(seed.instagramEventSources[0]), _id: "qa-drugstore-independent-link", eventId: sibling._id, sourceOccurrenceKey: sibling.sourceOccurrenceKey, sourceOccurrenceId: "qa-drugstore-independent-occurrence" });
  seed.savedEvents.push({ _id: "qa-drugstore-save-primary", userId: "same-user", eventId: review.rows[0].id, createdAt: 1 },
    { _id: "qa-drugstore-save-duplicate", userId: "same-user", eventId: review.rows[1].id, createdAt: 2 },
    { _id: "qa-drugstore-save-new", userId: "new-user", eventId: review.rows[1].id, createdAt: 2 },
    { _id: "qa-drugstore-save-pending", userId: "pending-owner", eventId: review.rows[3].id, createdAt: 2 });
  seed.userSavedEvents.push({ _id: "qa-drugstore-legacy-primary", userId: "legacy-same", eventId: review.rows[0].id, savedAt: 1 },
    { _id: "qa-drugstore-legacy-duplicate", userId: "legacy-same", eventId: review.rows[1].id, savedAt: 2 },
    { _id: "qa-drugstore-legacy-new", userId: "legacy-new", eventId: review.rows[1].id, savedAt: 2 });
  return seed;
}

try {
  const seed = drugstoreFixture();
  const h = drugstoreHarness(seed);
  const before = await getContext._handler(h.ctx, { serviceSecret: secret });
  assert.equal(before.complete, false); assert.equal(before.events[3].status, "pending");
  assert.equal(before.events.every((event) => event.venueId === undefined), true, "The frozen incident supports the actual unbound original venue variants.");
  const args = { expectedContextSha256: before.contextSha256, moderationNote: "Reviewed four exact ANTIBO source variants and their shared November7 occurrence at Drugstore; preserve the confirmed22h start.", serviceSecret: secret };
  const siblingBefore = await h.db.get("qa-drugstore-independent");
  const result = await h.transaction(consolidate._handler, args);
  assert.deepEqual(result.rejectedIds, review.rows.slice(1).map((row) => row.id));
  assert.equal(result.movedSaveCount, 3); assert.equal(result.dedupedSaveCount, 2);
  const after = await getContext._handler(h.ctx, { serviceSecret: secret });
  assert.equal(after.complete, true);
  assert.deepEqual([after.events[0].title, after.events[0].date, after.events[0].time, after.events[0].venue, after.events[0].venueId, after.events[0].publicationState],
    ["ANTIBO", "2026-11-07", "22:00", review.venueName, review.venueId, "publishable"]);
  assert.equal(after.events[0].venueInstagramHandle, review.venueHandle);
  assert.equal(after.events[0].venueLatitude, 44.82);
  assert.equal(after.events[1].eventType, "event", "Historical component category remains unchanged while its representative retains nightlife.");
  assert.equal(after.links.length, 4); assert.equal(after.occurrences.length, 4);
  for (const source of before.sources) assert.deepEqual(await h.db.get(source._id), source);
  for (const occurrence of before.occurrences) {
    const final = await h.db.get(occurrence._id);
    assert.equal(final.factsJson, occurrence.factsJson); assert.equal(final.canonicalEventJson, occurrence.canonicalEventJson);
    assert.equal(final.canonicalEventId, review.rows[0].id); assert.equal(final.venueId, review.venueId); assert.equal(final.venueResolutionStatus, "resolved");
  }
  for (const original of before.events) {
    const final = await h.db.get(original._id);
    assert.equal(final.rawExtractionJson, original.rawExtractionJson); assert.equal(final.sourceCaption, original.sourceCaption);
    assert.equal(isCrossPostCampaignLineageEvent(final), true, "Existing generic mutation/replay fences protect every incident member.");
  }
  assert.deepEqual(await h.db.get("qa-drugstore-independent"), siblingBefore);
  const siblingReceipt = after.receipts.find((row) => row._id === "qa-drugstore-receipt-0");
  assert.deepEqual(siblingReceipt.expectedOccurrences.find((row) => row.key === "qa-drugstore-independent-key"), seed.instagramSourceOccurrenceReceipts[0].expectedOccurrences[1]);
  assert.ok(after.saves.slice(1).every((refs) => !refs.canonical.length && !refs.legacy.length));
  const appliedSnapshot = h.snapshot();
  await assert.rejects(() => h.transaction(consolidate._handler, args), /already applied/u);
  await assert.rejects(() => h.transaction(updateEvent._handler, { id: review.rows[0].id, expectedUpdatedAt: after.events[0].updatedAt, patch: { description: "Unsafe generic mutation" } }, h.adminCtx), /[Cc]ampaign|[Ll]ineage|re-attestation/u);
  assert.deepEqual(h.snapshot(), appliedSnapshot);
  for (const corrupt of [
    (state) => { state.tables.get("events").get(review.rows[1].id).updatedAt += 1; },
    (state) => { state.tables.get("events").get(review.rows[0].id).venue = "Another venue"; },
    (state) => { state.tables.get("events").get(review.rows[0].id).date = "2026-11-08"; },
    (state) => { state.tables.get("events").get(review.rows[3].id).status = "approved"; },
    (state) => { state.tables.get("scrapedPosts").get("qa-drugstore-post-0").handle = "another-promoter"; },
    (state) => { state.tables.get("sourceOccurrences").get("qa-drugstore-occurrence-0").sourceRevision += 1; },
    (state) => { state.tables.get("instagramSourceOccurrenceReceipts").get("qa-drugstore-receipt-0").updatedAt += 1; },
    (state) => { state.tables.get("venues").get(review.venueId).updatedAt += 1; },
    (state) => { state.tables.get("savedEvents").set("new-save", { _id: "new-save", userId: "later-user", eventId: review.rows[2].id, createdAt: 3 }); },
  ]) {
    const fresh = drugstoreHarness(seed); corrupt(fresh); const corrupted = fresh.snapshot();
    await assert.rejects(() => fresh.transaction(consolidate._handler, args), /Reviewed Drugstore repair/u);
    assert.deepEqual(fresh.snapshot(), corrupted, "A stale or changed full-context preimage cannot write partial repairs.");
  }
  const collision = drugstoreHarness(seed);
  collision.tables.get("events").set("qa-unreviewed-duplicate", { ...clone(seed.events[0]), _id: "qa-unreviewed-duplicate", venue: review.venueName, venueId: review.venueId, instagramPostId: "other-post", instagramPostUrl: "https://www.instagram.com/p/OtherDrugstoreSource/" });
  await assert.rejects(() => collision.transaction(consolidate._handler, args), /[Dd]uplicate|[Aa]mbiguous|already exists/u);
  const interrupted = drugstoreHarness(seed); const originalPatch = interrupted.db.patch;
  interrupted.db.patch = async (id, patch) => { if (id === review.rows[1].id) throw new Error("Forced Drugstore post-receipt failure."); return originalPatch(id, patch); };
  const interruptedBefore = interrupted.snapshot();
  await assert.rejects(() => interrupted.transaction(consolidate._handler, args), /Forced Drugstore/u);
  assert.deepEqual(interrupted.snapshot(), interruptedBefore, "A failure after primary/receipt changes rolls back venue binding, receipts, provenance and saves together.");
  await assert.rejects(() => getContext._handler(h.ctx, { serviceSecret: "wrong" }), /Authentication|Admin/u);
  await assert.rejects(() => getContext._handler(h.adminCtx, { serviceSecret: "wrong" }), /service authentication/u);
  console.log("Reviewed Drugstore November operator passed: exact frozen unbound variants, pending component, atomic canonical binding, four-source provenance/save preservation, source/sibling immutability, stale-plan/auth/collision/replay guards and rollback.");
} finally {
  Date.now = originalNow;
  if (originalSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = originalSecret;
  if (originalAdmin === undefined) delete process.env.ADMIN_CLERK_USER_IDS; else process.env.ADMIN_CLERK_USER_IDS = originalAdmin;
}
