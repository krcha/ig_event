import assert from "node:assert/strict";
import {
  EVENT_EXTRACTION_SYSTEM_PROMPT,
  buildEventExtractionUserPrompt,
} from "../lib/ai/event-extraction-prompt.ts";
import {
  AUTO_APPROVE_CONFIDENCE_THRESHOLD,
  calculateModerationConfidenceScore,
  normalizeConfidencePayload,
  normalizeConfidenceScore,
  shouldAutoApproveConfidenceScore,
} from "../lib/utils/confidence.ts";
import {
  buildCanonicalVenueNamesByHandle,
  normalizeExtractedArtists,
  normalizeExtractedDescription,
  normalizeVenueFromEvidence,
} from "../lib/pipeline/venue-normalization.ts";
import { prepareEventsForInsert } from "../lib/pipeline/run-instagram-ingestion.ts";

const STATIC_VENUE_BY_HANDLE = {
  "20_44.nightclub": "Klub 20/44",
  kcgrad: "KC Grad",
};
const MONTH_ABBRS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

function isoDateDaysFromNow(offsetDays) {
  const date = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

function datePartsForIsoDate(isoDate) {
  const date = new Date(`${isoDate}T12:00:00.000Z`);
  return {
    day: date.getUTCDate(),
    monthAbbr: MONTH_ABBRS[date.getUTCMonth()],
  };
}

function makeInstagramPost(overrides = {}) {
  return {
    postId: "qa-post-id",
    caption: "",
    altText: null,
    imageUrl: null,
    imageUrls: [],
    postType: "video",
    locationName: null,
    instagramPostUrl: "https://www.instagram.com/p/qa-post/",
    postedAt: new Date().toISOString(),
    username: "qa_handle",
    ...overrides,
  };
}

function makeFieldConfirmation(confidence = 0.95) {
  const entry = { confidence, found_in: ["caption"], notes: "QA evidence." };
  return {
    title: entry,
    location: entry,
    location_name: entry,
    price: { confidence: 0, found_in: [], notes: "No price." },
    start_time: entry,
    short_description: entry,
    artists: entry,
  };
}

function makeExtractedEvent(overrides = {}) {
  return {
    title: "QA Event",
    date: isoDateDaysFromNow(7),
    time: "21:00",
    venue: "QA Venue",
    city: "Belgrade",
    country: "Serbia",
    price: "",
    currency: "",
    artists: ["QA Artist"],
    category: "nightlife",
    description: "QA event description.",
    confidence: 0.95,
    reasoning_notes: "QA extraction.",
    source_caption: "QA caption.",
    source_url: "https://www.instagram.com/p/qa-post/",
    schedule_entries: [],
    field_confirmation: makeFieldConfirmation(),
    ...overrides,
  };
}

function runPromptQa() {
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /standardized venue display name/i,
    "Prompt must require venue standardization.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /Deduplicate artists/i,
    "Prompt must require artist deduplication.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /Do not include date, time, price, venue, address/i,
    "Prompt must keep descriptions factual and compact.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /schedule_entries/i,
    "Prompt must require structured multi-date schedule extraction.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /Do not collapse a multi-date venue schedule/i,
    "Prompt must forbid collapsing venue schedules into one event.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /must use one of these broad main types exactly/i,
    "Prompt must constrain category to the canonical public event types.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /0\.00 to 1\.00 inclusive/i,
    "Prompt must require confidence values in the 0.00-1.00 range.",
  );

  const userPrompt = buildEventExtractionUserPrompt({
    instagramHandle: "kcgrad",
    instagramPostUrl: "https://instagram.com/p/example",
    instagramPostTimestamp: "2026-03-08T20:00:00.000Z",
    instagramCaption: "Friday night at Grad",
    instagramAltText: "Poster text says Friday night at Grad with DJ Python.",
    instagramLocationName: "KC Grad",
    canonicalVenueName: "KC Grad",
    sourceImageUrl: "https://cdn.example.com/poster.jpg",
  });

  assert.match(userPrompt, /Instagram location tag: KC Grad/);
  assert.match(userPrompt, /Canonical venue hint: KC Grad/);
  assert.match(userPrompt, /Instagram alt text:/);
  assert.match(userPrompt, /schedule_entries/i);
}

function runVenueQa() {
  const canonicalVenueNamesByHandle = buildCanonicalVenueNamesByHandle([
    { name: "Drugstore", instagramHandle: "drugstore_beograd" },
    { name: "Zappa Baza", instagramHandle: "zappabaza" },
  ]);

  const canonicalFromHandle = normalizeVenueFromEvidence({
    handle: "20_44.nightclub",
    rawModelVenue: "20/44",
    locationName: "Belgrade",
    canonicalVenueNamesByHandle,
    staticVenueByHandle: STATIC_VENUE_BY_HANDLE,
  });
  assert.equal(canonicalFromHandle.venue, "Klub 20/44");
  assert.equal(canonicalFromHandle.source, "model");

  const canonicalFromLocation = normalizeVenueFromEvidence({
    handle: "random_promoter",
    rawModelVenue: "",
    locationName: "Zappa Baza",
    canonicalVenueNamesByHandle,
    staticVenueByHandle: STATIC_VENUE_BY_HANDLE,
  });
  assert.equal(canonicalFromLocation.venue, "Zappa Baza");
  assert.equal(canonicalFromLocation.source, "location_name");

  const genericLocationOnly = normalizeVenueFromEvidence({
    handle: "random_promoter",
    rawModelVenue: "Belgrade",
    locationName: "",
    canonicalVenueNamesByHandle,
    staticVenueByHandle: STATIC_VENUE_BY_HANDLE,
  });
  assert.equal(genericLocationOnly.venue, null);
}

function runArtistAndDescriptionQa() {
  assert.deepEqual(
    normalizeExtractedArtists(["  DJ Python  ", "dj python", "LINEUP", "Baba Ali"]),
    ["DJ Python", "Baba Ali"],
  );
  assert.equal(
    normalizeExtractedDescription("  Live set   with   two guests , all night.  "),
    "Live set with two guests, all night.",
  );
}

function runConfidenceQa() {
  assert.equal(normalizeConfidenceScore(0.7), 0.7);
  assert.equal(normalizeConfidenceScore("0.95"), 0.95);
  assert.equal(normalizeConfidenceScore(95), 0.95);
  assert.equal(normalizeConfidenceScore("100"), 1);
  assert.equal(normalizeConfidenceScore(-1), null);

  const normalized = normalizeConfidencePayload({
    confidence: 95,
    field_confirmation: {
      title: { confidence: "90" },
      location: { confidence: 0.85 },
    },
  });
  assert.deepEqual(normalized, {
    confidence: 0.95,
    field_confirmation: {
      title: { confidence: 0.9 },
      location: { confidence: 0.85 },
    },
  });

  assert.equal(
    calculateModerationConfidenceScore(0.95, {
      hasSuspectedDuplicates: false,
      missingImage: false,
    }),
    0.95,
  );
  assert.equal(
    calculateModerationConfidenceScore(0.95, {
      hasSuspectedDuplicates: true,
      missingImage: false,
    }),
    0.48,
  );
  assert.equal(
    calculateModerationConfidenceScore(0.95, {
      hasSuspectedDuplicates: false,
      missingImage: true,
    }),
    0.75,
  );
  assert.equal(
    calculateModerationConfidenceScore(0.95, {
      hasSuspectedDuplicates: false,
      missingImage: true,
      allowMissingImage: true,
    }),
    0.95,
  );
  assert.equal(
    shouldAutoApproveConfidenceScore(AUTO_APPROVE_CONFIDENCE_THRESHOLD),
    false,
  );
  assert.equal(AUTO_APPROVE_CONFIDENCE_THRESHOLD, 0.9);
  assert.equal(shouldAutoApproveConfidenceScore(0.89), false);
  assert.equal(shouldAutoApproveConfidenceScore(0.91), true);
}

function assertSingleOkPreparedEvent(results) {
  assert.equal(results.length, 1);
  const [result] = results;
  assert.equal(result.kind, "ok");
  return result;
}

function readPreparedNormalizedFields(prepared) {
  return JSON.parse(prepared.event.normalizedFieldsJson);
}

function runVideoModerationQa() {
  const highConfidenceVideo = assertSingleOkPreparedEvent(
    prepareEventsForInsert(
      makeInstagramPost({
        caption: "Opening season on the river. See you at Nova Zappa Barka.",
        postType: "video",
        username: "slep_slep_slep",
      }),
      makeExtractedEvent({
        title: "OTVARANJE LETNJE SEZONE ŠLEPARENJA NA RECI",
        date: isoDateDaysFromNow(7),
        time: "23:30",
        venue: "NOVA ZAPPA BARKA",
        artists: ["Šlep"],
        confidence: 0.95,
      }),
      null,
      {},
      {},
      {},
    ),
  );
  const highConfidenceFields = readPreparedNormalizedFields(highConfidenceVideo);
  assert.equal(highConfidenceVideo.event.status, "approved");
  assert.equal(highConfidenceFields.moderationConfidenceScore, 0.95);
  assert.equal(highConfidenceFields.extractionMode, "caption_only");
  assert.deepEqual(highConfidenceFields.moderationPendingReasons, []);

  const relaxedVideo = assertSingleOkPreparedEvent(
    prepareEventsForInsert(
      makeInstagramPost({
        caption: "Vidimo se u Barutani za tacno 7 dana.",
        postType: "video",
        username: "footworksshow",
      }),
      makeExtractedEvent({
        title: "",
        date: isoDateDaysFromNow(7),
        time: "",
        venue: "Barutana Beograd",
        artists: ["archiebhamilton"],
        confidence: 0.85,
        field_confirmation: makeFieldConfirmation(0.85),
      }),
      null,
      {},
      {},
      {},
    ),
  );
  const relaxedFields = readPreparedNormalizedFields(relaxedVideo);
  assert.equal(relaxedVideo.event.status, "approved");
  assert.equal(relaxedFields.moderationAutoApproveRule, "caption_only_video_core_fields");
  assert.deepEqual(relaxedFields.moderationPendingReasons, []);
  assert.ok(relaxedFields.moderationSignals.includes("fallback_title"));
  assert.ok(relaxedFields.moderationSignals.includes("missing_time"));

  const sparseVenueVideo = assertSingleOkPreparedEvent(
    prepareEventsForInsert(
      makeInstagramPost({
        caption: "Vidimo se 7. juna u Guvernanti",
        postType: "video",
        username: "sanset.wav",
      }),
      makeExtractedEvent({
        title: "",
        date: isoDateDaysFromNow(7),
        time: "",
        venue: "Guvernanta",
        artists: [],
        confidence: 0.8,
        field_confirmation: makeFieldConfirmation(0.8),
      }),
      null,
      {},
      {},
      {},
    ),
  );
  const sparseFields = readPreparedNormalizedFields(sparseVenueVideo);
  assert.equal(sparseVenueVideo.event.status, "approved");
  assert.equal(sparseFields.moderationAutoApproveRule, "caption_only_video_core_fields");
}

function runCaptionDateRangeQa() {
  const firstIsoDate = isoDateDaysFromNow(2);
  const secondIsoDate = isoDateDaysFromNow(3);
  const firstParts = datePartsForIsoDate(firstIsoDate);
  const secondParts = datePartsForIsoDate(secondIsoDate);
  const caption = [
    "Dva dana! Jedna lokacija!",
    "",
    "Vidimo se na Pikniku",
    "",
    `Subota ${firstParts.day}. ${firstParts.monthAbbr} 12-00h`,
    `Nedelja ${secondParts.day}. ${secondParts.monthAbbr} 10-21h`,
    "Muzej savremene umetnosti Beograd",
  ].join("\n");

  const prepared = prepareEventsForInsert(
    makeInstagramPost({
      caption,
      postType: "video",
      username: "piknik",
    }),
    makeExtractedEvent({
      title: "",
      date: "",
      time: "",
      venue: "Piknik",
      artists: [],
      category: "food & market",
      confidence: 0.85,
      source_caption: caption,
      field_confirmation: makeFieldConfirmation(0.85),
    }),
    null,
    {},
    {},
    {},
  );
  const events = prepared.filter((result) => result.kind === "ok").map((result) => result.event);
  assert.deepEqual(events.map((event) => event.date), [firstIsoDate, secondIsoDate]);
  assert.deepEqual(events.map((event) => event.time), ["12:00-00:00", "10:00-21:00"]);
  assert.equal(events.some((event) => event.date.endsWith("-10")), false);
}

runPromptQa();
runVenueQa();
runArtistAndDescriptionQa();
runConfidenceQa();
runVideoModerationQa();
runCaptionDateRangeQa();

console.log("QA passed: extraction prompt, venue standardization, artists, description, video moderation, and caption date ranges.");
