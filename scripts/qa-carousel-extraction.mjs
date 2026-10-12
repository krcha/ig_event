import assert from "node:assert/strict";
import "../convex/events.ts";
import { extractEventDataFromInstagramPost, parseExtractedEventData } from "../lib/ai/extract-event-data.ts";
import { parseCarouselMediaBinding } from "../lib/ai/carousel-media-contract.ts";
import { bindSourceOccurrenceMetadata, prepareEventsForInsert } from "../lib/pipeline/run-instagram-ingestion.ts";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const IMAGES = [0, 1, 2].map((slideIndex) => ({ slideIndex,
  sourceUrl: `https://example.com/qa-carousel-${slideIndex}.jpg`, checksumSha256: String(slideIndex + 1).repeat(64) }));
const emptyDate = { exact_text: "", source: "unknown", is_relative: false, resolved_date: "", slide_index: null };
const emptyTime = { status: "not_stated", exact_text: "", source: "unknown", slide_index: null };
const emptyContext = { applies_to_all: false, value: "", evidence: "", source: "unknown", slide_index: null };
function post(caption = "") {
  return { username: "qa_carousel_venue", handle: "qa_carousel_venue", postId: "qa_carousel",
    instagramPostUrl: "https://www.instagram.com/p/qa_carousel/", postedAt: "2026-09-30T12:00:00.000Z",
    caption, altText: null, locationName: null, postType: "Sidecar", imageUrl: IMAGES[0].sourceUrl,
    imageUrls: IMAGES.map((image) => image.sourceUrl),
    imageSlides: IMAGES.map((image) => ({ index: image.slideIndex, imageUrls: [image.sourceUrl] })), imageSlideCount: 3 };
}
function row({ title, date = "2026-10-17", dateText = "17.10.2026", time = "22:00", artists = [],
  venue = "QA Venue", slide = 0, slides = [slide], sourceText, posterEvidence, description = "", price = "",
  category = "nightlife", source = "poster", textEvidence = [], conflicts = [] }) {
  const quote = sourceText ?? `${dateText} ${title} ${artists.join(" ")} ${time}`;
  return { title, date, time, venue, artists, description, source_text: quote,
    date_evidence: { exact_text: dateText, source, is_relative: false, resolved_date: date,
      slide_index: source === "poster" ? slide : null },
    time_evidence: time ? { status: "start_time_stated", exact_text: time, source,
      slide_index: source === "poster" ? slide : null } : emptyTime,
    source_slide_indexes: slides, poster_evidence: posterEvidence ?? (source === "poster" ? [{ slide_index: slide, text: quote }] : []),
    text_evidence: textEvidence, source_conflicts: conflicts, category, price, currency: price ? "RSD" : "" };
}
function extraction(rows, images = IMAGES, knownSlideCount = 3) {
  return parseExtractedEventData({ extraction_contract_version: "event_evidence_v2",
    _extractionPolicyVersion: "event_quality_v1", _carouselContractVersion: "carousel_evidence_v1",
    _carouselMedia: { version: 1, knownSlideCount, images },
    is_event: true, non_event_reason: "", title: "", date: "", time: "", venue: "", city: "Belgrade",
    country: "Serbia", price: "", currency: "", artists: [], category: "nightlife", description: "",
    confidence: 0.4, reasoning_notes: "Human-labelled regression response.", source_caption: "", source_url: "",
    date_evidence: emptyDate, time_evidence: emptyTime, source_conflicts: [],
    shared_schedule_context: { venue: emptyContext, time: emptyContext }, schedule_entries: rows,
    field_confirmation: Object.fromEntries(["title", "location", "location_name", "price", "start_time", "short_description", "artists"]
      .map((field) => [field, { confidence: 0, found_in: [], evidence: "", evidence_snippets: [], notes: "" }])) });
}
function prepare(rows, sourcePost = post(), images = IMAGES, knownSlideCount = 3) {
  const data = extraction(rows, images, knownSlideCount);
  const raw = JSON.stringify(data, null, 2);
  const result = prepareEventsForInsert(sourcePost, data, images[0].sourceUrl,
    { qa_carousel_venue: "QA Venue" }, {}, { qa_carousel_venue: "QA Venue" }, {
      eventDateFilterNow: NOW, sourceRolesByHandle: { qa_carousel_venue: "venue" }, rawExtractionJson: raw,
    });
  return { data, raw, results: bindSourceOccurrenceMetadata(sourcePost, result) };
}
function events(result) { return result.results.filter((entry) => entry.kind === "ok").map((entry) => entry.event); }
function assertApproved(result, count) {
  assert.equal(events(result).length, count, JSON.stringify(events(result).map((event) => ({ title: event.title,
    artists: event.artists, time: event.time, status: event.status }))));
  assert.ok(events(result).every((event) => event.status === "approved"), JSON.stringify(result.results.map((entry) => ({
    title: entry.event?.title, status: entry.event?.status, reasons: entry.normalizedFields.moderationPendingReasons,
    date: entry.normalizedFields.dateEvidenceVerified, time: entry.normalizedFields.timeEvidenceVerified,
    identity: entry.normalizedFields.identityEvidenceVerified,
  }))));
}

const repeated = prepare([
  row({ title: "Joint Party", artists: ["DJ One"], slide: 0 }),
  row({ title: "Joint Party", artists: ["DJ Two"], slide: 1 }),
]);
assertApproved(repeated, 1);
assert.deepEqual(events(repeated)[0].artists, ["DJ One", "DJ Two"]);
assert.deepEqual(repeated.results[0].normalizedFields.carouselSourceSlideIndexes, [0, 1]);
assert.deepEqual(repeated.results[0].normalizedFields.carouselSourceRowIndexes, [0, 1]);
assert.equal(events(repeated)[0].rawExtractionJson, repeated.raw, "Deduplication must retain exact original response bytes.");

const complementary = prepare([row({ title: "Joint Party", artists: ["DJ One", "DJ Two"], slides: [0, 1],
  sourceText: "17.10.2026 Joint Party 22:00", posterEvidence: [
    { slide_index: 0, text: "17.10.2026 Joint Party 22:00" }, { slide_index: 1, text: "Joint Party LINEUP DJ One DJ Two" },
  ] })]);
assertApproved(complementary, 1);
assert.deepEqual(events(complementary)[0].artists, ["DJ One", "DJ Two"], "A detailed lineup slide must complement its party cover.");

const offsiteVenue = prepare([row({ title: "Double Dose", venue: "UMAMI Gastrošor", sourceText: "17.10.2026 Double Dose 22:00",
  posterEvidence: [{ slide_index: 0, text: "17.10.2026 Double Dose 22:00" },
    { slide_index: 0, text: "UMAMI • GASTROŠOR" }] })]);
assertApproved(offsiteVenue, 1);
assert.equal(events(offsiteVenue)[0].venue, "UMAMI Gastrošor", "Exact row venue evidence must survive source-account fallback.");
const unboundOffsiteVenue = prepare([row({ title: "Offsite Programme", venue: "Zaokret" })]);
assert.equal(events(unboundOffsiteVenue)[0].venue, "Zaokret", "An explicit different venue must not become the posting account's venue.");
assert.equal(events(unboundOffsiteVenue)[0].status, "pending");
assert.ok(unboundOffsiteVenue.results[0].normalizedFields.moderationPendingReasons.includes("invalid_venue_evidence"));

assertApproved(prepare([row({ title: "5. rođendan Stvaralačkog Eha", category: "event",
  sourceText: "17.10.2026 QA Venue 22:00", posterEvidence: [
    { slide_index: 0, text: "17.10.2026 QA Venue 22:00" }, { slide_index: 0, text: "5. RODENDAN Stvaralačkog Eha" },
  ] })]), 1);
assertApproved(prepare([row({ title: "Band One, Band Two, Band Three", artists: ["Band One", "Band Two", "Band Three"],
  category: "live music", sourceText: "17.10.2026 Band One LIVE Band Two LIVE Band Three LIVE 22:00" })]), 1);

const independent = prepare([
  row({ title: "Friday Party", date: "2026-10-16", dateText: "16.10.2026", artists: ["DJ Friday"], price: "500", slide: 0 }),
  row({ title: "Sunday Workshop", date: "2026-10-18", dateText: "18.10.2026", time: "13:00",
    artists: ["Tutor Two"], category: "learning", slide: 1 }),
]);
assertApproved(independent, 2);
assert.deepEqual(events(independent).map((event) => [event.title, event.date, event.time, event.artists, event.ticketPrice ?? ""]), [
  ["Friday Party", "2026-10-16", "22:00", ["DJ Friday"], "500 RSD"],
  ["Sunday Workshop", "2026-10-18", "13:00", ["Tutor Two"], ""],
]);
assert.deepEqual(events(independent).map((event) => event.eventType), ["nightlife", "learning"]);

const sessions = prepare(["13:00", "17:00", "18:00"].map((time, slide) => row({
  title: "Museum Programme", artists: ["Guide"], date: "2026-10-11", dateText: "11.10.2026", time,
  category: "arts & culture", slide,
})));
assertApproved(sessions, 3);
assert.equal(new Set(events(sessions).map((event) => event.sourceOccurrenceKey)).size, 3);

const monthlyRow = (overrides = {}) => row({ title: "VUK MIROVIĆ", artists: ["VUK MIROVIĆ"],
  date: "2026-10-07", dateText: "07", time: "", sourceText: "07 VUK MIROVIĆ",
  posterEvidence: [{ slide_index: 0, text: "07 VUK MIROVIĆ" }, { slide_index: 0, text: "OKTOBAR" }],
  ...overrides });
assertApproved(prepare([monthlyRow()]), 1);
for (const invalidMonthRow of [
  monthlyRow({ slides: [0, 1], posterEvidence: [{ slide_index: 0, text: "07 VUK MIROVIĆ" },
    { slide_index: 1, text: "OKTOBAR" }] }),
  monthlyRow({ posterEvidence: [{ slide_index: 0, text: "07 VUK MIROVIĆ" }, { slide_index: 0, text: "NOVEMBAR" }] }),
  monthlyRow({ posterEvidence: [{ slide_index: 0, text: "07 VUK MIROVIĆ" }, { slide_index: 0, text: "OKTOBAR" },
    { slide_index: 0, text: "NOVEMBAR" }] }),
  monthlyRow({ sourceText: "Thursday 07 VUK MIROVIĆ" }),
]) {
  const held = prepare([invalidMonthRow]);
  assert.equal(events(held)[0].status, "pending", "A month heading cannot override source scope or an attached weekday.");
  assert.ok(held.results[0].normalizedFields.moderationPendingReasons.includes("invalid_date_evidence"));
}

const roomPrograms = prepare([
  row({ title: "DJ One", artists: ["DJ One"], slide: 0, description: "Upstairs independent programme.",
    sourceText: "17.10.2026 Upstairs DJ One 22:00" }),
  row({ title: "DJ Two", artists: ["DJ Two"], slide: 0, description: "Downstairs independent programme.",
    sourceText: "17.10.2026 Downstairs DJ Two 22:00" }),
]);
assert.equal(events(roomPrograms).length, 2, "Independent named room programmes must not be merged.");
assert.ok(events(roomPrograms).every((event) => event.status === "pending"),
  "Same-venue same-start rooms retain the existing conservative occurrence collision policy.");

const perDj = prepare([
  row({ title: "DJ One", artists: ["DJ One"], slide: 0 }),
  row({ title: "DJ Two", artists: ["DJ Two"], slide: 0 }),
]);
assert.equal(events(perDj).length, 2);
assert.ok(events(perDj).every((event) => event.status === "pending"),
  "Unresolved same-start per-DJ splits must not publish separate events without explicit shared-program proof.");

const conflicts = prepare([
  row({ title: "Conflicting Party", slide: 0, conflicts: [{ field: "date", poster_value: "17.10.2026",
    caption_value: "18.10.2026", reason: "Same event has contradictory dates." }] }),
  row({ title: "Unrelated Workshop", slide: 1, date: "2026-10-19", dateText: "19.10.2026", category: "learning" }),
]);
assert.deepEqual(events(conflicts).map((event) => event.status), ["pending", "approved"],
  "A conflict on one flyer must not block another independent occurrence.");

const scopedCaption = post("17.10.2026 Joint Party 22:00 DJ One\n18.10.2026 Cancelled Party DJ Two");
const caption = prepare([row({ title: "Joint Party", artists: ["DJ One"], source: "caption", slides: [],
  sourceText: "17.10.2026 Joint Party 22:00 DJ One", textEvidence: [{ source: "caption", text: "17.10.2026 Joint Party 22:00 DJ One" }] })], scopedCaption);
assertApproved(caption, 1);
assert.equal(events(caption)[0].sourceCaption, scopedCaption.caption, "Persisted source captions must remain complete and original.");
assert.deepEqual(caption.results[0].normalizedFields.carouselSourceSlideIndexes, []);
assert.equal(caption.results[0].normalizedFields.carouselDisplaySlideIndex, 0, "Caption facts may use the retained cover only for presentation.");

const borrowedArtist = prepare([row({ title: "Joint Party", artists: ["DJ Two"], source: "caption", slides: [],
  sourceText: "17.10.2026 Joint Party 22:00 DJ One", textEvidence: [{ source: "caption", text: "17.10.2026 Joint Party 22:00 DJ One" }] })], scopedCaption);
assert.ok(events(borrowedArtist).every((event) => event.status === "pending"),
  "A sibling caption act cannot make an ungrounded row publishable.");
assert.ok(borrowedArtist.results[0].normalizedFields.moderationPendingReasons.includes("invalid_identity_evidence"));

const fabricatedQuote = prepare([row({ title: "Joint Party", textEvidence: [{ source: "caption", text: "Invented support quote" }] })], scopedCaption);
assert.equal(events(fabricatedQuote)[0].status, "pending");
assert.ok(fabricatedQuote.results[0].normalizedFields.moderationPendingReasons.includes("carousel_unbound_text_evidence"));

const credits = prepare([row({ title: "Joint Party", artists: ["Photographer One"],
  sourceText: "17.10.2026 Joint Party 22:00", posterEvidence: [
    { slide_index: 0, text: "17.10.2026 Joint Party 22:00" },
    { slide_index: 0, text: "Photography by Photographer One" },
  ] })]);
assert.equal(events(credits)[0].status, "pending", "A photographic credit must not prove a billed performer.");
assert.ok(credits.results[0].normalizedFields.moderationPendingReasons.includes("carousel_unbilled_artist_evidence"));
const creditInRow = prepare([row({ title: "Joint Party", artists: ["Sponsor One"],
  sourceText: "17.10.2026 Joint Party 22:00 Sponsored by Sponsor One" })]);
assert.equal(events(creditInRow)[0].status, "pending", "A credit inside source_text must not bypass the performer guard.");
assert.ok(creditInRow.results[0].normalizedFields.moderationPendingReasons.includes("carousel_unbilled_artist_evidence"));
const billedAndCredited = prepare([row({ title: "Joint Party", artists: ["DJ One"],
  sourceText: "17.10.2026 Joint Party 22:00", posterEvidence: [
    { slide_index: 0, text: "17.10.2026 Joint Party 22:00" },
    { slide_index: 0, text: "LINEUP DJ One" },
    { slide_index: 0, text: "Photography by DJ One" },
  ] })]);
assertApproved(billedAndCredited, 1);

const partial = prepare([row({ title: "Only Submitted Flyer", slide: 2 })], post(), [IMAGES[2]], 5);
assertApproved(partial, 1);
assert.deepEqual(partial.results[0].normalizedFields.carouselSourceSlideIndexes, [2]);
assert.equal(partial.results[0].normalizedFields.carouselDisplaySlideIndex, 2);

const invalidReference = extraction([row({ title: "Valid" })]);
invalidReference.schedule_entries[0].date_evidence.slide_index = 2;
assert.throws(() => parseExtractedEventData(invalidReference));
assert.throws(() => parseCarouselMediaBinding({ version: 1, knownSlideCount: 3, images: [IMAGES[0], IMAGES[0]] }));
assert.equal(parseCarouselMediaBinding({ version: 1, knownSlideCount: 3,
  images: [IMAGES[0], { ...IMAGES[1], sourceUrl: IMAGES[0].sourceUrl }] }).images.length, 2,
"A repeated flyer URL still has independently labelled source indexes.");

const legacy = structuredClone(extraction([row({ title: "Legacy Party" })]));
delete legacy._carouselContractVersion; delete legacy._carouselMedia;
for (const entry of legacy.schedule_entries) {
  for (const key of ["source_slide_indexes", "poster_evidence", "text_evidence", "source_conflicts", "category", "price", "currency"]) delete entry[key];
  delete entry.date_evidence.slide_index; delete entry.time_evidence.slide_index;
}
delete legacy.date_evidence.slide_index; delete legacy.time_evidence.slide_index;
delete legacy.shared_schedule_context.venue.slide_index; delete legacy.shared_schedule_context.time.slide_index;
const parsedLegacy = parseExtractedEventData(legacy);
assert.equal(parsedLegacy._carouselMedia, undefined);
const legacyResult = prepareEventsForInsert(post(), parsedLegacy, IMAGES[0].sourceUrl,
  { qa_carousel_venue: "QA Venue" }, {}, { qa_carousel_venue: "QA Venue" }, { eventDateFilterNow: NOW,
    sourceRolesByHandle: { qa_carousel_venue: "venue" } });
assert.equal(legacyResult[0].normalizedFields.extractionCarouselContractVersion, undefined,
  "Existing v2 caches must stay on their unchanged planner.");

const originalFetch = globalThis.fetch;
const originalKey = process.env.OPENAI_API_KEY;
const originalModel = process.env.OPENAI_VISION_MODEL;
try {
  process.env.OPENAI_API_KEY = "qa-carousel-no-real-key";
  process.env.OPENAI_VISION_MODEL = "gpt-6-luna";
  let calls = 0;
  const providerData = extraction([row({ title: "Transport Party", slides: [0, 1] })]);
  delete providerData._carouselContractVersion; delete providerData._carouselMedia; delete providerData._extractionPolicyVersion;
  globalThis.fetch = async (url, options) => {
    calls += 1; assert.equal(url, "https://api.openai.com/v1/responses");
    const request = JSON.parse(options.body);
    assert.equal(request.model, "gpt-6-luna");
    const content = request.input[1].content;
    assert.equal(content.filter((part) => part.type === "input_image").length, 2,
      "Identical visual bytes at separate source indexes must both be labelled and submitted.");
    assert.deepEqual(content.filter((part) => part.type === "input_text" && part.text.startsWith("SLIDE "))
      .map((part) => part.text.slice(0, 7)), ["SLIDE 0", "SLIDE 1"]);
    assert.ok(request.text.format.schema.properties.schedule_entries.items.required.includes("text_evidence"));
    return new Response(JSON.stringify({ model: "gpt-6-luna", output_text: JSON.stringify(providerData) }), { status: 200 });
  };
  const actual = await extractEventDataFromInstagramPost({ imageDataUrls: ["data:image/jpeg;base64,AAAA", "data:image/jpeg;base64,AAAA"],
    carouselImages: IMAGES.slice(0, 2), carouselKnownSlideCount: 3, caption: "Exact original caption",
    instagramHandle: "qa_carousel_venue", instagramPostUrl: post().instagramPostUrl });
  assert.equal(calls, 1); assert.equal(actual._carouselContractVersion, "carousel_evidence_v1");
  assert.deepEqual(actual._carouselMedia.images, IMAGES.slice(0, 2));
  assert.equal(actual.source_caption, "Exact original caption");
  await assert.rejects(extractEventDataFromInstagramPost({ imageDataUrls: ["data:image/jpeg;base64,AAAA"],
    carouselImages: IMAGES.slice(0, 2), carouselKnownSlideCount: 3, instagramHandle: "qa",
    instagramPostUrl: post().instagramPostUrl }), /exactly one ordered transport image/u);
  assert.equal(calls, 1, "Invalid transport binding must fail before any paid request.");
} finally {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
  if (originalModel === undefined) delete process.env.OPENAI_VISION_MODEL; else process.env.OPENAI_VISION_MODEL = originalModel;
}

console.log("PASS: carousel grouping, row scope, source indexes, immutable cache bytes and one-call Luna transport.");
