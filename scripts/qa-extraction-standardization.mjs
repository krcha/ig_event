import assert from "node:assert/strict";
import {
  EVENT_EXTRACTION_SYSTEM_PROMPT,
  buildEventExtractionUserPrompt,
} from "../lib/ai/event-extraction-prompt.ts";
import {
  AUTO_APPROVE_CONFIDENCE_THRESHOLD,
  CORE_EVENT_AUTO_APPROVE_CONFIDENCE_THRESHOLD,
  calculateModerationConfidenceScore,
  normalizeConfidencePayload,
  normalizeConfidenceScore,
  shouldAutoApproveConfidenceScore,
} from "../lib/utils/confidence.ts";
import {
  buildCanonicalVenueNamesByHandle,
  canonicalizeVenueName,
  canonicalizeVenueNameDetailed,
  normalizeExtractedArtists,
  normalizeExtractedDescription,
  normalizeVenueFromEvidence,
  toSearchableText,
} from "../lib/pipeline/venue-normalization.ts";
import {
  getNonEventAutoApprovalBlockers,
  getPosterScheduleAutoApprovalBlockers,
  normalizeEventDate,
  prepareEventsForInsert,
} from "../lib/pipeline/run-instagram-ingestion.ts";
import {
  extractEventTimeFromText,
  TBD_EVENT_TIME,
  normalizeEventTime,
  resolveEventTimeDisplay,
} from "../lib/events/event-time.ts";
import {
  checkWeekdayConsistency,
  looksLikeBareDate,
} from "../lib/events/event-validation.ts";

const STATIC_VENUE_BY_HANDLE = {
  "20_44.nightclub": "Klub 20/44",
  kcgrad: "KC Grad",
};
const QA_NOW_ISO = "2026-06-23T10:00:00.000Z";
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
const SERBIAN_MONTH_GENITIVES = [
  "januara",
  "februara",
  "marta",
  "aprila",
  "maja",
  "juna",
  "jula",
  "avgusta",
  "septembra",
  "oktobra",
  "novembra",
  "decembra",
];

// Release QA uses relative date fixtures; keep event-window filtering stable over time.
Date.now = () => new Date(QA_NOW_ISO).getTime();

function isoDateDaysFromNow(offsetDays) {
  const date = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

function datePartsForIsoDate(isoDate) {
  const date = new Date(`${isoDate}T12:00:00.000Z`);
  return {
    day: date.getUTCDate(),
    monthAbbr: MONTH_ABBRS[date.getUTCMonth()],
    serbianMonthGenitive: SERBIAN_MONTH_GENITIVES[date.getUTCMonth()],
  };
}

function nextIsoDateForWeekday(weekday, minOffsetDays = 2) {
  for (let offsetDays = minOffsetDays; offsetDays < minOffsetDays + 120; offsetDays += 1) {
    const date = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
    if (date.getUTCDay() === weekday) {
      return date.toISOString().slice(0, 10);
    }
  }

  throw new Error(`Could not find future weekday ${weekday}.`);
}

function addIsoDays(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function ddmmForIsoDate(isoDate) {
  const [, month, day] = isoDate.split("-");
  return `${Number(day)}.${month}`;
}

function consecutiveIsoDatesAvoidingDay(dayToAvoid, firstWeekday = null) {
  const avoidedSuffix = `-${String(dayToAvoid).padStart(2, "0")}`;

  for (let offsetDays = 2; offsetDays < 40; offsetDays += 1) {
    const firstIsoDate = isoDateDaysFromNow(offsetDays);
    const secondIsoDate = isoDateDaysFromNow(offsetDays + 1);
    const firstDate = new Date(`${firstIsoDate}T12:00:00.000Z`);
    const matchesWeekday = firstWeekday === null || firstDate.getUTCDay() === firstWeekday;
    if (
      matchesWeekday &&
      !firstIsoDate.endsWith(avoidedSuffix) &&
      !secondIsoDate.endsWith(avoidedSuffix)
    ) {
      return [firstIsoDate, secondIsoDate];
    }
  }

  throw new Error(`Could not find consecutive QA dates avoiding day ${dayToAvoid}.`);
}

function futureSameMonthIsoDateRange(length, minOffsetDays = 7) {
  for (let offsetDays = minOffsetDays; offsetDays < minOffsetDays + 120; offsetDays += 1) {
    const dates = Array.from({ length }, (_, index) => isoDateDaysFromNow(offsetDays + index));
    const firstMonth = dates[0].slice(0, 7);
    if (dates.every((isoDate) => isoDate.startsWith(firstMonth))) {
      return dates;
    }
  }

  throw new Error(`Could not find a future ${length}-day range inside one month.`);
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
  const entry = {
    confidence,
    found_in: ["caption"],
    evidence: "QA evidence",
    evidence_snippets: [{ source: "caption", text: "QA evidence" }],
    notes: "QA evidence.",
  };
  return {
    title: entry,
    location: entry,
    location_name: {
      confidence,
      found_in: ["location_tag", "canonical_hint"],
      evidence: "QA Venue",
      evidence_snippets: [{ source: "location_tag", text: "QA Venue" }],
      notes: "QA venue evidence.",
    },
    price: {
      confidence: 0,
      found_in: [],
      evidence: "",
      evidence_snippets: [],
      notes: "No price.",
    },
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
    /closed for vacation/i,
    "Prompt must reject closure/vacation notices as non-events.",
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
    /ONE POST OFTEN CONTAINS MANY EVENTS/i,
    "Prompt must explicitly treat posts as possibly multi-event.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /Goal is HIGH RECALL/i,
    "Prompt must prioritize high-recall schedule capture.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /DD\.MM" IS A DATE, NEVER A TIME/i,
    "Prompt must keep European dates out of time fields.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /početak 21h.*description/i,
    "Prompt must make start-time cue phrases populate the time field.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /svake večeri od 11\. do 17\. juna/i,
    "Prompt must treat Serbian od-do daily ranges as one occurrence per date.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /danas.*sutra.*prekosutra/i,
    "Prompt must treat today/tomorrow-style Serbian relative dates as date evidence.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /u četvrtak/i,
    "Prompt must mention Serbian on-weekday phrases.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /PETAK \/ SUBOTA \| 21h/i,
    "Prompt must treat repeated relative weekdays as separate event dates.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /ovog petka/i,
    "Prompt must treat Serbian relative weekdays as date evidence.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /sledeće subote/i,
    "Prompt must mention Serbian next-weekday phrases.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /GIVE EVERY ROW A TITLE/i,
    "Prompt must tell the model to title every dated schedule row.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /"category" must be exactly one of/i,
    "Prompt must constrain category to the canonical public event types.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /0\.00 to 1\.00 inclusive/i,
    "Prompt must require confidence values in the 0.00-1.00 range.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /evidence_snippets/i,
    "Prompt must require structured evidence snippets.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /Allowed source labels/i,
    "Prompt must constrain evidence snippet source labels.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /Confidence rubric/i,
    "Prompt must include a confidence calibration rubric.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /publishable core fields/i,
    "Prompt must tie top-level confidence to publishable core fields.",
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
    { name: "Kulturni centar GRAD", instagramHandle: "kcgrad" },
    { name: "Silosi Beograd ••••IIII Dom kulture", instagramHandle: "silosibeograd" },
    { name: "Art space in Belgrade, Serbia", instagramHandle: "kvaka22_catch22" },
    { name: "Chillton - Чилтон", instagramHandle: "chillton_chillton" },
    { name: "Sinnerman Jazz Club", instagramHandle: "sinnermanjazzclub" },
    { name: "Beton Club & Event Center", instagramHandle: "betonbelgrade" },
    { name: "Nula pet _0.5", instagramHandle: "nulapet_0.5" },
    { name: "Muzej Jugoslavije", instagramHandle: "muzej_jugoslavije" },
    { name: "Кафе Шупа", instagramHandle: "kafesupa" },
    { name: "Muzej grada Beograda", instagramHandle: "muzejgradabeograda" },
    { name: "ica", instagramHandle: "icketa" },
  ]);
  const venueNameOverridesByHandle = {
    kcgrad: "KC Grad",
    silosibeograd: "Silosi",
    kvaka22_catch22: "Kvaka 22",
    chillton_chillton: "Chillton",
    sinnermanjazzclub: "Sinnerman Jazz Club",
    betonbelgrade: "Beton",
    "nulapet_0.5": "Nula Pet",
    muzej_jugoslavije: "Muzej Jugoslavije",
    muzejgradabeograda: "Muzej grada Beograda",
  };

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

  const canonicalFromOverride = normalizeVenueFromEvidence({
    handle: "kcgrad",
    rawModelVenue: "",
    locationName: "",
    canonicalVenueNamesByHandle,
    handleVenueNamesByHandle: venueNameOverridesByHandle,
    staticVenueByHandle: STATIC_VENUE_BY_HANDLE,
  });
  assert.equal(canonicalFromOverride.venue, "KC Grad");
  assert.equal(canonicalFromOverride.source, "handle_map");

  const aliasCases = [
    ["Kulturni centar GRAD", "KC Grad"],
    ["KC Grad", "KC Grad"],
    ["Silosi Beograd ••••IIII Dom kulture", "Silosi"],
    ["Medonosni vrt Silosa", "Silosi"],
    ["Kvaka 22", "Kvaka 22"],
    ["Chillton", "Chillton"],
    ["SinnerMan", "Sinnerman Jazz Club"],
    ["Beton Club", "Beton"],
    ["Pab 0,5", "Nula Pet"],
    ["Bašta Paba Nula Pet", "Nula Pet"],
    ["Amphitheater in front of the Museum of Yugoslav History", "Muzej Jugoslavije"],
    ["Šupa", "Кафе Шупа"],
    ["шупа", "Кафе Шупа"],
    ["Kafe Šupa", "Кафе Шупа"],
    ["Спомен-музеј Иве Андрића", "Muzej grada Beograda"],
    ["Spomen-muzej Ive Andrica", "Muzej grada Beograda"],
  ];
  for (const [input, expected] of aliasCases) {
    const resolved = canonicalizeVenueName(input, canonicalVenueNamesByHandle, {
      handleVenueNamesByHandle: venueNameOverridesByHandle,
    });
    assert.equal(resolved, expected, `Expected venue alias '${input}' to resolve.`);
  }

  const detailedAlias = canonicalizeVenueNameDetailed("Pab 0,5", canonicalVenueNamesByHandle, {
    handleVenueNamesByHandle: venueNameOverridesByHandle,
  });
  assert.equal(detailedAlias?.reason, "alias");
  assert.equal(detailedAlias?.handle, "nulapet_0.5");
  assert.equal(toSearchableText("šupa"), "supa");
  assert.equal(toSearchableText("шупа"), "supa");
  assert.equal(toSearchableText("ʙᴇʟɢʀᴀᴅᴇ ᴋɪᴛᴄʜᴇɴ ᴘᴀʀᴛʏ"), "belgrade kitchen party");

  const muzejGradaPost = normalizeVenueFromEvidence({
    handle: "muzejgradabeograda",
    rawModelVenue: "Спомен-музеј Иве Андрића",
    locationName: "",
    canonicalVenueNamesByHandle,
    handleVenueNamesByHandle: venueNameOverridesByHandle,
    staticVenueByHandle: STATIC_VENUE_BY_HANDLE,
  });
  assert.equal(muzejGradaPost.venue, "Muzej grada Beograda");
  assert.notEqual(muzejGradaPost.venue, "ica");

  const andricVenue = canonicalizeVenueNameDetailed("Спомен-музеј Иве Андрића", canonicalVenueNamesByHandle, {
    handleVenueNamesByHandle: venueNameOverridesByHandle,
  });
  assert.equal(andricVenue?.reason, "alias");
  assert.equal(andricVenue?.handle, "muzejgradabeograda");
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
  assert.equal(CORE_EVENT_AUTO_APPROVE_CONFIDENCE_THRESHOLD, 0.8);
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
  assert.equal(highConfidenceFields.extractionScorecard.agent, "event_extraction");
  assert.equal(highConfidenceFields.extractionScorecard.baseConfidenceScore, 0.95);
  assert.equal(highConfidenceFields.extractionScorecard.finalModerationConfidenceScore, 0.95);
  assert.equal(highConfidenceFields.extractionScorecard.autoApproved, true);
  assert.ok(Array.isArray(highConfidenceFields.extractionScorecard.fieldEvidence));
  assert.ok(
    highConfidenceFields.extractionScorecard.fieldEvidence.some(
      (field) =>
        field.field === "title" &&
        field.evidence === "QA evidence" &&
        field.evidenceSnippets.some((snippet) => snippet.source === "caption"),
    ),
  );

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
  assert.ok(relaxedFields.moderationSignals.includes("time_tbd"));
  assert.equal(relaxedVideo.event.time, TBD_EVENT_TIME);

  const highConfidenceDateMissingTime = assertSingleOkPreparedEvent(
    prepareEventsForInsert(
      makeInstagramPost({
        caption: "Saturday event at Sprat.",
        postType: "image",
        username: "sprat_bar",
      }),
      makeExtractedEvent({
        title: "Saturday Night",
        date: isoDateDaysFromNow(7),
        time: "",
        venue: "Sprat",
        artists: ["QA DJ"],
        confidence: AUTO_APPROVE_CONFIDENCE_THRESHOLD,
        field_confirmation: makeFieldConfirmation(AUTO_APPROVE_CONFIDENCE_THRESHOLD),
      }),
      "https://cdn.example.com/poster.jpg",
      {},
      {},
      {},
    ),
  );
  const highConfidenceDateMissingTimeFields = readPreparedNormalizedFields(
    highConfidenceDateMissingTime,
  );
  assert.equal(highConfidenceDateMissingTime.event.status, "approved");
  assert.equal(highConfidenceDateMissingTime.event.time, TBD_EVENT_TIME);
  assert.equal(
    highConfidenceDateMissingTimeFields.moderationAutoApproveRule,
    "core_event_fields",
  );
  assert.equal(
    highConfidenceDateMissingTimeFields.moderationCoreEventAutoApproveThreshold,
    CORE_EVENT_AUTO_APPROVE_CONFIDENCE_THRESHOLD,
  );
  assert.deepEqual(highConfidenceDateMissingTimeFields.moderationPendingReasons, []);
  assert.ok(highConfidenceDateMissingTimeFields.moderationSignals.includes("time_tbd"));
  assert.ok(!highConfidenceDateMissingTimeFields.moderationSignals.includes("missing_time"));

  const fallbackTitleCoreFields = assertSingleOkPreparedEvent(
    prepareEventsForInsert(
      makeInstagramPost({
        caption: "Petak u KC Gradu, program uskoro.",
        postType: "image",
        username: "kcgrad",
      }),
      makeExtractedEvent({
        title: "",
        date: isoDateDaysFromNow(7),
        time: "",
        venue: "KC Grad",
        artists: [],
        confidence: CORE_EVENT_AUTO_APPROVE_CONFIDENCE_THRESHOLD,
        field_confirmation: makeFieldConfirmation(CORE_EVENT_AUTO_APPROVE_CONFIDENCE_THRESHOLD),
      }),
      "https://cdn.example.com/poster.jpg",
      STATIC_VENUE_BY_HANDLE,
      {},
      {},
    ),
  );
  const fallbackTitleCoreFieldsNormalized = readPreparedNormalizedFields(fallbackTitleCoreFields);
  assert.equal(fallbackTitleCoreFields.event.status, "approved");
  assert.equal(fallbackTitleCoreFields.event.time, TBD_EVENT_TIME);
  assert.equal(fallbackTitleCoreFieldsNormalized.moderationAutoApproveRule, "core_event_fields");
  assert.deepEqual(fallbackTitleCoreFieldsNormalized.moderationPendingReasons, []);
  assert.ok(fallbackTitleCoreFieldsNormalized.moderationSignals.includes("fallback_title"));
  assert.ok(fallbackTitleCoreFieldsNormalized.moderationSignals.includes("time_tbd"));
  assert.ok(!fallbackTitleCoreFieldsNormalized.moderationSignals.includes("missing_time"));

  const lowCoreConfidence = assertSingleOkPreparedEvent(
    prepareEventsForInsert(
      makeInstagramPost({
        caption: "Petak u Spratu.",
        postType: "image",
        username: "sprat_bar",
      }),
      makeExtractedEvent({
        title: "Friday Event",
        date: isoDateDaysFromNow(7),
        time: "",
        venue: "Sprat",
        artists: [],
        confidence: 0.79,
        field_confirmation: makeFieldConfirmation(0.79),
      }),
      "https://cdn.example.com/poster.jpg",
      {},
      {},
      {},
    ),
  );
  const lowCoreConfidenceFields = readPreparedNormalizedFields(lowCoreConfidence);
  assert.equal(lowCoreConfidence.event.status, "pending");
  assert.equal(lowCoreConfidence.event.time, TBD_EVENT_TIME);
  assert.deepEqual(lowCoreConfidenceFields.moderationPendingReasons, [
    "below_auto_approve_threshold",
  ]);
  assert.ok(lowCoreConfidenceFields.moderationSignals.includes("time_tbd"));
  assert.ok(!lowCoreConfidenceFields.moderationSignals.includes("missing_time"));

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

function runUnverifiedPosterScheduleModerationQa() {
  assert.deepEqual(
    getPosterScheduleAutoApprovalBlockers({
      splitSource: "poster_schedule",
      independentTextEvidence: "",
      hasTime: false,
    }),
    ["unverified_poster_schedule_tbd"],
  );
  assert.deepEqual(
    getPosterScheduleAutoApprovalBlockers({
      splitSource: "poster_schedule",
      independentTextEvidence: "11/07 KAXX",
      hasTime: false,
    }),
    [],
  );
  assert.deepEqual(
    getPosterScheduleAutoApprovalBlockers({
      splitSource: "poster_schedule",
      independentTextEvidence: "",
      hasTime: true,
    }),
    [],
  );
  assert.deepEqual(
    getNonEventAutoApprovalBlockers(
      "KOLEKTIVNI GODIŠNJI ODMOR OD 6.7.-20.7.2026. Closed for vacation.",
    ),
    ["non_event_closure_notice"],
  );
  assert.deepEqual(getNonEventAutoApprovalBlockers("Ayga 11.7. subota"), []);
  assert.deepEqual(
    getNonEventAutoApprovalBlockers("Ne radimo rezervacije zbog veličine mesta. Ulaz je besplatan."),
    [],
  );

  const lavashCaption = [
    "Vikend iza nas bio je u znaku dobre muzike i pozitivne energije uz @pozitivbend 💥",
    "",
    "Hvala svima koji su napravili atmosferu za pamćenje. ♥️",
    "",
    "Nastavljamo u istom ritmu i ove nedelje:",
    `• ${ddmmForIsoDate(isoDateDaysFromNow(7))}: @kaya_ostojic`,
    `• ${ddmmForIsoDate(isoDateDaysFromNow(8))}: @adisskaljo & @puls_bend`,
    "",
    "📞 Rezervišite svoje mesto porukom ili pozivom na broj 062/562-751",
  ].join("\n");
  const lavashPrepared = prepareEventsForInsert(
    makeInstagramPost({
      caption: lavashCaption,
      postType: "video",
      username: "lavash.belgrade",
    }),
    makeExtractedEvent({
      title: "",
      date: "",
      time: "",
      venue: "Lavash",
      artists: [],
      category: "live music",
      confidence: 0.95,
      description: "Live music performances at Lavash with artists Kaya Ostojic, Adis Skaljo & Puls bend.",
      source_caption: lavashCaption,
      field_confirmation: makeFieldConfirmation(0.95),
      schedule_entries: [
        {
          date: isoDateDaysFromNow(7),
          time: "",
          title: "@kaya_ostojic",
          artists: ["@kaya_ostojic"],
          description: "Live music performance by Kaya Ostojic at Lavash.",
          source_text: `${ddmmForIsoDate(isoDateDaysFromNow(7))}: @kaya_ostojic`,
        },
        {
          date: isoDateDaysFromNow(8),
          time: "",
          title: "@adisskaljo & @puls_bend",
          artists: ["@adisskaljo", "@puls_bend"],
          description: "Live music performance by Adis Skaljo and Puls bend at Lavash.",
          source_text: `${ddmmForIsoDate(isoDateDaysFromNow(8))}: @adisskaljo & @puls_bend`,
        },
      ],
    }),
    null,
    {},
    {},
    {},
  );
  const lavashEvents = lavashPrepared.filter((result) => result.kind === "ok").map((result) => result.event);
  assert.equal(lavashEvents.length, 2);
  assert.deepEqual(
    lavashEvents.map((event) => event.title),
    ["Kaya Ostojic", "Adisskaljo & Puls Bend"],
  );
  assert.deepEqual(lavashEvents[1].artists, ["Adisskaljo", "Puls Bend"]);
  assert.equal(lavashEvents[1].sourceCaption, lavashCaption);

  const firstDate = isoDateDaysFromNow(7);
  const secondDate = isoDateDaysFromNow(8);
  const prepared = prepareEventsForInsert(
    makeInstagramPost({
      caption: "",
      altText: null,
      postType: "image",
      username: "beg.u.beg",
    }),
    makeExtractedEvent({
      title: "",
      date: "",
      time: "",
      venue: "Beg",
      artists: [],
      description: "Monthly lineup poster for Beg venue in July 2026 featuring DJ events on multiple nights.",
      confidence: 0.95,
      source_caption: "",
      field_confirmation: makeFieldConfirmation(0.95),
      schedule_entries: [
        {
          date: firstDate,
          time: "",
          title: "KAXX",
          artists: ["KAXX"],
          description: "DJ set at Beg venue.",
          source_text: `${ddmmForIsoDate(firstDate)} KAXX`,
        },
        {
          date: secondDate,
          time: "",
          title: "DJ Leu",
          artists: ["DJ Leu"],
          description: "DJ set at Beg venue.",
          source_text: `${ddmmForIsoDate(secondDate)} DJ Leu`,
        },
      ],
    }),
    "https://cdn.example.com/beg-lineup.jpg",
    {},
    {},
    {},
  );

  assert.equal(prepared.length, 2);
  for (const result of prepared) {
    assert.equal(result.kind, "ok");
    assert.equal(result.event.status, "pending");
    assert.equal(result.event.time, TBD_EVENT_TIME);
    const fields = readPreparedNormalizedFields(result);
    assert.equal(fields.splitSource, "poster_schedule");
    assert.equal(fields.moderationAutoApproved, false);
    assert.equal(fields.moderationAutoApproveRule, null);
    assert.ok(fields.moderationSignals.includes("time_tbd"));
    assert.ok(fields.moderationSignals.includes("unverified_poster_schedule_tbd"));
    assert.deepEqual(fields.moderationPendingReasons, ["unverified_poster_schedule_tbd"]);
  }

  const closurePrepared = prepareEventsForInsert(
    makeInstagramPost({
      caption: "",
      postType: "image",
      username: "voxbluesclub",
    }),
    makeExtractedEvent({
      title: "Vox Blues club",
      date: firstDate,
      time: "",
      venue: "Vox Blues club",
      artists: [],
      description: "Vox Blues club is closed for collective vacation from July 6 to July 20, 2026.",
      confidence: 0.95,
      source_caption: "KOLEKTIVNI GODIŠNJI ODMOR OD 6.7.-20.7.2026.",
      field_confirmation: makeFieldConfirmation(0.95),
    }),
    "https://cdn.example.com/vox-closed.jpg",
    {},
    {},
    {},
  );
  assert.ok(closurePrepared.length >= 1);
  for (const result of closurePrepared) {
    assert.equal(result.kind, "ok");
    const closureFields = readPreparedNormalizedFields(result);
    assert.equal(result.event.status, "pending");
    assert.equal(closureFields.moderationAutoApproved, false);
    assert.ok(closureFields.moderationSignals.includes("non_event_closure_notice"));
    assert.ok(closureFields.moderationPendingReasons.includes("non_event_closure_notice"));
  }
}

function runCaptionDateRangeQa() {
  const [firstIsoDate, secondIsoDate] = consecutiveIsoDatesAvoidingDay(10, 6);
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

  const dailyRangeDates = futureSameMonthIsoDateRange(7, 10);
  const dailyRangeStart = datePartsForIsoDate(dailyRangeDates[0]);
  const dailyRangeEnd = datePartsForIsoDate(dailyRangeDates[dailyRangeDates.length - 1]);
  const dailyRangeCaption = [
    "Bioskop Akademije 28",
    "BROKEN ENGLISH",
    `Svake večeri od ${dailyRangeStart.day}. do ${dailyRangeEnd.day}. ${dailyRangeStart.serbianMonthGenitive} u 19h`,
  ].join("\n");
  const dailyRangePrepared = prepareEventsForInsert(
    makeInstagramPost({
      caption: dailyRangeCaption,
      postType: "video",
      username: "akademija28",
    }),
    makeExtractedEvent({
      title: "BROKEN ENGLISH",
      date: "",
      time: "19:00",
      venue: "Akademija 28",
      artists: [],
      category: "arts & culture",
      confidence: 0.9,
      source_caption: dailyRangeCaption,
      field_confirmation: makeFieldConfirmation(0.9),
    }),
    null,
    {},
    {},
    {},
  );
  const dailyRangeEvents = dailyRangePrepared
    .filter((result) => result.kind === "ok")
    .map((result) => result.event);
  assert.deepEqual(dailyRangeEvents.map((event) => event.date), dailyRangeDates);
  assert.deepEqual(
    dailyRangeEvents.map((event) => event.time),
    dailyRangeDates.map(() => "19:00"),
  );
  assert.equal(new Set(dailyRangeEvents.map((event) => event.venue)).size, 1);
}

function weekdayIsoDateFrom(baseIsoDate, weekday, qualifier = "this") {
  const baseDate = new Date(`${baseIsoDate}T12:00:00.000Z`);
  let offsetDays = (weekday - baseDate.getUTCDay() + 7) % 7;
  if (qualifier === "next" && offsetDays === 0) {
    offsetDays = 7;
  }
  return addIsoDays(baseIsoDate, offsetDays);
}

function prepareRelativeDateEvents({ caption, postedAt, postType = "video" }) {
  const prepared = prepareEventsForInsert(
    makeInstagramPost({
      caption,
      postedAt,
      postType,
      username: "serbian_relative_dates",
    }),
    makeExtractedEvent({
      title: "QA Relative Date",
      date: "",
      time: "21:00",
      venue: "QA Venue",
      artists: ["QA Artist"],
      category: "nightlife",
      confidence: 0.95,
      source_caption: caption,
      field_confirmation: makeFieldConfirmation(0.95),
    }),
    postType === "image" ? "https://images.example.com/relative-date.jpg" : null,
    {},
    {},
    {},
  );

  return {
    prepared,
    events: prepared.filter((result) => result.kind === "ok").map((result) => result.event),
  };
}

function assertRelativeDateCase({
  caption,
  expectedDates,
  expectedReason = "relative_weekday_from_post_timestamp",
  label,
  postedAt,
  postType = "video",
}) {
  const { events } = prepareRelativeDateEvents({ caption, postedAt, postType });
  assert.deepEqual(events.map((event) => event.date), expectedDates, label);
  assert.deepEqual(events.map((event) => event.time), expectedDates.map(() => "21:00"), label);
  const firstFields = JSON.parse(events[0].normalizedFieldsJson);
  assert.equal(firstFields.dateYearSelectionReason, expectedReason, label);
}

function runNumericCaptionDatePrecedenceQa() {
  const postedAt = "2026-07-07T16:37:24.000Z";
  const caption = [
    "ovim putem vas pozivamo na milion piva",
    "kafe supa",
    "11.7.",
    "20h",
  ].join("\n");

  const normalized = normalizeEventDate("12.07.2026", caption, postedAt);
  assert.equal(
    normalized.isoDate,
    "2026-07-11",
    "A bare Serbian/European caption date like 11.7. must override a model-generated shifted date.",
  );
  assert.equal(normalized.source, "caption");
  assert.equal(normalized.rawDateText, "11.7");
}

function runSerbianRelativeDateQa() {
  const baseMondayIsoDate = nextIsoDateForWeekday(1);
  const postedAt = `${baseMondayIsoDate}T10:00:00.000Z`;
  const weekdayCases = [
    {
      weekday: 1,
      english: "monday",
      thisSerbian: "ovog ponedeljka",
      nextSerbian: "narednog ponedeljka",
      onSerbian: "u ponedeljak",
      cyrillicThis: "овог понедељка",
    },
    {
      weekday: 2,
      english: "tuesday",
      thisSerbian: "ovog utorka",
      nextSerbian: "narednog utorka",
      onSerbian: "u utorak",
      cyrillicThis: "овог уторка",
    },
    {
      weekday: 3,
      english: "wednesday",
      thisSerbian: "ove srede",
      nextSerbian: "sledece srede",
      onSerbian: "u sredu",
      cyrillicThis: "ове среде",
    },
    {
      weekday: 4,
      english: "thursday",
      thisSerbian: "ovog cetvrtka",
      nextSerbian: "narednog četvrtka",
      onSerbian: "u četvrtak",
      cyrillicThis: "овог четвртка",
    },
    {
      weekday: 5,
      english: "friday",
      thisSerbian: "ovog petka",
      nextSerbian: "narednog petka",
      onSerbian: "u petak",
      cyrillicThis: "овог петка",
    },
    {
      weekday: 6,
      english: "saturday",
      thisSerbian: "ove subote",
      nextSerbian: "sledeće subote",
      onSerbian: "u subotu",
      cyrillicThis: "ове суботе",
    },
    {
      weekday: 0,
      english: "sunday",
      thisSerbian: "ovu nedelju",
      nextSerbian: "narednu nedelju",
      onSerbian: "u nedelju",
      cyrillicThis: "ову недељу",
    },
  ];

  for (const testCase of weekdayCases) {
    const thisWeekdayDate = weekdayIsoDateFrom(baseMondayIsoDate, testCase.weekday);
    const nextWeekdayDate = weekdayIsoDateFrom(baseMondayIsoDate, testCase.weekday, "next");
    for (const caption of [
      `This ${testCase.english} QA event at 21h.`,
      `Vidimo se ${testCase.thisSerbian} u 21h.`,
      `Видимо се ${testCase.cyrillicThis} у 21h.`,
      `QA event ${testCase.onSerbian} u 21h.`,
      `QA event on ${testCase.english} at 21h.`,
    ]) {
      assertRelativeDateCase({
        caption,
        expectedDates: [thisWeekdayDate],
        label: `this/on weekday phrase: ${caption}`,
        postedAt,
      });
    }

    for (const caption of [
      `Next ${testCase.english} QA event at 21h.`,
      `Vidimo se ${testCase.nextSerbian} u 21h.`,
    ]) {
      assertRelativeDateCase({
        caption,
        expectedDates: [nextWeekdayDate],
        label: `next weekday phrase: ${caption}`,
        postedAt,
      });
    }
  }

  for (const { caption, offsetDays, reason } of [
    { caption: "Danas slušamo QA DJ-a od 21h.", offsetDays: 0, reason: "relative_day_from_post_timestamp" },
    { caption: "Večeras slušamo QA DJ-a od 21h.", offsetDays: 0, reason: "relative_day_from_post_timestamp" },
    { caption: "Veceras slušamo QA DJ-a od 21h.", offsetDays: 0, reason: "relative_day_from_post_timestamp" },
    { caption: "Tonight we dance at 21h.", offsetDays: 0, reason: "relative_day_from_post_timestamp" },
    { caption: "Данас слушамо QA DJ-a од 21h.", offsetDays: 0, reason: "relative_day_from_post_timestamp" },
    { caption: "Sutra slušamo QA DJ-a od 21h.", offsetDays: 1, reason: "relative_day_from_post_timestamp" },
    { caption: "Tomorrow we dance at 21h.", offsetDays: 1, reason: "relative_day_from_post_timestamp" },
    { caption: "Сутра слушамо QA DJ-a од 21h.", offsetDays: 1, reason: "relative_day_from_post_timestamp" },
    { caption: "Prekosutra slušamo QA DJ-a od 21h.", offsetDays: 2, reason: "relative_day_from_post_timestamp" },
    { caption: "Day after tomorrow we dance at 21h.", offsetDays: 2, reason: "relative_day_from_post_timestamp" },
    { caption: "Прекосутра слушамо QA DJ-a од 21h.", offsetDays: 2, reason: "relative_day_from_post_timestamp" },
  ]) {
    assertRelativeDateCase({
      caption,
      expectedDates: [addIsoDays(baseMondayIsoDate, offsetDays)],
      expectedReason: reason,
      label: `relative day offset phrase: ${caption}`,
      postedAt,
    });
  }

  const fridayIsoDate = weekdayIsoDateFrom(baseMondayIsoDate, 5);
  const saturdayIsoDate = weekdayIsoDateFrom(baseMondayIsoDate, 6);
  for (const caption of [
    "PETAK / SUBOTA | 21h | BARAKA BAŠTA",
    "Petak, subota | 21h | BARAKA BAŠTA",
    "Petak i subota | 21h | BARAKA BAŠTA",
    "Friday and Saturday | 21h | BARAKA BAŠTA",
    "Петак и субота | 21h | BARAKA BAŠTA",
    "Petak - subota | 21h | BARAKA BAŠTA",
    "Ove nedelje: petak QA live, subota QA live. Start 21h.",
    "This week: Friday QA live and Saturday QA live. Start 21h.",
    "Ове недеље: петак QA live и субота QA live. Start 21h.",
  ]) {
    assertRelativeDateCase({
      caption,
      expectedDates: [fridayIsoDate, saturdayIsoDate],
      label: `multi-date relative weekday list: ${caption}`,
      postedAt,
      postType: "image",
    });
  }

  assertRelativeDateCase({
    caption: "Danas i sutra slušamo QA DJ-a od 21h.",
    expectedDates: [baseMondayIsoDate, addIsoDays(baseMondayIsoDate, 1)],
    expectedReason: "relative_day_from_post_timestamp",
    label: "multi-date day-offset list: danas i sutra",
    postedAt,
    postType: "image",
  });

  assertRelativeDateCase({
    caption: "Ovog ponedeljka posle ponoći slušamo QA DJ-a.",
    expectedDates: ["2026-06-29"],
    label: "post timestamp must be interpreted in Europe/Belgrade, not UTC",
    postedAt: "2026-06-22T22:30:00.000Z",
  });

  const ambiguousWeekOnly = prepareRelativeDateEvents({
    caption: "Ove nedelje najavljujemo program uskoro.",
    postedAt,
  });
  assert.equal(ambiguousWeekOnly.events.length, 0);
  assert.equal(ambiguousWeekOnly.prepared[0]?.kind, "skip");
  assert.equal(ambiguousWeekOnly.prepared[0]?.reason, "missing_date");
  assert.equal(
    ambiguousWeekOnly.prepared[0]?.normalizedFields.extractionScorecard.normalizedIsValid,
    false,
  );
  assert.equal(
    ambiguousWeekOnly.prepared[0]?.normalizedFields.extractionScorecard.normalizedInvalidReason,
    "invalid_date",
  );
}

function runDescriptionStartTimeQa() {
  for (const [text, expected] of [
    ["Žurka od 9", "09:00"],
    ["početak 21h", "21:00"],
    ["pocetak u 21", "21:00"],
    ["Počinje u 21 čas", "21:00"],
    ["Vidimo se u 20h", "20:00"],
    ["u 20.30", "20:30"],
    ["u 20,30", "20:30"],
    ["22:30", "22:30"],
    ["21 h", "21:00"],
    ["21:00h", "21:00"],
    ["nastup od 21h30", "21:30"],
    ["od 19 do 22", "19:00-22:00"],
    ["22h - 05h", "22:00-05:00"],
    ["start at 10pm", "22:00"],
    ["doors open 8:30 pm", "20:30"],
  ]) {
    assert.equal(extractEventTimeFromText(text), expected, `time text: ${text}`);
  }

  for (const text of [
    "19.06",
    "svake večeri od 11. do 17. juna",
    "Ulaz od 18+.",
    "Karte od 1000 RSD.",
    "Kapacitet 20 ljudi.",
  ]) {
    assert.equal(extractEventTimeFromText(text), undefined, `reject non-time text: ${text}`);
  }

  assert.equal(normalizeEventTime("početak 21h").startLabel, "21:00");

  const descriptionTimeEvent = assertSingleOkPreparedEvent(
    prepareEventsForInsert(
      makeInstagramPost({
        caption: "Lineup and practical info in description.",
        postType: "image",
        username: "sprat_bar",
      }),
      makeExtractedEvent({
        title: "Description Time Night",
        date: isoDateDaysFromNow(8),
        time: "",
        venue: "Sprat",
        artists: ["QA DJ"],
        description: "Club night. Početak 21h.",
        confidence: 0.95,
        field_confirmation: makeFieldConfirmation(0.95),
      }),
      "https://cdn.example.com/poster.jpg",
      {},
      {},
      {},
    ),
  );
  const descriptionFields = readPreparedNormalizedFields(descriptionTimeEvent);
  assert.equal(descriptionTimeEvent.event.time, "21:00");
  assert.equal(descriptionFields.timeSource, "description");
  assert.equal(descriptionFields.timeInferredFromText, true);
  assert.ok(!descriptionFields.moderationSignals.includes("time_tbd"));

  const captionTimeEvent = assertSingleOkPreparedEvent(
    prepareEventsForInsert(
      makeInstagramPost({
        caption: "Vidimo se od 9 za QA žurku.",
        postType: "image",
        username: "kcgrad",
      }),
      makeExtractedEvent({
        title: "Caption Time Night",
        date: isoDateDaysFromNow(9),
        time: "",
        venue: "KC Grad",
        artists: ["QA DJ"],
        description: "Nightlife event.",
        confidence: 0.95,
        source_caption: "",
        field_confirmation: makeFieldConfirmation(0.95),
      }),
      "https://cdn.example.com/poster.jpg",
      {},
      {},
      {},
    ),
  );
  const captionFields = readPreparedNormalizedFields(captionTimeEvent);
  assert.equal(captionTimeEvent.event.time, "09:00");
  assert.equal(captionFields.timeSource, "caption");

  const rawTimeTextEvent = assertSingleOkPreparedEvent(
    prepareEventsForInsert(
      makeInstagramPost({
        caption: "Raw time field includes start label.",
        postType: "image",
        username: "sprat_bar",
      }),
      makeExtractedEvent({
        title: "Raw Time Text Night",
        date: isoDateDaysFromNow(10),
        time: "početak 22:30",
        venue: "Sprat",
        artists: ["QA DJ"],
        confidence: 0.95,
        field_confirmation: makeFieldConfirmation(0.95),
      }),
      "https://cdn.example.com/poster.jpg",
      {},
      {},
      {},
    ),
  );
  const rawTimeFields = readPreparedNormalizedFields(rawTimeTextEvent);
  assert.equal(rawTimeTextEvent.event.time, "22:30");
  assert.equal(rawTimeFields.timeSource, "extracted_time");

  const dateRangeTextEvent = assertSingleOkPreparedEvent(
    prepareEventsForInsert(
      makeInstagramPost({
        caption: "Program za više dana.",
        postType: "image",
        username: "kcgrad",
      }),
      makeExtractedEvent({
        title: "Date Range Text Night",
        date: isoDateDaysFromNow(11),
        time: "",
        venue: "KC Grad",
        artists: ["QA DJ"],
        description: "Svake večeri od 11. do 17. juna.",
        confidence: 0.95,
        source_caption: "",
        field_confirmation: makeFieldConfirmation(0.95),
      }),
      "https://cdn.example.com/poster.jpg",
      {},
      {},
      {},
    ),
  );
  assert.equal(dateRangeTextEvent.event.time, TBD_EVENT_TIME);
}

function runScheduleConsistencyQa() {
  assert.equal(looksLikeBareDate("19.06"), true);
  assert.equal(looksLikeBareDate("19:30"), false);
  assert.equal(normalizeEventTime("19.06").startLabel, undefined);
  assert.equal(normalizeEventTime("19.30").startLabel, "19:30");
  assert.equal(
    resolveEventTimeDisplay({ date: "2026-06-20", time: TBD_EVENT_TIME }).label,
    TBD_EVENT_TIME,
  );

  const fridayIsoDate = nextIsoDateForWeekday(5);
  const saturdayIsoDate = addIsoDays(fridayIsoDate, 1);
  const fridayDdmm = ddmmForIsoDate(fridayIsoDate);
  const saturdayDdmm = ddmmForIsoDate(saturdayIsoDate);
  assert.equal(checkWeekdayConsistency(fridayIsoDate, "Wednesday Night").status, "mismatch");
  assert.equal(checkWeekdayConsistency(saturdayIsoDate, "Saturday Night").status, "ok");

  const sanitizedTimeEvent = assertSingleOkPreparedEvent(
    prepareEventsForInsert(
      makeInstagramPost({
        caption: "Neutral event with a date-like string in the time field.",
        postType: "image",
        username: "kucica_na_vodi",
      }),
      makeExtractedEvent({
        title: "Neutral Night",
        date: fridayIsoDate,
        time: "19.06",
        venue: "Kucica",
        artists: ["Neutral Act"],
        confidence: 0.95,
      }),
      "https://images.example.com/kucica.jpg",
      {},
      {},
      {},
    ),
  );
  const sanitizedFields = readPreparedNormalizedFields(sanitizedTimeEvent);
  assert.equal(sanitizedTimeEvent.event.time, TBD_EVENT_TIME);
  assert.equal(sanitizedFields.time, TBD_EVENT_TIME);

  const mismatchedTopLevel = prepareEventsForInsert(
    makeInstagramPost({
      caption: `Wednesday Night | ${fridayDdmm} - MLADOST`,
      postType: "image",
      username: "danijelcehranov",
    }),
    makeExtractedEvent({
      title: "danijelcehranov Wednesday Night",
      date: fridayIsoDate,
      time: "19.06",
      venue: "Kucica",
      artists: ["Night - MLADOST by Kucica na Vodi"],
      confidence: 0.95,
    }),
    "https://images.example.com/kucica.jpg",
    {},
    {},
    {},
  );
  assert.equal(mismatchedTopLevel.length, 1);
  assert.equal(mismatchedTopLevel[0].kind, "ok");
  assert.equal(mismatchedTopLevel[0].event.date, fridayIsoDate);
  assert.equal(mismatchedTopLevel[0].event.time, TBD_EVENT_TIME);
  assert.deepEqual(
    mismatchedTopLevel[0].normalizedFields.consistencyIssues,
    ["time_is_date"],
  );

  const schedulePrepared = prepareEventsForInsert(
    makeInstagramPost({
      caption: [
        "THIS WEEK AT KUCICA NA VODI",
        `Wednesday Night | ${fridayDdmm} - MLADOST`,
        `Saturday Night | ${saturdayDdmm} - LUDOST`,
      ].join("\n"),
      postType: "image",
      username: "danijelcehranov",
    }),
    makeExtractedEvent({
      title: "danijelcehranov Wednesday Night",
      date: fridayIsoDate,
      time: "19.06",
      venue: "Kucica",
      artists: ["Night - MLADOST by Kucica na Vodi"],
      confidence: 0.95,
      schedule_entries: [
        {
          date: fridayDdmm,
          time: "19.06",
          title: "Mladost",
          artists: ["Mladost"],
          description: "Nightlife event with MLADOST.",
          source_text: `Wednesday Night | ${fridayDdmm} - MLADOST`,
        },
        {
          date: saturdayDdmm,
          time: "22h",
          title: "Ludost",
          artists: ["LUDOST"],
          description: "Nightlife event with LUDOST.",
          source_text: `Saturday Night | ${saturdayDdmm} - LUDOST`,
        },
      ],
    }),
    "https://images.example.com/kucica.jpg",
    {},
    {},
    {},
  );
  const scheduleEvents = schedulePrepared
    .filter((result) => result.kind === "ok")
    .map((result) => result.event);
  assert.deepEqual(scheduleEvents.map((event) => event.title), ["Mladost", "Ludost"]);
  assert.deepEqual(scheduleEvents.map((event) => event.date), [fridayIsoDate, saturdayIsoDate]);
  assert.equal(scheduleEvents.some((event) => /danijelcehranov/i.test(event.title)), false);
  assert.equal(scheduleEvents.some((event) => event.time === "19:06"), false);
  assert.equal(scheduleEvents[0].time, TBD_EVENT_TIME);
  assert.equal(scheduleEvents[0].venue, "Kucica");
  assert.equal(scheduleEvents[1].venue, "Kucica");

  const sameDayIsoDate = isoDateDaysFromNow(14);
  const followingIsoDate = addIsoDays(sameDayIsoDate, 1);
  const sameDayDdmm = ddmmForIsoDate(sameDayIsoDate);
  const followingDdmm = ddmmForIsoDate(followingIsoDate);
  const sameDaySchedulePrepared = prepareEventsForInsert(
    makeInstagramPost({
      caption: [
        "THIS WEEK AT KUCICA NA VODI:",
        `Wednesday Afterwork | ${sameDayDdmm} - Zalazak by @danijelcehranov`,
        `Wednesday Night | ${sameDayDdmm} - @discogirl.bg @posle.rs`,
        `Thursday Night | ${followingDdmm} - @lostreszurke`,
      ].join("\n"),
      postType: "image",
      username: "kucicanavodi",
    }),
    makeExtractedEvent({
      title: "",
      date: "",
      time: "",
      venue: "Kucica",
      artists: [],
      category: "nightlife",
      confidence: 0.95,
      schedule_entries: [
        {
          date: sameDayIsoDate,
          time: "18:00-22:00",
          title: "Zalazak na Kucici",
          artists: ["danijelcehranov"],
          description: "Wednesday Afterwork event Zalazak at Kucica.",
          source_text: `18h - 22h ZALAZAK NA KUCICI ${sameDayDdmm}`,
        },
        {
          date: sameDayIsoDate,
          time: "22:00-05:00",
          title: "Sreda na Kucici",
          artists: ["discogirl.bg", "posle.rs"],
          description: "Wednesday Night event Sreda at Kucica.",
          source_text: `22h - 05h SREDA NA KUCICI ${sameDayDdmm}`,
        },
        {
          date: followingIsoDate,
          time: "22:00-05:00",
          title: "Los Tres",
          artists: ["lostreszurke"],
          description: "Thursday Night event Los Tres at Kucica.",
          source_text: `22h - 05h LOS TRES ${followingDdmm}`,
        },
      ],
      field_confirmation: makeFieldConfirmation(0.95),
    }),
    "https://images.example.com/kucica.jpg",
    {},
    {},
    {},
  );
  const sameDayScheduleEvents = sameDaySchedulePrepared
    .filter((result) => result.kind === "ok")
    .map((result) => result.event);
  assert.deepEqual(
    sameDayScheduleEvents.map((event) => `${event.date} ${event.time} ${event.title}`),
    [
      `${sameDayIsoDate} 18:00-22:00 Zalazak na Kucici`,
      `${sameDayIsoDate} 22:00-05:00 Sreda na Kucici`,
      `${followingIsoDate} 22:00-05:00 Los Tres`,
    ],
  );
}

function runTicketPriceQa() {
  for (const { currency, expected, price } of [
    { price: "10€", currency: "EUR", expected: "10€" },
    { price: "1200", currency: "RSD", expected: "1200 RSD" },
    { price: "1200 RSD", currency: "RSD", expected: "1200 RSD" },
    { price: "Regular 2690 RSD", currency: "RSD", expected: "Regular 2690 RSD" },
  ]) {
    const [prepared] = prepareEventsForInsert(
      makeInstagramPost(),
      makeExtractedEvent({
        price,
        currency,
        field_confirmation: makeFieldConfirmation(0.95),
      }),
      null,
      {},
      {},
      {},
    );
    assert.equal(prepared.kind, "ok");
    assert.equal(prepared.event.ticketPrice, expected);
  }
}

runPromptQa();
runVenueQa();
runArtistAndDescriptionQa();
runConfidenceQa();
runVideoModerationQa();
runUnverifiedPosterScheduleModerationQa();
runCaptionDateRangeQa();
runNumericCaptionDatePrecedenceQa();
runSerbianRelativeDateQa();
runDescriptionStartTimeQa();
runScheduleConsistencyQa();
runTicketPriceQa();

console.log("QA passed: extraction prompt, venue standardization, artists, description, video moderation, unverified poster schedule moderation, caption date ranges, Serbian relative dates, description start times, schedule consistency, and ticket prices.");
