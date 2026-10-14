import assert from "node:assert/strict";
import "../convex/events.ts";
import { parseExtractedEventData } from "../lib/ai/extract-event-data.ts";
import { CAROUSEL_EVENT_EXTRACTION_ANALYSIS_PROTOCOL } from "../lib/ai/openai-analysis-protocol.ts";
import { processIngestionPost } from "../lib/pipeline/ingestion/post-processor.ts";
import { createEmptyHandleSummary } from "../lib/pipeline/ingestion/reporting.ts";

const urls = [0, 1].map((index) => `https://images.apifyusercontent.com/pipeline-${index}.jpg`);
const post = { username: "qa_carousel", postId: "qa-pipeline-carousel", caption: "A venue recap.", altText: null,
  postType: "Sidecar", postedAt: "2026-10-01T12:00:00.000Z", locationName: null,
  instagramPostUrl: "https://www.instagram.com/p/qa_pipeline_carousel/", imageUrl: urls[0], imageUrls: urls,
  imageSlides: urls.map((url, index) => ({ index, imageUrls: [url], mediaType: "image" })), imageSlideCount: 2 };
function noEvent(options) {
  const date = { exact_text: "", source: "unknown", is_relative: false, resolved_date: "", slide_index: null };
  const time = { exact_text: "", source: "unknown", status: "not_stated", slide_index: null };
  const shared = { applies_to_all: false, value: "", evidence: "", source: "unknown", slide_index: null };
  return parseExtractedEventData({ extraction_contract_version: "event_evidence_v2", is_event: false,
    non_event_reason: "Past venue recap.", title: "", date: "", time: "", venue: "", city: "", country: "",
    price: "", currency: "", artists: [], category: "", description: "", confidence: 0,
    reasoning_notes: "", source_caption: post.caption, source_url: post.instagramPostUrl,
    date_evidence: date, time_evidence: time, source_conflicts: [], schedule_entries: [],
    shared_schedule_context: { venue: shared, time: shared },
    field_confirmation: Object.fromEntries(["title", "location", "location_name", "price", "start_time", "short_description", "artists"]
      .map((field) => [field, { confidence: 0, found_in: [], evidence: "", evidence_snippets: [], notes: "" }])),
    _extractionPolicyVersion: "event_quality_v1", _carouselContractVersion: "carousel_evidence_v1",
    _carouselMedia: { version: 1, knownSlideCount: options.carouselKnownSlideCount, images: options.carouselImages },
    _imageCoverage: options.imageCoverage, _openaiUsage: { model: "gpt-6-luna" } });
}
async function run({ cached, unavailableSlide } = {}) {
  const retained = [];
  let downloads = 0, transports = 0, partial = false, recorded;
  const summary = createEmptyHandleSummary(post.username);
  const client = {
    query: async (name) => name === "events:getInstagramSourceOccurrenceReceipt" ? null : [],
    action: async (name, args) => {
      assert.equal(name, "mediaActions:persistInstagramCarouselImage");
      retained.push(args.slideIndex);
      return { slideIndex: args.slideIndex, checksumSha256: args.expectedChecksumSha256,
        assetId: `asset-${args.slideIndex}`, storageId: `storage-${args.slideIndex}`, url: `https://stored.test/${args.slideIndex}` };
    },
    mutation: async (name, args) => {
      if (name === "scrapedPosts:markOpenAiAnalysisAttemptStarted") {
        assert.equal(args.protocol, CAROUSEL_EVENT_EXTRACTION_ANALYSIS_PROTOCOL);
        assert.equal(retained.length, unavailableSlide === undefined ? 2 : 1);
        return { recorded: true };
      }
      if (name === "scrapedPosts:recordOpenAiAnalysis") {
        recorded = args;
        assert.equal(args.carouselImages.length, retained.length);
        assert.deepEqual(JSON.parse(args.resultJson)._carouselMedia.images.map((image) => image.slideIndex), retained.sort());
        return { recorded: true };
      }
      assert.equal(name, "reconciliationIngress:reconcileIngestionPlan", "Non-events must never mutate event records.");
      return { authority: "legacy", outcomes: [] };
    },
  };
  await processIngestionPost({ client, post, handle: post.username, summary,
    requireCachedAnalysisOnly: cached !== undefined,
    canonicalVenueNamesByHandle: {}, venueNameOverridesByHandle: {}, configuredVenueNamesByHandle: {}, serviceSecret: "qa-secret",
    processingFence: { handle: post.username, scrapedPostId: "qa-source", postId: post.postId,
      instagramPostUrl: post.instagramPostUrl, owner: "qa-owner", sourceRevision: 1 },
    onSourceCoveragePartial: () => { partial = true; },
    ...(cached ? { cachedAnalysisJson: cached.resultJson, cachedAnalysisContractVersion: "event_evidence_v2",
      cachedAnalysisImageSourceUrl: cached.imageSourceUrl, cachedAnalysisImageChecksumSha256: cached.imageChecksumSha256 } : {}),
    providerExecution: { claim: async () => ({ claimed: true }), release: async () => {}, block: async () => { throw new Error("No provider block expected."); } },
  }, {
    downloadImage: async (url) => {
      downloads += 1;
      assert.equal(cached, undefined, "Cached retries must not download image inputs.");
      if (url === urls[unavailableSlide]) throw new Error("Unavailable sibling.");
      return { imageBuffer: Buffer.from(`original-${url}`), contentType: "image/jpeg", sourceUrl: url };
    },
    normalizeToJpeg: async (bytes) => ({ imageBuffer: bytes, mimeType: "image/jpeg", wasConverted: false }),
    extractEventDataFromPost: async (options) => {
      assert.equal(cached, undefined, "Cached retries must not call a provider.");
      assert.equal(options.imageDataUrls.length, retained.length);
      assert.equal(options.carouselImages.length, retained.length);
      assert.equal(options.carouselKnownSlideCount, 2);
      await options.beforeTransport(); options.onTransportStarted(); transports += 1;
      return noEvent(options);
    },
  });
  return { downloads, transports, partial, recorded, summary };
}
const originalInfo = console.info, originalError = console.error;
console.info = () => {}; console.error = () => {};
try {
  const full = await run();
  assert.equal(full.downloads, 2); assert.equal(full.transports, 1); assert.equal(full.partial, false);
  assert.equal(full.summary.insertedEvents, 0); assert.equal(JSON.parse(full.recorded.resultJson)._imageCoverage.complete, true);
  const replay = await run({ cached: full.recorded });
  assert.equal(replay.downloads, 0); assert.equal(replay.transports, 0); assert.equal(replay.recorded, undefined);
  assert.equal(replay.summary.insertedEvents, 0);
  const partial = await run({ unavailableSlide: 1 });
  assert.equal(partial.transports, 1); assert.equal(partial.partial, true);
  assert.equal(JSON.parse(partial.recorded.resultJson)._imageCoverage.complete, false);
  assert.deepEqual(partial.recorded.carouselImages.map((image) => image.slideIndex), [0]);
} finally { console.info = originalInfo; console.error = originalError; }
console.log("Carousel pipeline QA passed: independently retained slides precede one extraction transport, exact durable bundle, partial-source truth, zero-transport cached retries and no event writes for recaps.");
{
  const previousInfo = console.info, previousError = console.error; console.info = () => {}; console.error = () => {};
  try {
    for (const cachedOptions of [{}, { cachedAnalysisJson: "{", cachedAnalysisContractVersion: "event_evidence_v2" },
      { cachedAnalysisJson: JSON.stringify({ extraction_contract_version: "event_evidence_v2", is_event: true }), cachedAnalysisContractVersion: "event_evidence_v2" },
      { cachedAnalysisJson: "{}", cachedAnalysisContractVersion: "event_evidence_v1" }]) {
      let providerCalls = 0, dataCalls = 0;
      const rejectProvider = async () => { providerCalls++; throw new Error("No provider call is authorized for cached-only recovery."); };
      const rejectData = async () => { dataCalls++; throw new Error("Invalid cache must fail before data access."); };
      const summary = createEmptyHandleSummary(post.username);
      await assert.rejects(() => processIngestionPost({ client: { query: rejectData, action: rejectData, mutation: rejectData }, post, handle: post.username,
        summary, canonicalVenueNamesByHandle: {}, venueNameOverridesByHandle: {}, configuredVenueNamesByHandle: {}, serviceSecret: "qa-secret",
        requireCachedAnalysisOnly: true, ...cachedOptions }, { downloadImage: rejectProvider, normalizeToJpeg: rejectProvider, extractEventDataFromPost: rejectProvider }),
        /valid current cached analysis; fresh extraction is disabled/u);
      assert.equal(providerCalls, 0); assert.equal(dataCalls, 0); assert.equal(summary.insertedEvents, 0);
    }
  } finally { console.info = previousInfo; console.error = previousError; }
}
console.log("Cached-only rejection QA passed.");
