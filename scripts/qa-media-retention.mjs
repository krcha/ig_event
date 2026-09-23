import assert from "node:assert/strict";
import { deleteOrphanedPage } from "../convex/mediaAssets.ts";
import { deleteOlderThan } from "../convex/scrapedPosts.ts";
import { buildInstagramSourceOccurrenceFingerprint } from "../lib/domain/occurrences/source-fingerprint.ts";
import { adaptInstagramScrapedPostToSourceDocument } from "../lib/domain/source-documents.ts";

const NOW = Date.parse("2026-09-17T16:00:00Z");
const CUTOFF = Date.parse("2026-09-10T16:00:00Z");
const realNow = Date.now;
Date.now = () => NOW;

function fixture() {
  const tables = new Map();
  const storageDeleted = [];
  const rows = (table) => {
    if (!tables.has(table)) tables.set(table, new Map());
    return tables.get(table);
  };
  let sequence = 0;
  const put = (table, doc) => rows(table).set(doc._id, structuredClone(doc));
  const result = (table, predicates = []) => {
    const matching = () => [...rows(table).values()]
      .filter((row) => predicates.every((predicate) => predicate(row)))
      .sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0) || a._id.localeCompare(b._id));
    return {
      async first() { return structuredClone(matching()[0] ?? null); },
      async unique() {
        assert.ok(matching().length <= 1);
        return this.first();
      },
      async take(limit) { return structuredClone(matching().slice(0, limit)); },
      async paginate({ cursor, numItems }) {
        const after = cursor ? JSON.parse(cursor) : null;
        const remaining = matching().filter((row) => !after ||
          row.updatedAt > after.updatedAt ||
          (row.updatedAt === after.updatedAt && row._id > after.id));
        const page = remaining.slice(0, numItems);
        const last = page.at(-1);
        return {
          page: structuredClone(page),
          isDone: remaining.length <= numItems,
          continueCursor: last ? JSON.stringify({ id: last._id, updatedAt: last.updatedAt }) : "",
        };
      },
    };
  };
  const ctx = {
    db: {
      query(table) {
        return {
          withIndex(_name, configure) {
            const predicates = [];
            const q = {
              eq(field, value) { predicates.push((row) => row[field] === value); return q; },
              lt(field, value) { predicates.push((row) => row[field] < value); return q; },
            };
            configure(q);
            return result(table, predicates);
          },
        };
      },
      async patch(id, patch) {
        const table = [...tables.values()].find((table) => table.has(id));
        assert.ok(table, `Missing patch target ${id}`);
        const next = { ...table.get(id), ...structuredClone(patch) };
        for (const [key, value] of Object.entries(next)) if (value === undefined) delete next[key];
        table.set(id, next);
      },
      async insert(table, doc) {
        const id = `${table}-${++sequence}`;
        put(table, { _id: id, ...doc });
        return id;
      },
      async delete(id) {
        const table = [...tables.values()].find((table) => table.has(id));
        assert.ok(table, `Missing deletion target ${id}`);
        table.delete(id);
      },
    },
    storage: { async delete(storageId) { storageDeleted.push(storageId); } },
  };
  const add = (name, { post = true, occurrence = true, assetUpdatedAt = CUTOFF - 1000 } = {}) => {
    const postId = `POST_${name}`;
    const instagramPostUrl = `https://www.instagram.com/p/${postId}/`;
    const asset = {
      _id: `asset-${name}`, instagramPostId: postId, canonicalSourceUrl: instagramPostUrl,
      normalizedInstagramPostUrl: instagramPostUrl, sourceKey: `instagram:${postId}`,
      storageId: `storage-${name}`, url: `https://storage.example/${name}`,
      updatedAt: assetUpdatedAt,
    };
    put("mediaAssets", asset);
    const source = {
      _id: `post-${name}`, handle: "qa", username: "qa", postId, instagramPostUrl,
      canonicalSourceUrl: instagramPostUrl, normalizedInstagramPostUrl: instagramPostUrl,
      imageStorageId: asset.storageId, imageUrl: asset.url,
      imageUrls: [`https://images.apifyusercontent.com/${name}.jpg`], caption: "Original evidence",
      sourceRevision: 1, analysisRevision: 1, analysisResultJson: '{"isEvent":true}',
      processingStatus: "completed", processingOutcome: "receipt_complete", blocksPaidFetch: false,
      updatedAt: assetUpdatedAt,
    };
    if (post) put("scrapedPosts", source);
    const child = {
      _id: `occurrence-${name}`, sourceDocumentId: source._id, sourceRevision: 1,
      canonicalSourceUrl: instagramPostUrl,
      state: "superseded", occurrenceDateKey: "2026-09-01", occurrenceTimeIdentity: "19:00",
      factsJson: '{"title":"Old event"}',
    };
    if (post && occurrence) put("sourceOccurrences", child);
    return { asset, source, child };
  };
  const run = (numItems = 5, cutoffUpdatedAt = CUTOFF) => deleteOrphanedPage._handler(ctx, {
    cutoffUpdatedAt, paginationOpts: { cursor: null, numItems },
  });
  // A transactional mock stages writes for rollback tests. This is not a
  // substitute for the production Convex mutation/storage atomicity check.
  const transaction = async (handler) => {
    const before = structuredClone(tables);
    const previousStorageDeletes = storageDeleted.length;
    try { return await handler(); }
    catch (error) {
      tables.clear();
      for (const [key, value] of before) tables.set(key, value);
      storageDeleted.length = previousStorageDeletes;
      throw error;
    }
  };
  return { add, ctx, put, rows, run, storageDeleted, transaction };
}

try {
  {
    const f = fixture();
    const { asset, source, child } = f.add("retired");
    const outcome = await f.run();
    assert.equal(outcome.deletedAssetCount, 1);
    assert.equal(outcome.deletedStorageObjectCount, 1);
    assert.equal(outcome.detachedScrapedPostCount, 1);
    assert.deepEqual(f.storageDeleted, [asset.storageId]);
    assert.equal(f.rows("mediaAssets").size, 0);
    const { imageStorageId: _id, imageUrl: _url, ...preservedSource } = source;
    assert.deepEqual(f.rows("scrapedPosts").get(source._id), preservedSource);
    assert.deepEqual(f.rows("sourceOccurrences").get(child._id), child);
  }

  const protections = {
    pending: (f, x) => f.put("scrapedPosts", { ...x.source, processingStatus: "pending" }),
    processing: (f, x) => f.put("scrapedPosts", { ...x.source, processingStatus: "processing" }),
    retry: (f, x) => f.put("scrapedPosts", { ...x.source, processingStatus: "retryable_failure" }),
    lease: (f, x) => f.put("scrapedPosts", { ...x.source, processingLeaseExpiresAt: NOW + 1 }),
    paidFetch: (f, x) => f.put("scrapedPosts", { ...x.source, blocksPaidFetch: true }),
    changedAnalysis: (f, x) => f.put("scrapedPosts", { ...x.source, analysisRevision: 2 }),
    changedSource: (f, x) => f.put("scrapedPosts", { ...x.source, sourceRevision: 2, analysisRevision: 2 }),
    contradictoryPostIdentity: (f, x) => f.put("scrapedPosts", { ...x.source, canonicalSourceUrl: "https://www.instagram.com/p/OTHER/" }),
    contradictoryNormalizedPostIdentity: (f, x) => f.put("scrapedPosts", { ...x.source, normalizedInstagramPostUrl: "https://www.instagram.com/p/OTHER/" }),
    contradictoryAssetIdentity: (f, x) => f.put("mediaAssets", { ...x.asset, normalizedInstagramPostUrl: "https://www.instagram.com/p/OTHER/" }),
    unknownStatus: (f, x) => f.put("scrapedPosts", { ...x.source, processingStatus: undefined }),
    future: (f, x) => f.put("sourceOccurrences", { ...x.child, occurrenceDateKey: "2026-09-19" }),
    laterCutoffDay: (f, x) => f.put("sourceOccurrences", { ...x.child, occurrenceDateKey: "2026-09-15", occurrenceTimeIdentity: "23:00" }),
    unresolved: (f, x) => f.put("sourceOccurrences", { ...x.child, state: "expected" }),
    deferred: (f, x) => f.put("sourceOccurrences", { ...x.child, state: "deferred" }),
    canonicalRepresentative: (f, x) => f.put("sourceOccurrences", { ...x.child, canonicalEventId: "event-current" }),
    currentEventImage: (f, x) => f.put("events", { _id: "event-current", imageStorageId: x.asset.storageId }),
    currentEventSourceOnly: (f, x) => f.put("events", { _id: "event-current", canonicalSourceUrl: x.source.canonicalSourceUrl }),
    legacyReelEventSourceOnly: (f, x) => {
      f.rows("scrapedPosts").delete(x.source._id);
      f.put("events", { _id: "event-current", instagramPostUrl: `https://www.instagram.com/reel/${x.source.postId}/` });
    },
    legacyReelSourceLinkOnly: (f, x) => {
      f.rows("scrapedPosts").delete(x.source._id);
      f.put("instagramEventSources", { _id: "link-current", instagramPostUrl: `https://www.instagram.com/reel/${x.source.postId}/` });
    },
    expiredEventStillPresent: (f, x) => f.put("events", { _id: "event-old", date: "2026-09-01", instagramPostId: x.source.postId }),
    alternateSourceLink: (f, x) => f.put("instagramEventSources", { _id: "link-current", canonicalSourceUrl: x.source.canonicalSourceUrl }),
    missingPostWithLiveOccurrence: (f, x) => {
      f.rows("scrapedPosts").delete(x.source._id);
      f.put("sourceOccurrences", { ...x.child, state: "satisfied", canonicalEventId: "event-current" });
    },
    legacyUrlAliasWithMissingPost: (f, x) => {
      f.rows("scrapedPosts").delete(x.source._id);
      f.put("mediaAssets", {
        ...x.asset, canonicalSourceUrl: undefined,
        normalizedInstagramPostUrl: `https://m.instagram.com/reel/${x.source.postId}/?igsh=tracking`,
      });
      f.put("sourceOccurrences", { ...x.child, occurrenceDateKey: "2026-09-30", state: "expected" });
    },
    sharedPoster: (f, x) => f.put("scrapedPosts", { ...x.source, _id: "post-other", processingStatus: "processing" }),
    sourceProcessingBeforeAttachment: (f, x) => f.put("scrapedPosts", { ...x.source, imageStorageId: undefined, imageUrl: undefined, processingStatus: "processing" }),
    legacySourceProcessingBeforeAttachment: (f, x) => f.put("scrapedPosts", {
      ...x.source, imageStorageId: undefined, imageUrl: undefined, postId: "legacy-numeric-id",
      canonicalSourceUrl: undefined, normalizedInstagramPostUrl: undefined,
      instagramPostUrl: `https://www.instagram.com/reel/${x.source.postId}/`, processingStatus: "processing",
    }),
    mixedSchedule: (f, x) => f.put("sourceOccurrences", { ...x.child, _id: "occurrence-future", occurrenceDateKey: "2026-09-30", state: "expected" }),
    unknownDate: (f, x) => f.put("sourceOccurrences", { ...x.child, occurrenceDateKey: "unknown-date" }),
    ambiguousPostIdentity: (f, x) => {
      for (let i = 0; i < 26; i++) f.put("scrapedPosts", { ...x.source, _id: `extra-post-${i}` });
    },
    excessiveChildren: (f, x) => {
      for (let i = 0; i < 65; i++) f.put("sourceOccurrences", { ...x.child, _id: `extra-child-${i}` });
    },
  };
  for (const [name, protect] of Object.entries(protections)) {
    const f = fixture();
    const x = f.add(name);
    protect(f, x);
    const result = await f.run();
    assert.equal(result.deletedAssetCount, 0, name);
    assert.equal(result.detachedScrapedPostCount, 0, name);
    assert.deepEqual(f.storageDeleted, [], name);
    assert.equal(f.rows("mediaAssets").has(x.asset._id), true, name);
  }

  {
    const f = fixture();
    f.add("orphan", { post: false });
    f.add("unresolved", { occurrence: false });
    const x = f.add("nonEvent", { occurrence: false });
    f.put("scrapedPosts", { ...x.source, processingOutcome: "terminal_no_event", analysisIsEvent: false });
    f.add("recent", { post: false, assetUpdatedAt: CUTOFF + 1 });
    const result = await f.run();
    assert.equal(result.scannedAssetCount, 3);
    assert.equal(result.deletedStorageObjectCount, 2);
    assert.deepEqual([...f.rows("mediaAssets").keys()].sort(), ["asset-recent", "asset-unresolved"]);
  }

  const legacyReceipt = (source) => ({
    _id: "receipt-legacy", sourceIdentity: adaptInstagramScrapedPostToSourceDocument(source).sourceIdentity,
    sourceFingerprint: buildInstagramSourceOccurrenceFingerprint(source),
    expectedKeys: [], expectedOccurrences: [], satisfiedKeys: [], satisfiedOccurrences: [],
    deferredChildCount: 0, deferredChildKeys: [], createdAt: CUTOFF - 1000, updatedAt: CUTOFF - 1000,
  });
  {
    const f = fixture();
    const x = f.add("legacy-drained", { occurrence: false });
    const receipt = legacyReceipt(x.source);
    f.put("instagramSourceOccurrenceReceipts", receipt);
    assert.equal((await f.run()).deletedStorageObjectCount, 1);
    assert.deepEqual(f.rows("instagramSourceOccurrenceReceipts").get(receipt._id), receipt);
    assert.equal(f.rows("scrapedPosts").get(x.source._id).analysisResultJson, x.source.analysisResultJson);
    assert.equal(f.rows("scrapedPosts").get(x.source._id).imageStorageId, undefined);
  }
  const invalidLegacyReceipts = {
    missing: () => {},
    duplicate: (f, x, receipt) => {
      f.put("instagramSourceOccurrenceReceipts", receipt);
      f.put("instagramSourceOccurrenceReceipts", { ...receipt, _id: "receipt-duplicate" });
    },
    fingerprint: (f, x, receipt) => f.put("instagramSourceOccurrenceReceipts", { ...receipt, sourceFingerprint: "instagram-source-v2:stale" }),
    analysisRevision: (f, x, receipt) => {
      f.put("instagramSourceOccurrenceReceipts", receipt);
      f.put("scrapedPosts", { ...x.source, analysisRevision: undefined });
    },
    deferred: (f, x, receipt) => f.put("instagramSourceOccurrenceReceipts", { ...receipt, deferredChildCount: 1, deferredChildKeys: ["deferred"] }),
    expected: (f, x, receipt) => f.put("instagramSourceOccurrenceReceipts", {
      ...receipt, expectedKeys: ["unconsumed"],
      expectedOccurrences: [{ key: "unconsumed", date: "2026-09-01", venue: "Venue", title: "Event", artists: [] }],
    }),
    satisfied: (f, x, receipt) => f.put("instagramSourceOccurrenceReceipts", {
      ...receipt, satisfiedKeys: ["retained"], satisfiedOccurrences: [{ key: "retained", eventId: "retained-event" }],
      expectedKeys: ["retained"], expectedOccurrences: [{ key: "retained", date: "2026-09-01", venue: "Venue", title: "Event", artists: [] }],
    }),
    malformed: (f, x, receipt) => f.put("instagramSourceOccurrenceReceipts", { ...receipt, deferredChildCount: 1 }),
  };
  for (const [name, prepare] of Object.entries(invalidLegacyReceipts)) {
    const f = fixture();
    const x = f.add(`legacy-${name}`, { occurrence: false });
    prepare(f, x, legacyReceipt(x.source));
    assert.equal((await f.run()).deletedStorageObjectCount, 0, `${name} legacy receipt must preserve storage`);
    assert.deepEqual(f.storageDeleted, []);
    assert.equal(f.rows("mediaAssets").has(x.asset._id), true);
  }

  {
    const f = fixture();
    const a = f.add("shared-a", { post: false });
    const b = f.add("shared-b", { post: false });
    f.put("mediaAssets", { ...b.asset, storageId: a.asset.storageId });
    const result = await f.run();
    assert.equal(result.deletedAssetCount, 2);
    assert.equal(result.deletedStorageObjectCount, 1);
    assert.deepEqual(f.storageDeleted, [a.asset.storageId]);
  }

  {
    const f = fixture();
    const a = f.add("shared-orphan", { post: false });
    const b = f.add("shared-public", { post: false });
    f.put("mediaAssets", { ...b.asset, storageId: a.asset.storageId });
    f.put("events", { _id: "public-event", instagramPostId: b.asset.instagramPostId });
    const result = await f.run();
    assert.equal(result.deletedAssetCount, 1);
    assert.equal(result.deletedStorageObjectCount, 0);
    assert.equal(f.rows("mediaAssets").has(b.asset._id), true);
    assert.deepEqual(f.storageDeleted, []);
  }

  {
    const f = fixture();
    const x = f.add("at-cutoff");
    f.put("sourceOccurrences", {
      ...x.child, occurrenceDateKey: "2026-09-15", occurrenceTimeIdentity: "18:00",
    });
    assert.equal((await f.run()).deletedStorageObjectCount, 1);
  }

  {
    const f = fixture();
    f.add("a-retained", { occurrence: false });
    f.add("b-retired");
    f.add("c-newer", { post: false, assetUpdatedAt: CUTOFF + 1 });
    const first = await f.run(1);
    assert.equal(first.isDone, false);
    assert.equal(first.deletedAssetCount, 0);
    assert.equal(f.rows("mediaAssetRetentionCursors").size, 1);
    // Simulate the next cron starting with no caller cursor and a later cutoff.
    const resumed = await f.run(1, NOW);
    assert.equal(resumed.cutoffUpdatedAt, CUTOFF);
    assert.equal(resumed.deletedAssetCount, 1);
    assert.equal(resumed.isDone, true);
    assert.equal(f.rows("mediaAssetRetentionCursors").size, 0);
    assert.equal(f.rows("mediaAssets").has("asset-c-newer"), true);
    const nextPass = await f.run(5, NOW);
    assert.equal(nextPass.cutoffUpdatedAt, NOW);
    assert.equal(nextPass.deletedAssetCount, 1);
  }

  {
    const f = fixture();
    f.add("a-retained", { occurrence: false });
    const x = f.add("b-retired");
    await f.run(1);
    const cursorBefore = structuredClone([...f.rows("mediaAssetRetentionCursors").values()]);
    const realDelete = f.ctx.storage.delete;
    f.ctx.storage.delete = async () => { throw new Error("SIMULATED_STORAGE_DELETE_FAILURE"); };
    await assert.rejects(f.transaction(() => f.run(1)), /SIMULATED_STORAGE_DELETE_FAILURE/);
    assert.deepEqual([...f.rows("mediaAssetRetentionCursors").values()], cursorBefore);
    assert.deepEqual(f.rows("scrapedPosts").get(x.source._id), x.source);
    assert.equal(f.rows("mediaAssets").has(x.asset._id), true);
    f.ctx.storage.delete = realDelete;
    const retry = await f.transaction(() => f.run(1));
    assert.equal(retry.deletedStorageObjectCount, 1);
    assert.equal(retry.isDone, true);
    assert.deepEqual(f.storageDeleted, [x.asset.storageId]);
  }

  for (const status of ["pending", "processing", "retryable_failure"]) {
    const f = fixture();
    const x = f.add(`old-${status}`, { occurrence: false });
    f.put("scrapedPosts", { ...x.source, processingStatus: status });
    const result = await deleteOlderThan._handler(f.ctx, { cutoffUpdatedAt: CUTOFF, limit: 5 });
    assert.equal(result.deletedCount, 0, `${status} source must not be lost at 90 days`);
  }
  for (const field of ["instagramPostId", "instagramPostUrl", "canonicalSourceUrl", "normalizedInstagramPostUrl"]) {
    const f = fixture();
    const x = f.add(`legacy-${field}`, { occurrence: false });
    f.put("events", {
      _id: "legacy-event", date: "2026-09-30",
      [field]: field === "instagramPostId" ? x.source.postId : x.source.instagramPostUrl,
    });
    const result = await deleteOlderThan._handler(f.ctx, { cutoffUpdatedAt: CUTOFF, limit: 5 });
    assert.equal(result.deletedCount, 0, `Legacy event's ${field} source must survive`);
    assert.equal(f.rows("scrapedPosts").has(x.source._id), true);
  }
  for (const table of ["events", "instagramEventSources"]) {
    const f = fixture();
    const x = f.add(`alias-${table}`, { occurrence: false });
    f.put(table, { _id: "legacy-reference", instagramPostUrl: `https://www.instagram.com/reel/${x.source.postId}/` });
    const result = await deleteOlderThan._handler(f.ctx, { cutoffUpdatedAt: CUTOFF, limit: 5 });
    assert.equal(result.deletedCount, 0, `${table} source URL alias must protect its source`);
    assert.equal(f.rows("scrapedPosts").has(x.source._id), true);
  }
  {
    const f = fixture();
    const x = f.add("contradictory-normalized-source", { occurrence: false });
    f.put("scrapedPosts", { ...x.source, normalizedInstagramPostUrl: "https://www.instagram.com/p/OTHER/" });
    const result = await deleteOlderThan._handler(f.ctx, { cutoffUpdatedAt: CUTOFF, limit: 5 });
    assert.equal(result.deletedCount, 0, "Contradictory normalized identity must not be deleted");
  }
} finally {
  Date.now = realNow;
}

console.log("Media retention QA passed: retired files deleted, provenance and live/shared/retry evidence preserved, durable pagination resumes.");
