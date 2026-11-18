import assert from "node:assert/strict";
import { upsertManyByHandle } from "../convex/scrapedPosts.ts";
import { persistScrapedPostsForHandle } from "../lib/pipeline/ingestion/source-documents.ts";
import { fetchInstagramSourceDocuments, projectInstagramSourceDocumentForCompatibilityParser } from "../lib/pipeline/ingestion/source-provider.ts";

const originalSecret = process.env.CRON_SECRET;
const originalFetch = globalThis.fetch;
process.env.CRON_SECRET = "qa-instaloader-cache-secret";
globalThis.fetch = async () => { throw new Error("Source-cache QA must not call any live service."); };

const asset = (index, revision) => `https://scontent.cdninstagram.com/v/t51.82787-15/${123456 + index}_987654_246810_n.jpg?ig_cache_key=media-${index}&signature=${revision}`;
const bareAlt = "Photo by Fixture Gallery on October 04, 2026.";
const enrichedAlt = "Photo shared by Fixture Gallery on October 04, 2026 tagging @fixture_one, and @fixture_two. May be an image of poster and text.";
const oldSlides = [0, 1].map(index => ({ index, mediaType: "image", imageUrls: [asset(index, "old")] }));
const newSlides = [0, 1].map(index => ({ index, mediaType: "image", imageUrls: [asset(index, "new"), asset(index, "new-hd")] }));
const post = {
  handle: "qa_venue", username: "qa_venue", postId: "qa_source_cache",
  instagramPostUrl: "https://www.instagram.com/p/qa_source_cache/",
  caption: "Saturday 17 October: Fixture Party.", altText: enrichedAlt,
  postedAt: "2026-10-04T12:00:00.000Z", postType: "Sidecar", locationName: "QA Venue",
  imageUrl: asset(0, "new"), imageUrls: newSlides.map(slide => slide.imageUrls[0]),
  imageSlides: newSlides, imageSlideCount: 2, metadataProvider: "instaloader",
};

function state(patch = {}, existing = true) {
  const cache = JSON.stringify({ extraction_contract_version: "event_evidence_v2", _extractionPolicyVersion: "event_quality_v1",
    _carouselContractVersion: "carousel_evidence_v1", _carouselMedia: { version: 1, knownSlideCount: 2,
      images: oldSlides.map(slide => ({ slideIndex: slide.index, sourceUrl: slide.imageUrls[0], checksumSha256: "a".repeat(64) })) } });
  const source = { ...post, _id: "qa-saved-source", altText: bareAlt, imageSlides: oldSlides,
    imageUrls: oldSlides.map(slide => slide.imageUrls[0]), imageUrl: "https://stored.test/retained.jpg", imageStorageId: "qa-storage",
    sourceRevision: 4, analysisRevision: 4, analysisContractVersion: "event_evidence_v2", analysisResultJson: cache,
    analysisImageSourceUrl: oldSlides[0].imageUrls[0], analysisImageChecksumSha256: "a".repeat(64),
    processingStatus: "completed", processingOutcome: "receipt_complete", createdAt: 1, updatedAt: 1, ...patch };
  delete source.metadataProvider;
  let current = existing ? source : null;
  let eventReads = 0;
  const ctx = {
    auth: { getUserIdentity: async () => null },
    db: {
      get: async id => current?._id === id ? current : null,
      query: table => {
        const predicates = [];
        const query = {
          withIndex: (_name, build) => { const cursor = { eq: (key, value) => { predicates.push([key, value]); return cursor; } }; build(cursor); return query; },
          unique: async () => { assert.equal(table, "instagramPaidFetchControl"); return null; },
          take: async () => {
            if (table === "scrapedPosts") return current && predicates.every(([key, value]) => current[key] === value) ? [current] : [];
            eventReads += 1;
            return [];
          },
        };
        return query;
      },
      patch: async (id, fields) => {
        assert.equal(id, current._id, "The guard must only patch its source document.");
        assert.equal(Object.hasOwn(fields, "metadataProvider"), false, "Acquisition provenance must not be written into the data model.");
        for (const [key, value] of Object.entries(fields)) if (value === undefined) delete current[key]; else current[key] = value;
      },
      insert: async (table, fields) => {
        assert.equal(table, "scrapedPosts");
        assert.equal(Object.hasOwn(fields, "metadataProvider"), false);
        current = { ...fields, _id: "qa-new-source" }; return current._id;
      },
    },
  };
  return { ctx, source, cache, get: () => current, eventReads: () => eventReads };
}

async function apply(s, changes = {}) {
  return upsertManyByHandle._handler(s.ctx, { handle: post.handle, posts: [{ ...post, ...changes }], serviceSecret: process.env.CRON_SECRET });
}

try {
  const batch = await fetchInstagramSourceDocuments({ handle: post.handle }, { fetchProviderRows: async () => [post], now: () => 1 });
  const projected = projectInstagramSourceDocumentForCompatibilityParser(batch.documents[0]);
  assert.equal(projected.metadataProvider, "instaloader", "Provider provenance must survive the generic source boundary.");
  assert.equal(projected.altText, enrichedAlt, "Never strip or rewrite incoming raw accessibility evidence.");
  let captured;
  await persistScrapedPostsForHandle({ mutation: async (_name, args) => { captured = args.posts[0]; return []; } }, post.handle, [projected], process.env.CRON_SECRET);
  assert.equal(captured.metadataProvider, "instaloader");
  assert.equal(captured.altText, enrichedAlt);

  const s = state();
  await apply(s);
  assert.equal(s.get().sourceRevision, 4);
  assert.equal(s.get().analysisResultJson, s.cache, "Keep the exact independently attested analysis bytes.");
  assert.equal(s.get().analysisRevision, 4);
  assert.equal(s.get().altText, bareAlt);
  assert.equal(s.get().processingStatus, "completed");
  assert.equal(s.get().imageStorageId, "qa-storage");
  assert.equal(s.eventReads(), 0, "Inert enrichment must not invalidate events or their references.");

  for (const changes of [
    { metadataProvider: undefined },
    { altText: "Doors at 22:00. Tickets at the venue." },
    { caption: "Sunday 18 October: Rescheduled Fixture Party." },
    { locationName: "New Venue" },
    { postedAt: "2026-10-05T12:00:00.000Z" },
    { imageSlides: [newSlides[1], newSlides[0]].map((slide, index) => ({ ...slide, index })) },
    { imageSlides: [newSlides[0]], imageSlideCount: 1 },
    { imageSlides: newSlides.map(slide => ({ ...slide, imageUrls: [asset(slide.index + 2, "changed")] })) },
  ]) {
    const changed = state(); await apply(changed, changes);
    assert.equal(changed.get().sourceRevision, 5, "Unknown/custom/meaningful changes retain normal revision invalidation.");
    assert.equal(changed.get().analysisResultJson, undefined);
  }
  const incomplete = state({ processingStatus: "pending" }); await apply(incomplete);
  assert.equal(incomplete.get().sourceRevision, 5);
  const fresh = state({}, false); await apply(fresh);
  assert.equal(fresh.get().altText, enrichedAlt, "New sources must retain their complete accessibility evidence.");
  assert.equal(fresh.get().sourceRevision, 1);
  console.log("Instaloader source-cache QA passed (atomic compatibility, provenance, immutable cache, genuine-edit invalidation and no live calls).");
} finally {
  if (originalSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = originalSecret;
  globalThis.fetch = originalFetch;
}
