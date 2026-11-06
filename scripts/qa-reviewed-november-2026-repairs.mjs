import assert from "node:assert/strict";
import { getContext, consolidate } from "../convex/reviewedNovember2026Repairs.ts";
import { NOVEMBER_2026_REVIEWS, withNovember2026ReadCache } from "../convex/internal/eventRepairs/reviewedNovember2026Repairs.ts";
import { isCrossPostCampaignLineageEvent } from "../lib/events/cross-post-campaign-aggregate-attestation.ts";
import { buildInstagramSourceOccurrenceFingerprint } from "../lib/domain/occurrences/source-fingerprint.ts";
import { buildEventOccurrenceIndexPatch } from "../convex/sourceOccurrences.ts";
import { deleteExpiredEventWithSavedReferences } from "../convex/eventDomain/persistence.ts";
import { updateEvent, mergeApprovedEvents, deleteApprovedEvent, recordInstagramSourceOccurrenceSatisfaction } from "../convex/events.ts";

const clone = (value) => structuredClone(value);
const secret = "qa-reviewed-november-secret";
const originalSecret = process.env.CRON_SECRET;
const originalAdmin = process.env.ADMIN_CLERK_USER_IDS;
const originalNow = Date.now;
process.env.CRON_SECRET = secret;
process.env.ADMIN_CLERK_USER_IDS = "qa-admin";
Date.now = () => Date.parse("2026-11-06T12:00:00.000Z");

export function harness(seed) {
  const tables = new Map(Object.entries(seed).map(([name, rows]) => [name, new Map(rows.map((row) => [row._id, clone(row)]))]));
  const getTable = (name) => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name); };
  let counter = 0;
  const queryReads = [];
  const rangeCallbacks = [];
  const find = (id) => [...tables.values()].find((table) => table.has(id));
  const rows = (name, predicates) => [...getTable(name).values()].filter((row) => predicates.every((predicate) => predicate(row))).map(clone);
  const result = (name, predicates = []) => ({
    withIndex(_index, callback) {
      rangeCallbacks.push(_index);
      const filters = [];
      const builder = Object.fromEntries(["eq", "gt", "gte", "lt", "lte"].map((op) => [op, (field, value) => {
        filters.push((row) => op === "eq" ? row[field] === value : op === "gt" ? row[field] > value : op === "gte" ? row[field] >= value : op === "lt" ? row[field] < value : row[field] <= value);
        return builder;
      }]));
      callback(builder); return result(name, [...predicates, ...filters]);
    },
    order() { return this; },
    async take(limit) { queryReads.push([name, "take", limit]); return rows(name, predicates).slice(0, limit); },
    async first() { queryReads.push([name, "first"]); return rows(name, predicates)[0] ?? null; },
    async unique() { queryReads.push([name, "unique"]); const found = rows(name, predicates); assert.ok(found.length < 2); return found[0] ?? null; },
    async collect() { throw new Error("Unbounded QA query forbidden."); },
  });
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
    async replace(id, value) { const table = find(id); assert.ok(table); table.set(id, { _id: id, ...clone(value) }); },
    async delete(id) { assert.ok(find(id)?.delete(id)); },
    async insert(name, value) {
      const id = `qa-${name}-${++counter}`;
      getTable(name).set(id, { _id: id, _creationTime: Date.now(), ...clone(value) }); return id;
    },
  };
  const ctx = { db, auth: { getUserIdentity: async () => null } };
  const adminCtx = { db, auth: { getUserIdentity: async () => ({ subject: "qa-admin" }) } };
  const snapshot = () => clone([...tables].map(([name, table]) => [name, [...table]]));
  async function transaction(handler, args, context = ctx) {
    const before = snapshot();
    try { return await handler(context, args); }
    catch (error) { tables.clear(); for (const [name, entries] of before) tables.set(name, new Map(entries)); throw error; }
  }
  return { ctx, adminCtx, db, tables, snapshot, transaction, queryReads, rangeCallbacks };
}

function fixture(groupKey) {
  const review = NOVEMBER_2026_REVIEWS[groupKey];
  const seed = { events: [], venues: [], scrapedPosts: [], instagramEventSources: [], instagramSourceOccurrenceReceipts: [], sourceOccurrences: [], savedEvents: [], userSavedEvents: [], users: [], sourceOccurrenceTopologyEpoch: [] };
  const venue = { _id: review.venueId, _creationTime: 1, name: groupKey === "kuko-nov7" ? "Hangar" : groupKey === "bife-nov7" ? "Bife Bar" : "Reviewed Venue", instagramHandle: review.handle || "reviewedvenue", publicStatus: "published", isActive: true, updatedAt: 1, createdAt: 1 };
  seed.venues.push(venue);
  const caption = groupKey === "bife-nov7"
    ? "MY THAI WEEKEND 07.11 - PAD KRA PAO 17:00 700 RSD; AUX OF PAIN (FELIX BONDAREV & ANTON BEREZIN) 20:00"
    : groupKey === "vrtoglavica-nov6" ? "06.11.2026 23:00-05:00 Suicide Disco. DJ Gavra & DJ RedRev. Gornji Klub: Divorced Dad Rock. Sredina: Chillout Zone."
      : "Exact user-reviewed source with separately dated schedule rows.";
  const byPost = new Map();
  for (const [index, [id, code, title, time]] of review.rows.entries()) {
    const sourceIdentity = `instagram-source-identity-v1:${code}`;
    const handle = review.handle || venue.instagramHandle;
    const sourceFingerprint = buildInstagramSourceOccurrenceFingerprint({ caption });
    const instagramPostUrl = `https://www.instagram.com/p/${code}/`;
    const postedAt = "2026-10-27T12:00:00.000Z";
    let source = byPost.get(code);
    if (!source) {
      source = { _id: `qa-post-${code}`, _creationTime: 1, handle, username: handle, postId: `qa-post-id-${code}`, caption, instagramPostUrl,
        postedAt, sourceRevision: 1, analysisRevision: 1, analysisContractVersion: "event_evidence_v2", analysisIsEvent: true, analysisModel: "gpt-6-luna",
        analysisResultJson: JSON.stringify({ extraction_contract_version: "event_evidence_v2", is_event: true, source_url: instagramPostUrl, source_caption: caption }),
        processingStatus: "processing", processingLeaseOwner: "qa-owner", processingLeaseExpiresAt: Date.now() + 100000,
        imageUrls: [], createdAt: 1, updatedAt: 1 };
      byPost.set(code, source); seed.scrapedPosts.push(source);
    }
    const key = `qa-occurrence:${code}:${index}`;
    const artists = groupKey === "bife-nov7" && index === 1 ? ["Aux of Pain", "Felix Bondarev", "Anton Berezin"]
      : groupKey === "vrtoglavica-nov6" && index === 0 ? ["DJ Gavra", "DJ RedRev"] : [];
    const fields = { title, time, artists, normalizedDate: review.date, normalizedVenue: venue.name,
      extractionMode: "caption", extractionContractVersion: "event_evidence_v2", extractionIsEvent: true,
      sourceGroundingVersion: 5, sourceGroundingEvidence: "persisted_openai_event_evidence_v2",
      normalizedIsValid: true, dateSuspiciousYear: false, dateEvidenceVerified: true, dateEvidenceResolvedDate: review.date,
      sourceGroundingSourceCaption: caption, sourceGroundingInstagramPostId: source.postId,
      sourceGroundingInstagramPostUrl: instagramPostUrl, sourceGroundingInstagramHandle: handle,
      sourceOccurrenceKey: key, sourceOccurrenceSourceFingerprint: sourceFingerprint,
      humanReviewedStructuredSourcePolicyVersion: 1 };
    const event = { _id: id, _creationTime: 1, title, date: review.date, time, artists, venue: venue.name, venueId: venue._id,
      normalizedVenueIdentity: venue.name.toLowerCase(), normalizedVenueInstagramHandle: venue.instagramHandle, venueInstagramHandle: venue.instagramHandle,
      status: index > 0 && index === review.rows.length - 1 ? "pending" : "approved", eventType: "nightlife", description: `Original ${title}`,
      instagramPostId: source.postId, instagramPostUrl, sourceCaption: caption, sourcePostedAt: postedAt,
      sourceOccurrenceKey: key, rawExtractionJson: source.analysisResultJson, normalizedFieldsJson: JSON.stringify(fields),
      humanReviewedStructuredSourcePolicyVersion: 1, reviewedAt: 1, reviewedBy: "qa-reviewer", moderationNote: "Previous exact source review with substantive explanation.", createdAt: 1, updatedAt: 1 };
    if (groupKey === "bife-nov7" && index === 0) event.ticketPrice = "700 RSD";
    Object.assign(event, buildEventOccurrenceIndexPatch(event));
    seed.events.push(event);
    const normalizedOccurrenceJson = JSON.stringify({ title, date: event.date, time, artists, venue: venue.name, venueId: venue._id, eventType: event.eventType });
    seed.sourceOccurrences.push({ _id: `qa-source-occurrence-${index}`, _creationTime: 1, sourceIdentity, sourceFingerprint, sourceOccurrenceKey: key,
      canonicalEventId: id, state: "satisfied", sourceDocumentId: source._id, sourceRevision: 1, venueId: venue._id, venueResolutionStatus: "resolved",
      normalizedOccurrenceJson, factsJson: JSON.stringify({ immutableObservedRow: index }), canonicalEventJson: JSON.stringify({ immutableCanonicalRow: index }),
      provider: "instagram", canonicalSourceUrl: instagramPostUrl, occurrenceOrdinal: index + 1, ...buildEventOccurrenceIndexPatch(event), createdAt: 1, updatedAt: 1 });
    seed.instagramEventSources.push({ _id: `qa-link-${index}`, _creationTime: 1, eventId: id, sourceIdentity, sourceFingerprint, sourceOccurrenceKey: key,
      sourceOccurrenceId: `qa-source-occurrence-${index}`, instagramPostId: source.postId, instagramPostUrl, sourceHandle: handle, createdAt: 1, updatedAt: 1 });
    let receipt = seed.instagramSourceOccurrenceReceipts.find((item) => item.sourceIdentity === sourceIdentity);
    if (!receipt) { receipt = { _id: `qa-receipt-${code}`, _creationTime: 1, sourceIdentity, sourceFingerprint, expectedKeys: [], expectedOccurrences: [], satisfiedKeys: [], satisfiedOccurrences: [], deferredChildCount: 0, deferredChildKeys: [], createdAt: 1, updatedAt: 1 }; seed.instagramSourceOccurrenceReceipts.push(receipt); }
    receipt.expectedKeys.push(key); receipt.satisfiedKeys.push(key);
    receipt.expectedOccurrences.push({ key, title, date: event.date, time, venue: event.venue, artists }); receipt.satisfiedOccurrences.push({ key, eventId: id });
  }
  if (groupKey === "bitef-nov6") {
    const event = seed.events[2];
    const latestLink = seed.instagramEventSources[2];
    const latestOccurrence = seed.sourceOccurrences[2];
    const latestFields = JSON.parse(event.normalizedFieldsJson);
    const oldKey = "instagram-occurrence-v2:7af554834084ea90cf27a67569daa431b09663b522787571476a64bd0a6409bc";
    const latestKey = "instagram-occurrence-v2:31126e9cc2382e4b46f75f6f3948de874b267682576dff6124038334c6af13db";
    const previousKey = latestLink.sourceOccurrenceKey;
    event.sourceOccurrenceKey = oldKey;
    latestFields.sourceOccurrenceKey = latestKey;
    event.normalizedFieldsJson = JSON.stringify(latestFields);
    latestLink._id = "kx71vqyt7qghnyn7wa8e964pds8hfxht";
    latestLink.sourceOccurrenceKey = latestKey;
    latestOccurrence.sourceOccurrenceKey = latestKey;
    const latestReceipt = seed.instagramSourceOccurrenceReceipts.find((row) => row.sourceIdentity === latestLink.sourceIdentity);
    latestReceipt.expectedKeys = latestReceipt.expectedKeys.map((key) => key === previousKey ? latestKey : key);
    latestReceipt.satisfiedKeys = latestReceipt.satisfiedKeys.map((key) => key === previousKey ? latestKey : key);
    latestReceipt.expectedOccurrences = latestReceipt.expectedOccurrences.map((row) => ({ ...row, key: latestKey }));
    latestReceipt.satisfiedOccurrences = latestReceipt.satisfiedOccurrences.map((row) => ({ ...row, key: latestKey }));
    const oldCaption = "Earlier independently saved November performance schedule.";
    const oldFingerprint = buildInstagramSourceOccurrenceFingerprint({ caption: oldCaption });
    const oldSource = { ...clone(seed.scrapedPosts[2]), _id: "qa-old-bitef-source", postId: "qa-old-bitef-post-id",
      instagramPostUrl: "https://www.instagram.com/p/DfEpAnJtj4U/", caption: oldCaption,
      analysisResultJson: JSON.stringify({ extraction_contract_version: "event_evidence_v2", is_event: true, source_caption: oldCaption }) };
    seed.scrapedPosts.push(oldSource);
    const oldFields = { ...latestFields, sourceOccurrenceKey: oldKey, sourceOccurrenceSourceFingerprint: oldFingerprint,
      sourceGroundingSourceCaption: oldCaption, sourceGroundingInstagramPostId: oldSource.postId, sourceGroundingInstagramPostUrl: oldSource.instagramPostUrl };
    const oldOccurrence = { ...clone(latestOccurrence), _id: "qa-old-bitef-occurrence", sourceIdentity: "instagram-source-identity-v1:DfEpAnJtj4U",
      sourceFingerprint: oldFingerprint, sourceOccurrenceKey: oldKey, sourceDocumentId: oldSource._id,
      canonicalSourceUrl: oldSource.instagramPostUrl,
      canonicalEventJson: JSON.stringify({ normalizedFieldsJson: JSON.stringify(oldFields), requestedStatus: "pending", sourceConflictFields: [],
        time: "20:00", timeConfidence: 0.95, timeSource: "schedule_entry", timeStatus: "confirmed" }) };
    seed.sourceOccurrences.push(oldOccurrence);
    seed.instagramEventSources.push({ ...clone(latestLink), _id: "kx7evzc6gnhcypf755bm8a8r558h9sp9", sourceIdentity: oldOccurrence.sourceIdentity,
      sourceFingerprint: oldFingerprint, sourceOccurrenceKey: oldKey, sourceOccurrenceId: oldOccurrence._id,
      instagramPostId: oldSource.postId, instagramPostUrl: oldSource.instagramPostUrl });
    seed.instagramSourceOccurrenceReceipts.push({ _id: "qa-old-bitef-receipt", _creationTime: 1, sourceIdentity: oldOccurrence.sourceIdentity,
      sourceFingerprint: oldFingerprint, expectedKeys: [oldKey], expectedOccurrences: [{ key: oldKey, title: event.title, date: event.date, time: event.time, venue: event.venue, artists: event.artists }],
      satisfiedKeys: [oldKey], satisfiedOccurrences: [{ key: oldKey, eventId: event._id }], deferredChildCount: 0, deferredChildKeys: [], createdAt: 1, updatedAt: 1 });
  }
  // Independent rows at the same venue, including a different-time performance,
  // must survive exactly. A shared-receipt sibling also exercises source-wide reads.
  const original = seed.events[0];
  const sibling = { ...clone(original), _id: "qa-unrelated-performance", title: "Independent performance", time: "18:30", sourceOccurrenceKey: "qa-independent-key", status: "approved" };
  sibling.normalizedFieldsJson = JSON.stringify({ ...JSON.parse(sibling.normalizedFieldsJson), title: sibling.title, time: sibling.time, sourceOccurrenceKey: sibling.sourceOccurrenceKey });
  Object.assign(sibling, buildEventOccurrenceIndexPatch(sibling)); seed.events.push(sibling);
  const firstReceipt = seed.instagramSourceOccurrenceReceipts[0];
  firstReceipt.expectedKeys.push(sibling.sourceOccurrenceKey); firstReceipt.satisfiedKeys.push(sibling.sourceOccurrenceKey);
  firstReceipt.expectedOccurrences.push({ key: sibling.sourceOccurrenceKey, title: sibling.title, date: sibling.date, time: sibling.time, venue: sibling.venue, artists: sibling.artists });
  firstReceipt.satisfiedOccurrences.push({ key: sibling.sourceOccurrenceKey, eventId: sibling._id });
  const firstSource = seed.scrapedPosts[0];
  seed.sourceOccurrences.push({ ...clone(seed.sourceOccurrences[0]), _id: "qa-unrelated-source-occurrence", sourceOccurrenceKey: sibling.sourceOccurrenceKey, canonicalEventId: sibling._id,
    normalizedOccurrenceJson: JSON.stringify({ title: sibling.title, date: sibling.date, time: sibling.time, artists: sibling.artists, venue: sibling.venue, venueId: sibling.venueId, eventType: sibling.eventType }) });
  seed.instagramEventSources.push({ ...clone(seed.instagramEventSources[0]), _id: "qa-unrelated-link", eventId: sibling._id, sourceOccurrenceKey: sibling.sourceOccurrenceKey, sourceOccurrenceId: "qa-unrelated-source-occurrence" });
  if (groupKey === "kuko-nov7") {
    for (const link of seed.instagramEventSources) delete link.sourceOccurrenceId;
    seed.sourceOccurrences = seed.sourceOccurrences.filter((row) => row._id !== "qa-source-occurrence-0");
  }
  seed.savedEvents.push({ _id: "qa-save-primary", userId: "same-user", eventId: original._id, createdAt: 1 },
    { _id: "qa-save-component-same", userId: "same-user", eventId: review.rows[1][0], createdAt: 2 },
    { _id: "qa-save-component-new", userId: "other-user", eventId: review.rows[1][0], createdAt: 2 });
  seed.userSavedEvents.push({ _id: "qa-legacy-primary", userId: "qa-legacy-user", eventId: original._id, savedAt: 1 },
    { _id: "qa-legacy-component-same", userId: "qa-legacy-user", eventId: review.rows[1][0], savedAt: 2 },
    { _id: "qa-legacy-component-new", userId: "qa-legacy-other", eventId: review.rows[1][0], savedAt: 2 });
  return { seed, review, firstSource };
}

try {
  const pointReads = [];
  const cacheHarness = harness({ events: [{ _id: "cache-a", title: "before" }, { _id: "cache-b", title: "unchanged" }] });
  const rawGet = cacheHarness.db.get;
  cacheHarness.db.get = async (...args) => { pointReads.push(args); return rawGet(...args); };
  const cachedCtx = withNovember2026ReadCache(cacheHarness.ctx);
  await cachedCtx.db.get("cache-a"); await cachedCtx.db.get("cache-a"); await cachedCtx.db.get("cache-b");
  assert.equal(pointReads.length, 2, "Repeated point reads share one invocation snapshot.");
  await cachedCtx.db.patch("cache-a", { title: "after patch" });
  assert.equal((await cachedCtx.db.get("cache-a")).title, "after patch");
  await cachedCtx.db.get("cache-b");
  assert.equal(pointReads.length, 4, "Every write clears the entire point-read cache.");
  await cachedCtx.db.replace("cache-a", { title: "after replace" });
  assert.equal((await cachedCtx.db.get("cache-a")).title, "after replace");
  const inserted = await cachedCtx.db.insert("events", { title: "inserted" });
  assert.equal((await cachedCtx.db.get(inserted)).title, "inserted");
  await cachedCtx.db.delete(inserted);
  assert.equal(await cachedCtx.db.get(inserted), null);
  await withNovember2026ReadCache(cacheHarness.ctx).db.get("cache-a");
  assert.equal(pointReads.length, 8, "A new invocation never reuses another invocation's cached values.");
  const queryHarness = harness({ events: [
    { _id: "query-a", title: "same", score: 1 }, { _id: "query-b", title: "same", score: 2 },
    { _id: "query-c", title: "different", score: 3 },
  ], other: [{ _id: "query-other", title: "same", score: 1 }] });
  const queryCtx = withNovember2026ReadCache(queryHarness.ctx);
  const byTitle = (title, table = "events") => queryCtx.db.query(table).withIndex("by_title", (q) => q.eq("title", title));
  const originalOrder = await byTitle("same").take(10);
  originalOrder.reverse();
  assert.deepEqual((await byTitle("same").take(10)).map((row) => row._id), ["query-a", "query-b"]);
  assert.equal(queryHarness.queryReads.length, 1, "Identical bounded queries reuse their result and preserve cached array order.");
  assert.equal(queryHarness.rangeCallbacks.length, 2, "Each original native range callback executes exactly once, including cached queries.");
  assert.deepEqual((await byTitle("different").take(10)).map((row) => row._id), ["query-c"], "Same closure body with different captured bound values must not share results.");
  assert.equal((await byTitle("same").take(1)).length, 1, "Different limits are different queries.");
  await byTitle("same").order("asc").take(10);
  await byTitle("same").order("desc").take(10);
  assert.equal(queryHarness.queryReads.length, 5, "Order is part of the cache key.");
  assert.equal((await byTitle("same").first())._id, "query-a");
  assert.equal((await byTitle("different").unique())._id, "query-c");
  assert.equal((await byTitle("same", "other").take(10))[0]._id, "query-other");
  const byRange = (lower) => queryCtx.db.query("events").withIndex("by_score", (q) => q.gte("score", lower).lt("score", 3));
  assert.equal((await byRange(1).take(10)).length, 2);
  assert.equal((await byRange(2).take(10)).length, 1);
  const readsBeforePatch = queryHarness.queryReads.length;
  await queryCtx.db.patch("query-a", { title: "different" });
  assert.deepEqual((await byTitle("same").take(10)).map((row) => row._id), ["query-b"]);
  assert.equal((await byTitle("different").take(10)).length, 2);
  assert.equal(queryHarness.queryReads.length, readsBeforePatch + 2, "Every write invalidates ALL query result cohorts.");
  await withNovember2026ReadCache(queryHarness.ctx).db.query("events").withIndex("by_title", (q) => q.eq("title", "same")).take(10);
  assert.equal(queryHarness.queryReads.length, readsBeforePatch + 3, "Query results never cross invocation boundaries.");
  for (const groupKey of Object.keys(NOVEMBER_2026_REVIEWS)) {
    const { seed, review, firstSource } = fixture(groupKey);
    const h = harness(seed);
    const before = await getContext._handler(h.ctx, { groupKey, serviceSecret: secret });
    assert.equal(before.complete, false);
    assert.match(before.contextSha256, /^[a-f0-9]{64}$/u);
    const args = { groupKey, expectedContextSha256: before.contextSha256, moderationNote: "User reviewed these exact public source rows and requested one consolidated occurrence.", serviceSecret: secret };
    const siblingBefore = await h.db.get("qa-unrelated-performance");
    const sourceBefore = clone(seed.scrapedPosts);
    const observedBefore = before.occurrences.map((row) => [row._id, row.factsJson, row.canonicalEventJson]);
    const result = await h.transaction(consolidate._handler, args);
    assert.equal(result.rejectedIds.length, review.rows.length - 1);
    assert.equal(result.movedSaveCount, 2); assert.equal(result.dedupedSaveCount, 2);
    const after = await getContext._handler(h.ctx, { groupKey, serviceSecret: secret });
    assert.equal(after.complete, true);
    assert.equal(after.events[0].publicationState, "publishable");
    assert.deepEqual(await h.db.get("qa-unrelated-performance"), siblingBefore);
    for (const source of sourceBefore) assert.deepEqual(await h.db.get(source._id), source);
    for (const [id, facts, canonical] of observedBefore) { const occurrence = await h.db.get(id); assert.equal(occurrence.factsJson, facts); assert.equal(occurrence.canonicalEventJson, canonical); }
    for (const event of after.events) assert.equal(isCrossPostCampaignLineageEvent(event), true);
    for (const component of after.events.slice(1)) assert.equal(component.status, "rejected");
    assert.equal(after.links.length, review.rows.length + (groupKey === "bitef-nov6" ? 1 : 0));
    assert.ok(after.saves.slice(1).every((item) => item.canonical.length === 0 && item.legacy.length === 0));
    if (groupKey === "bife-nov7") { assert.equal(after.events[0].ticketPrice, undefined); assert.match(after.events[0].description, /700 RSD per dish.*20:00/u); }
    const immutable = h.snapshot();
    await assert.rejects(() => h.transaction(consolidate._handler, args), /already applied/u);
    await assert.rejects(() => h.transaction(updateEvent._handler, { id: review.rows[0][0], expectedUpdatedAt: after.events[0].updatedAt, patch: { description: "Unsafe generic change" } }, h.adminCtx), /[Cc]ampaign|[Ll]ineage|re-attestation/u);
    await assert.rejects(() => h.transaction(mergeApprovedEvents._handler, { primaryId: review.rows[0][0], duplicateIds: [], patch: {} }, h.adminCtx), /[Cc]ampaign|[Ll]ineage|re-attestation/u);
    await assert.rejects(() => h.transaction(deleteApprovedEvent._handler, { id: review.rows[0][0], expectedUpdatedAt: after.events[0].updatedAt }, h.adminCtx), /[Cc]ampaign|[Ll]ineage|[Rr]etire|[Dd]edicated/u);
    const receipt = before.receipts.find((item) => item.sourceIdentity === `instagram-source-identity-v1:${review.rows[0][1]}`);
    const plan = { sourceIdentity: receipt.sourceIdentity, sourceFingerprint: receipt.sourceFingerprint, previousSourceFingerprint: receipt.sourceFingerprint,
      expectedKeys: receipt.expectedKeys, expectedOccurrences: receipt.expectedOccurrences, deferredChildCount: 0, deferredChildKeys: [], observedChildKeys: receipt.expectedKeys };
    await assert.rejects(() => h.transaction(recordInstagramSourceOccurrenceSatisfaction._handler, { plan, satisfiedKey: before.links[0].sourceOccurrenceKey, representativeEventId: before.events[0]._id,
      processingFence: { handle: firstSource.handle, scrapedPostId: firstSource._id, owner: "qa-owner", sourceRevision: 1 }, serviceSecret: secret }), /[Cc]ampaign|[Ll]ineage|[Ff]olded|re-attestation/u);
    const retention = await h.transaction((ctx) => deleteExpiredEventWithSavedReferences(ctx, after.events[0], { isoDate: "2026-11-10", minutesSinceMidnight: 0 }), {});
    assert.deepEqual(retention, { deletedEventIds: [], deletedReferenceCount: 0, retainedEventCount: 1, topologyMutated: false },
      "Generic retention must preserve a reviewed incident until a dedicated audited retirement exists.");
    assert.deepEqual(h.snapshot(), immutable, "Every rejected replay/generic edit must roll back completely.");
    for (const corrupt of [
      (state) => { state.tables.get("events").get(review.rows[1][0]).updatedAt += 1; },
      (state) => { state.tables.get("sourceOccurrences").get(before.occurrences[0]._id).sourceRevision += 1; },
      (state) => { state.tables.get("events").get(review.rows[0][0]).date = "2026-11-08"; },
      (state) => { state.tables.get("savedEvents").set("new-save", { _id: "new-save", userId: "later-user", eventId: review.rows[1][0], createdAt: 3 }); },
    ]) {
      const fresh = harness(seed); corrupt(fresh); const corruptBefore = fresh.snapshot();
      await assert.rejects(() => fresh.transaction(consolidate._handler, args), /Reviewed November repair/u);
      assert.deepEqual(fresh.snapshot(), corruptBefore);
    }
    await assert.rejects(() => getContext._handler(h.ctx, { groupKey, serviceSecret: "wrong" }), /Authentication|Admin/u);
    await assert.rejects(() => getContext._handler(h.adminCtx, { groupKey, serviceSecret: "wrong" }), /service authentication/u);
    const interrupted = harness(seed);
    const originalPatch = interrupted.db.patch;
    interrupted.db.patch = async (id, patch) => {
      if (id === review.rows[1][0]) throw new Error("Forced post-receipt transaction failure.");
      return originalPatch(id, patch);
    };
    const interruptedBefore = interrupted.snapshot();
    await assert.rejects(() => interrupted.transaction(consolidate._handler, args), /Forced post-receipt/u);
    assert.deepEqual(interrupted.snapshot(), interruptedBefore, "A failure after primary/receipt writes rolls back all tables.");
    h.tables.get("events").get(review.rows[0][0]).status = "pending";
    await assert.rejects(() => getContext._handler(h.ctx, { groupKey, serviceSecret: secret }), /applied incident/u);
  }
  console.log("Reviewed November 2026 repairs passed: seven fixed incidents, atomic provenance/save movement, pending components, exact sibling preservation, immutable source evidence, stale-plan rejection, full after-proof and guarded cached replay/generic writes.");
} finally {
  Date.now = originalNow;
  if (originalSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = originalSecret;
  if (originalAdmin === undefined) delete process.env.ADMIN_CLERK_USER_IDS; else process.env.ADMIN_CLERK_USER_IDS = originalAdmin;
}
