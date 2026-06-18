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
  canonicalizeVenueName,
  canonicalizeVenueNameDetailed,
  normalizeExtractedArtists,
  normalizeExtractedDescription,
  normalizeVenueFromEvidence,
  toSearchableText,
} from "../lib/pipeline/venue-normalization.ts";
import { prepareEventsForInsert } from "../lib/pipeline/run-instagram-ingestion.ts";
import {
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
    /svake večeri od 11\. do 17\. juna/i,
    "Prompt must treat Serbian od-do daily ranges as one occurrence per date.",
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
  assert.equal(toSearchableText("ʙᴇʟɢʀᴀᴅᴇ ᴋɪᴛᴄʜᴇɴ ᴘᴀʀᴛʏ"), "belgrade kitchen party");
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
    "high_confidence_date_time_tbd",
  );
  assert.deepEqual(highConfidenceDateMissingTimeFields.moderationPendingReasons, []);
  assert.ok(highConfidenceDateMissingTimeFields.moderationSignals.includes("time_tbd"));
  assert.ok(!highConfidenceDateMissingTimeFields.moderationSignals.includes("missing_time"));

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
  assert.equal(scheduleEvents[0].time, undefined);
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
runCaptionDateRangeQa();
runScheduleConsistencyQa();
runTicketPriceQa();

console.log("QA passed: extraction prompt, venue standardization, artists, description, video moderation, caption date ranges, schedule consistency, and ticket prices.");
