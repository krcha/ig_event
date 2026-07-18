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
  buildDuplicateUpdatePatch,
  evaluateCoreEventSourceGrounding,
  getNonEventAutoApprovalBlockers,
  getPosterScheduleAutoApprovalBlockers,
  normalizeEventDate,
  prepareEventsForInsert,
} from "../lib/pipeline/run-instagram-ingestion.ts";
import {
  extractEventTimeFromText,
  TBD_EVENT_TIME,
  UNKNOWN_EVENT_TIME_LABEL,
  normalizeEventTime,
  resolveEventTimeDisplay,
} from "../lib/events/event-time.ts";
import {
  checkWeekdayConsistency,
  looksLikeBareDate,
} from "../lib/events/event-validation.ts";
import {
  assertExpectedEventStatus,
  assertServiceCreateEventPolicy,
  assertServiceUpdateEventPolicy,
  hasCompleteSourceGroundedAutoApproval,
} from "../lib/events/event-update-precondition.ts";
import { buildBackfillDecision } from "./backfill-moderation-scores.mjs";
import { buildPatch as buildTbdRepairPatch } from "./repair-event-tbd-times.mjs";
import {
  buildPatch as buildScheduleRepairPatch,
  buildSafeUpdatePatch as buildSafeScheduleUpdatePatch,
} from "./repair-event-schedule-entries.mjs";
import { buildRepair as buildConsistencyRepair } from "./repair-event-consistency.mjs";
import { chooseAction as chooseEventQualityAction } from "./audit-event-quality.mjs";
import { markModelDerivedRepairPending } from "./source-grounding-guard.mjs";
import { createEvent, updateEvent } from "../convex/events.ts";

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
    /high recall only among rows that are actually legible/i,
    "Prompt must keep schedule recall subordinate to source legibility.",
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
    /explicitly quoted work name.*Battle Royale.*event title/i,
    "Prompt must prefer an explicitly quoted cultural-work title over schedule metadata.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /hashtag is discovery\/marketing metadata, never an artist.*schedule-row title.*event title/i,
    "Prompt must reject hashtag-only artist and event identities.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /multiple dates\/times are explicit.*keep schedule_entries empty.*pending unnamed fallbacks/i,
    "Prompt must leave unnamed schedules to deterministic pending fallback handling.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /ONLY SOURCE-GROUNDED TITLES/i,
    "Prompt must require source-grounded schedule titles.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /lifestyle photo.*no legible event text/i,
    "Prompt must reject lifestyle photos without explicit event evidence.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /If you cannot quote that exact row, do not emit the schedule entry/i,
    "Prompt must prohibit unquotable schedule rows.",
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
        caption: `${ddmmForIsoDate(isoDateDaysFromNow(7))} OTVARANJE LETNJE SEZONE ŠLEPARENJA NA RECI uz Šlep 23:30 at Nova Zappa Barka.`,
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
  assert.equal(
    highConfidenceFields.moderationAutoApproveRule,
    "source_grounded_core_event_fields",
  );
  assert.equal(highConfidenceFields.extractionScorecard.agent, "event_extraction");
  assert.equal(highConfidenceFields.extractionScorecard.baseConfidenceScore, 0.95);
  assert.equal(highConfidenceFields.extractionScorecard.finalModerationConfidenceScore, 0.95);
  assert.equal(highConfidenceFields.extractionScorecard.autoApproved, true);
  assert.equal(
    hasCompleteSourceGroundedAutoApproval(
      highConfidenceVideo.event.normalizedFieldsJson,
      highConfidenceVideo.event,
    ),
    true,
    JSON.stringify({ event: highConfidenceVideo.event, fields: highConfidenceFields }, null, 2),
  );
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
        caption: `${ddmmForIsoDate(isoDateDaysFromNow(7))} DJ archiebhamilton u Barutani.`,
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
  assert.equal(relaxedFields.moderationAutoApproveRule, "source_grounded_core_event_fields");
  assert.deepEqual(relaxedFields.moderationPendingReasons, []);
  assert.equal(relaxedVideo.event.title, "archiebhamilton");
  assert.equal(relaxedFields.titleSource, "artist_fallback");
  assert.ok(!relaxedFields.moderationSignals.includes("fallback_title"));
  assert.ok(relaxedFields.moderationSignals.includes("time_tbd"));
  assert.equal(relaxedVideo.event.time, TBD_EVENT_TIME);

  const highConfidenceDateMissingTime = assertSingleOkPreparedEvent(
    prepareEventsForInsert(
      makeInstagramPost({
        caption: `${new Date(`${isoDateDaysFromNow(7)}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" })} Saturday Night with QA DJ at Sprat.`,
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
    "source_grounded_core_event_fields",
  );
  assert.equal(
    highConfidenceDateMissingTimeFields.moderationCoreEventAutoApproveThreshold,
    CORE_EVENT_AUTO_APPROVE_CONFIDENCE_THRESHOLD,
  );
  assert.deepEqual(highConfidenceDateMissingTimeFields.moderationPendingReasons, []);
  assert.equal(highConfidenceDateMissingTimeFields.sourceGroundingTimeVerified, null);
  assert.equal(highConfidenceDateMissingTimeFields.sourceGroundingRowVerified, true);
  assert.doesNotThrow(() =>
    assertServiceCreateEventPolicy(
      highConfidenceDateMissingTime.event.status,
      highConfidenceDateMissingTime.event.normalizedFieldsJson,
      highConfidenceDateMissingTime.event,
    ),
  );
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
  assert.equal(fallbackTitleCoreFields.event.status, "pending");
  assert.equal(fallbackTitleCoreFields.event.time, TBD_EVENT_TIME);
  assert.equal(fallbackTitleCoreFieldsNormalized.moderationAutoApproveRule, null);
  assert.deepEqual(fallbackTitleCoreFieldsNormalized.moderationPendingReasons, [
    "requires_human_approval",
    "unverified_core_event_source",
  ]);
  assert.equal(fallbackTitleCoreFieldsNormalized.sourceGroundingTitleVerified, false);
  assert.ok(fallbackTitleCoreFieldsNormalized.moderationSignals.includes("fallback_title"));
  assert.ok(fallbackTitleCoreFieldsNormalized.moderationSignals.includes("time_tbd"));
  assert.ok(!fallbackTitleCoreFieldsNormalized.moderationSignals.includes("missing_time"));

  const lowCoreConfidence = assertSingleOkPreparedEvent(
    prepareEventsForInsert(
      makeInstagramPost({
        caption: `${ddmmForIsoDate(isoDateDaysFromNow(7))} Friday Event with DJ KAXX u Spratu.`,
        postType: "image",
        username: "sprat_bar",
      }),
      makeExtractedEvent({
        title: "Friday Event",
        date: isoDateDaysFromNow(7),
        time: "",
        venue: "Sprat",
        artists: ["KAXX"],
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
    "requires_human_approval",
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
  assert.equal(sparseVenueVideo.event.status, "pending");
  assert.equal(sparseFields.moderationAutoApproveRule, null);
  assert.deepEqual(sparseFields.moderationPendingReasons, [
    "requires_human_approval",
    "unverified_core_event_source",
  ]);
}

function runUnverifiedPosterScheduleModerationQa() {
  const groundedDate = isoDateDaysFromNow(7);
  const groundedRow = `${ddmmForIsoDate(groundedDate)} DJ KAXX`;
  assert.deepEqual(
    getPosterScheduleAutoApprovalBlockers({
      splitSource: "poster_schedule",
      independentTextEvidence: "",
      title: "KAXX",
      normalizedDate: groundedDate,
      postedAt: new Date().toISOString(),
    }),
    ["unverified_core_event_source"],
  );
  assert.deepEqual(
    getPosterScheduleAutoApprovalBlockers({
      splitSource: "poster_schedule",
      independentTextEvidence: groundedRow,
      title: "DJ KAXX",
      artists: ["KAXX"],
      normalizedDate: groundedDate,
      postedAt: new Date().toISOString(),
    }),
    [],
  );
  assert.deepEqual(
    getPosterScheduleAutoApprovalBlockers({
      splitSource: "poster_schedule",
      independentTextEvidence: "Fast and furious 🚨",
      title: "Theodore Flex",
      normalizedDate: groundedDate,
      postedAt: new Date().toISOString(),
    }),
    ["unverified_core_event_source"],
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
    assert.ok(fields.moderationSignals.includes("unverified_core_event_source"));
    assert.deepEqual(fields.moderationPendingReasons, [
      "requires_human_approval",
      "unverified_core_event_source",
    ]);
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

function runHashtagOnlyScheduleIdentityQa() {
  const firstDate = nextIsoDateForWeekday(5, 7);
  const secondDate = addIsoDays(firstDate, 1);
  const thirdDate = addIsoDays(firstDate, 2);
  const firstDateLabel = ddmmForIsoDate(firstDate);
  const secondDateLabel = ddmmForIsoDate(secondDate);
  const thirdDateLabel = ddmmForIsoDate(thirdDate);
  const caption = [
    "BAŠ TAkve noći biramo iznova i iznova 🥂❤️‍🔥",
    "",
    `PETAK ${firstDateLabel} / SUBOTA ${secondDateLabel} | 21H`,
    "",
    "#baraka #beograd #greizaci #beogradnocu",
  ].join("\n");
  const prepared = prepareEventsForInsert(
    makeInstagramPost({
      caption,
      altText:
        `Photo by BARAKA BAŠTA. Text says BARAKA BAŠTA PETAK ${firstDateLabel} 21H SUBOTA ${secondDateLabel}.`,
      postType: "image",
      username: "baraka_basta",
    }),
    makeExtractedEvent({
      title: "",
      date: "",
      time: "",
      venue: "BARAKA BAŠTA",
      artists: [],
      category: "nightlife",
      description: "Party nights on Friday and Saturday starting at 21:00.",
      source_caption: caption,
      schedule_entries: [],
    }),
    "https://cdn.example.com/baraka.jpg",
    { baraka_basta: "BARAKA BAŠTA" },
    {},
    { baraka_basta: "BARAKA BAŠTA" },
  );
  const events = prepared.map((result) => {
    assert.equal(result.kind, "ok");
    return result;
  });
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((result) => result.event.title),
    [firstDate, secondDate].map((date) => {
      const weekday = new Intl.DateTimeFormat("en-US", {
        weekday: "long",
        timeZone: "UTC",
      }).format(new Date(`${date}T00:00:00Z`));
      return `${weekday} Night at BARAKA BAŠTA`;
    }),
  );
  for (const result of events) {
    const fields = readPreparedNormalizedFields(result);
    assert.deepEqual(result.event.artists, []);
    assert.equal(result.event.status, "pending");
    assert.equal(result.event.sourceCaption, caption);
    assert.equal(fields.titleSource, "unnamed_schedule_fallback");
    assert.equal(fields.titleUsedFallback, true);
    assert.equal(fields.sourceGroundingTitleVerified, false);
    assert.ok(fields.moderationSignals.includes("fallback_title"));
    assert.ok(fields.moderationPendingReasons.includes("requires_human_approval"));
  }

  const prepareBaraka = (postOverrides, extractedOverrides) =>
    prepareEventsForInsert(
      makeInstagramPost({
        caption,
        postType: "image",
        username: "baraka_basta",
        ...postOverrides,
      }),
      makeExtractedEvent({
        title: "",
        date: "",
        time: "",
        venue: "BARAKA BAŠTA",
        artists: [],
        category: "nightlife",
        source_caption: caption,
        schedule_entries: [],
        ...extractedOverrides,
      }),
      "https://cdn.example.com/baraka-adversarial.jpg",
      { baraka_basta: "BARAKA BAŠTA" },
      {},
      { baraka_basta: "BARAKA BAŠTA" },
    );
  const assertTwoUnnamedFallbacks = (results, label) => {
    const okResults = results.map((result) => {
      assert.equal(result.kind, "ok", label);
      return result;
    });
    assert.equal(okResults.length, 2, label);
    for (const result of okResults) {
      const fields = readPreparedNormalizedFields(result);
      assert.deepEqual(result.event.artists, [], label);
      assert.equal(fields.titleSource, "unnamed_schedule_fallback", label);
      assert.equal(fields.titleUsedFallback, true, label);
      assert.ok(fields.moderationSignals.includes("fallback_title"), label);
    }
    return okResults;
  };

  const modelHashtagRows = assertTwoUnnamedFallbacks(
    prepareBaraka(
      {},
      {
        artists: ["greizaci"],
        schedule_entries: [
          {
            date: firstDateLabel,
            time: "21:00",
            title: "greizaci",
            artists: ["greizaci"],
            description: "Party night at BARAKA BAŠTA.",
            source_text: `PETAK ${firstDateLabel} 21H`,
          },
          {
            date: secondDateLabel,
            time: "21:00",
            title: "greizaci",
            artists: ["greizaci"],
            description: "Party night at BARAKA BAŠTA.",
            source_text: `SUBOTA ${secondDateLabel} 21H`,
          },
        ],
      },
    ),
    "Model schedule rows must not promote hashtag-only identities.",
  );
  assert.ok(modelHashtagRows.every((result) => !result.event.title.includes("greizaci")));

  const decoratedModelRows = assertTwoUnnamedFallbacks(
    prepareBaraka(
      {},
      {
        schedule_entries: [
          {
            date: firstDateLabel,
            time: "21:00",
            title: "greizaci (DJ set)",
            artists: ["greizaci (DJ set)"],
            description: "Party night at BARAKA BAŠTA.",
            source_text: "",
          },
          {
            date: secondDateLabel,
            time: "21:00",
            title: "Live: greizaci",
            artists: ["Live: greizaci"],
            description: "Party night at BARAKA BAŠTA.",
            source_text: "",
          },
        ],
      },
    ),
    "DJ/live decorations must not evade the hashtag-only guard.",
  );
  assert.ok(decoratedModelRows.every((result) => !/greizaci/iu.test(result.event.title)));

  assertTwoUnnamedFallbacks(
    prepareBaraka(
      {},
      {
        schedule_entries: [
          {
            date: firstDateLabel,
            time: "21:00",
            title: "DJ set by greizaci",
            artists: ["DJ set by greizaci"],
            description: "Party night at BARAKA BAŠTA.",
            source_text: "",
          },
          {
            date: secondDateLabel,
            time: "21:00",
            title: "Music by greizaci",
            artists: ["Music by greizaci"],
            description: "Party night at BARAKA BAŠTA.",
            source_text: "",
          },
        ],
      },
    ),
    "Billing/decorative phrases without independent source evidence must not evade the hashtag guard.",
  );

  const threeDayCaption =
    `FRIDAY ${firstDateLabel} / SATURDAY ${secondDateLabel} / SUNDAY ${thirdDateLabel} | 21H`;
  const threeDayUnnamed = prepareBaraka(
    { caption: threeDayCaption },
    { source_caption: threeDayCaption },
  );
  assert.equal(threeDayUnnamed.length, 3);
  assert.deepEqual(
    threeDayUnnamed.map((result) => {
      assert.equal(result.kind, "ok");
      const fields = readPreparedNormalizedFields(result);
      assert.equal(fields.titleSource, "unnamed_schedule_fallback");
      assert.equal(fields.titleUsedFallback, true);
      assert.deepEqual(result.event.artists, []);
      return result.event.date;
    }),
    [firstDate, secondDate, thirdDate],
    "Combined weekday/date parsing must preserve every explicit occurrence.",
  );

  const partialModelSchedule = prepareBaraka(
    { caption: threeDayCaption },
    {
      source_caption: threeDayCaption,
      schedule_entries: [
        {
          date: firstDateLabel,
          time: "21:00",
          title: "DJ Friday",
          artists: ["DJ Friday"],
          description: "Friday DJ set.",
          source_text: `${firstDateLabel} DJ Friday 21H`,
        },
        {
          date: secondDateLabel,
          time: "21:00",
          title: "DJ Saturday",
          artists: ["DJ Saturday"],
          description: "Saturday DJ set.",
          source_text: `${secondDateLabel} DJ Saturday 21H`,
        },
      ],
    },
  );
  assert.deepEqual(
    partialModelSchedule.map((result) => {
      assert.equal(result.kind, "ok");
      return result.event.date;
    }),
    [firstDate, secondDate, thirdDate],
    "A partial model schedule must be supplemented with every independently parsed explicit date.",
  );
  assert.equal(
    readPreparedNormalizedFields(partialModelSchedule[2]).titleSource,
    "unnamed_schedule_fallback",
  );
  assert.deepEqual(partialModelSchedule[2].event.artists, []);

  for (const separator of [
    "|",
    "•",
    "·",
    "●",
    "▪",
    "‣",
    "∙",
    "◦",
    "‧",
    "⁃",
    "◆",
    "◇",
    "■",
    "□",
    "▸",
    "►",
    "▶",
  ]) {
    const partialCreditCaption = [
      `${firstDateLabel} - DJ Alpha 21H`,
      `${secondDateLabel} Photo: Alice ${separator} DJ Bob 22H`,
      `${thirdDateLabel} - DJ Charlie 23H`,
    ].join("\n");
    const partialCreditSchedule = prepareBaraka(
      { caption: partialCreditCaption },
      {
        source_caption: partialCreditCaption,
        schedule_entries: [
          {
            date: firstDateLabel,
            time: "21:00",
            title: "Alpha",
            artists: ["Alpha"],
            description: "DJ set.",
            source_text: `${firstDateLabel} DJ Alpha 21H`,
          },
          {
            date: thirdDateLabel,
            time: "23:00",
            title: "Charlie",
            artists: ["Charlie"],
            description: "DJ set.",
            source_text: `${thirdDateLabel} DJ Charlie 23H`,
          },
        ],
      },
    );
    assert.equal(partialCreditSchedule.length, 3);
    assert.equal(partialCreditSchedule[1].kind, "ok");
    assert.equal(partialCreditSchedule[1].event.title, "DJ Bob");
    assert.deepEqual(partialCreditSchedule[1].event.artists, ["DJ Bob"]);
  }

  const simpleSupplementCaption = [
    `${firstDateLabel} - DJ Alpha 21H`,
    `${secondDateLabel} - DJ Bravo 22H`,
    `${thirdDateLabel} - DJ Charlie 23H`,
  ].join("\n");
  const simpleSupplement = prepareBaraka(
    { caption: simpleSupplementCaption },
    {
      source_caption: simpleSupplementCaption,
      schedule_entries: [
        {
          date: firstDateLabel,
          time: "21:00",
          title: "Alpha",
          artists: ["Alpha"],
          description: "DJ set.",
          source_text: `${firstDateLabel} DJ Alpha 21H`,
        },
        {
          date: thirdDateLabel,
          time: "23:00",
          title: "Charlie",
          artists: ["Charlie"],
          description: "DJ set.",
          source_text: `${thirdDateLabel} DJ Charlie 23H`,
        },
      ],
    },
  );
  assert.equal(simpleSupplement[1].kind, "ok");
  assert.equal(simpleSupplement[1].event.title, "DJ Bravo");
  assert.deepEqual(simpleSupplement[1].event.artists, ["DJ Bravo"]);

  const sameDateCaption = [
    `${firstDateLabel} - DJ Alice 21H`,
    `${firstDateLabel} - DJ Bob 23H`,
    `${secondDateLabel} - DJ Charlie 22H`,
  ].join("\n");
  const sameDateActs = prepareBaraka(
    { caption: sameDateCaption },
    {
      source_caption: sameDateCaption,
      schedule_entries: [
        {
          date: firstDateLabel,
          time: "21:00",
          title: "Alice",
          artists: ["Alice"],
          description: "DJ set.",
          source_text: `${firstDateLabel} DJ Alice 21H`,
        },
        {
          date: secondDateLabel,
          time: "22:00",
          title: "Charlie",
          artists: ["Charlie"],
          description: "DJ set.",
          source_text: `${secondDateLabel} DJ Charlie 22H`,
        },
      ],
    },
  );
  assert.deepEqual(
    sameDateActs.map((result) => {
      assert.equal(result.kind, "ok");
      return { date: result.event.date, artists: result.event.artists };
    }),
    [
      { date: firstDate, artists: ["Alice"] },
      { date: firstDate, artists: ["DJ Bob"] },
      { date: secondDate, artists: ["Charlie"] },
    ],
    "Distinct same-date acts must survive deterministic reconciliation.",
  );

  const equivalentEvidenceCaption = [
    `${firstDateLabel} - DJ Bob 22H`,
    `${secondDateLabel} - DJ Charlie 23H`,
  ].join("\n");
  const equivalentArtistEvidence = prepareBaraka(
    { caption: equivalentEvidenceCaption },
    {
      source_caption: equivalentEvidenceCaption,
      schedule_entries: [
        {
          date: firstDateLabel,
          time: "22:00",
          title: "Bob",
          artists: [],
          description: "DJ set.",
          source_text: `${firstDateLabel} DJ Bob 22H`,
        },
        {
          date: secondDateLabel,
          time: "23:00",
          title: "Charlie",
          artists: ["Charlie"],
          description: "DJ set.",
          source_text: `${secondDateLabel} DJ Charlie 23H`,
        },
      ],
    },
  );
  assert.equal(equivalentArtistEvidence[0].kind, "ok");
  assert.equal(equivalentArtistEvidence[0].event.title, "Bob");
  assert.deepEqual(equivalentArtistEvidence[0].event.artists, ["DJ Bob"]);
  assert.equal(equivalentArtistEvidence[0].event.time, "22:00");
  const equivalentArtistFields = readPreparedNormalizedFields(equivalentArtistEvidence[0]);
  assert.equal(equivalentArtistFields.titleSource, "poster_schedule");
  assert.equal(equivalentArtistFields.splitSource, "caption_schedule");
  assert.match(equivalentArtistFields.splitSourceLine, /DJ Bob 22H/u);

  const equivalentTimeEvidence = prepareBaraka(
    { caption: equivalentEvidenceCaption },
    {
      source_caption: equivalentEvidenceCaption,
      schedule_entries: [
        {
          date: firstDateLabel,
          time: "",
          title: "Bob",
          artists: ["Bob"],
          description: "DJ set.",
          source_text: `${firstDateLabel} DJ Bob`,
        },
        {
          date: secondDateLabel,
          time: "23:00",
          title: "Charlie",
          artists: ["Charlie"],
          description: "DJ set.",
          source_text: `${secondDateLabel} DJ Charlie 23H`,
        },
      ],
    },
  );
  assert.equal(equivalentTimeEvidence[0].kind, "ok");
  assert.equal(equivalentTimeEvidence[0].event.time, "22:00");
  assert.deepEqual(equivalentTimeEvidence[0].event.artists, ["Bob"]);
  const equivalentTimeFields = readPreparedNormalizedFields(equivalentTimeEvidence[0]);
  assert.equal(equivalentTimeFields.timeSource, "schedule_entry");
  assert.match(equivalentTimeFields.timeEvidenceText, /22H/u);
  assert.equal(equivalentTimeFields.splitSource, "caption_schedule");

  const combinedTimeOnlyCaption =
    `FRIDAY ${firstDateLabel} / SATURDAY ${secondDateLabel} | 21H`;
  const fallbackTimeEnrichment = prepareBaraka(
    { caption: combinedTimeOnlyCaption },
    {
      source_caption: combinedTimeOnlyCaption,
      schedule_entries: [
        {
          date: firstDateLabel,
          time: "",
          title: "Bob",
          artists: ["Bob"],
          description: "DJ set.",
          source_text: `${firstDateLabel} DJ Bob`,
        },
        {
          date: secondDateLabel,
          time: "",
          title: "Charlie",
          artists: ["Charlie"],
          description: "DJ set.",
          source_text: `${secondDateLabel} DJ Charlie`,
        },
      ],
    },
  );
  assert.deepEqual(
    fallbackTimeEnrichment.map((result) => {
      assert.equal(result.kind, "ok");
      return result.event.time;
    }),
    ["21:00", "21:00"],
    "A date-only fallback row may enrich the sole same-date candidate's explicit time.",
  );

  const repeatedActCaption = [
    `${firstDateLabel} - DJ Bob 21H`,
    `${firstDateLabel} - DJ Bob 23H`,
    `${secondDateLabel} - DJ Charlie 22H`,
  ].join("\n");
  const repeatedActTimes = prepareBaraka(
    { caption: repeatedActCaption },
    {
      source_caption: repeatedActCaption,
      schedule_entries: [
        {
          date: firstDateLabel,
          time: "21:00",
          title: "Bob",
          artists: ["Bob"],
          description: "DJ set.",
          source_text: `${firstDateLabel} DJ Bob 21H`,
        },
        {
          date: secondDateLabel,
          time: "22:00",
          title: "Charlie",
          artists: ["Charlie"],
          description: "DJ set.",
          source_text: `${secondDateLabel} DJ Charlie 22H`,
        },
      ],
    },
  );
  assert.deepEqual(
    repeatedActTimes.map((result) => {
      assert.equal(result.kind, "ok");
      return { title: result.event.title, time: result.event.time };
    }),
    [
      { title: "Bob", time: "21:00" },
      { title: "DJ Bob", time: "23:00" },
      { title: "Charlie", time: "22:00" },
    ],
    "The same billed act at different explicit times must remain distinct events.",
  );

  const prefixArtistCaption = [
    `${firstDateLabel} - DJ Bob Marley 22H`,
    `${secondDateLabel} - DJ Charlie 23H`,
  ].join("\n");
  const prefixArtists = prepareBaraka(
    { caption: prefixArtistCaption },
    {
      source_caption: prefixArtistCaption,
      schedule_entries: [
        {
          date: firstDateLabel,
          time: "22:00",
          title: "Bob",
          artists: ["Bob"],
          description: "DJ set.",
          source_text: `${firstDateLabel} DJ Bob 22H`,
        },
        {
          date: secondDateLabel,
          time: "23:00",
          title: "Charlie",
          artists: ["Charlie"],
          description: "DJ set.",
          source_text: `${secondDateLabel} DJ Charlie 23H`,
        },
      ],
    },
  );
  assert.deepEqual(
    prefixArtists.map((result) => {
      assert.equal(result.kind, "ok");
      return { date: result.event.date, artists: result.event.artists };
    }),
    [
      { date: firstDate, artists: ["Bob"] },
      { date: firstDate, artists: ["DJ Bob Marley"] },
      { date: secondDate, artists: ["Charlie"] },
    ],
    "A token-prefix act must not be collapsed into a distinct longer artist name.",
  );

  const compositeHashtagCaption = [
    `${firstDateLabel} - Summer Party #Bob 22H`,
    `${secondDateLabel} - DJ Charlie 23H`,
    "#Bob",
  ].join("\n");
  const compositeHashtag = prepareBaraka(
    { caption: compositeHashtagCaption },
    {
      source_caption: compositeHashtagCaption,
      schedule_entries: [
        {
          date: firstDateLabel,
          time: "22:00",
          title: "Summer Party",
          artists: [],
          description: "Nightlife event.",
          source_text: `${firstDateLabel} Summer Party 22H`,
        },
        {
          date: secondDateLabel,
          time: "23:00",
          title: "Charlie",
          artists: ["Charlie"],
          description: "DJ set.",
          source_text: `${secondDateLabel} DJ Charlie 23H`,
        },
      ],
    },
  );
  assert.equal(compositeHashtag.length, 2);
  assert.equal(compositeHashtag[0].kind, "ok");
  assert.equal(compositeHashtag[0].event.title, "Summer Party");
  assert.deepEqual(compositeHashtag[0].event.artists, []);
  assert.doesNotMatch(compositeHashtag[0].event.title, /#/u);

  const compositeFields = readPreparedNormalizedFields(compositeHashtag[0]);
  const rowGroundedPendingNext = {
    ...compositeHashtag[0].event,
    artists: [],
    normalizedFieldsJson: JSON.stringify({
      ...compositeFields,
      artistsWereSanitized: true,
      rowSourceText: `${firstDateLabel} - DJ Legit #greizaci 22H`,
      splitSourceLine: `${firstDateLabel} - DJ Legit #greizaci 22H`,
    }),
  };
  const preservedPendingArtist = buildDuplicateUpdatePatch(
    {
      ...compositeHashtag[0].event,
      _id: "pending-row-grounded-artist",
      artists: ["DJ Legit"],
      status: "pending",
    },
    rowGroundedPendingNext,
  );
  assert.deepEqual(
    preservedPendingArtist.patch.artists,
    ["DJ Legit"],
    "A deliberately sanitized rescrape must retain an existing artist still billed in the exact row.",
  );

  const hashtagOnlyPendingNext = {
    ...compositeHashtag[0].event,
    artists: [],
    normalizedFieldsJson: JSON.stringify({
      ...compositeFields,
      artistsWereSanitized: true,
      rowSourceText: `${firstDateLabel} - Summer Party #greizaci 22H`,
      splitSourceLine: `${firstDateLabel} - Summer Party #greizaci 22H`,
    }),
  };
  const clearedPendingHashtagArtist = buildDuplicateUpdatePatch(
    {
      ...compositeHashtag[0].event,
      _id: "pending-hashtag-only-artist",
      artists: ["DJ greizaci"],
      status: "pending",
    },
    hashtagOnlyPendingNext,
  );
  assert.deepEqual(
    clearedPendingHashtagArtist.patch.artists,
    [],
    "A pending hashtag-only artist must still be cleared when the exact row does not bill it.",
  );

  const multipleFallbackModelSchedule = [
    {
      date: firstDateLabel,
      time: "",
      title: "Bob",
      artists: ["Bob"],
      description: "DJ set.",
      source_text: `${firstDateLabel} DJ Bob`,
    },
    {
      date: secondDateLabel,
      time: "22:00",
      title: "Charlie",
      artists: ["Charlie"],
      description: "DJ set.",
      source_text: `${secondDateLabel} DJ Charlie 22H`,
    },
  ];
  const summarizeFallbackRows = (results) =>
    results.map((result) => {
      assert.equal(result.kind, "ok");
      const fields = readPreparedNormalizedFields(result);
      return {
        date: result.event.date,
        time: result.event.time,
        title: result.event.title,
        titleSource: fields.titleSource,
      };
    });
  const expectedMultipleFallbackRows = [
    {
      date: firstDate,
      time: TBD_EVENT_TIME,
      title: "Bob",
      titleSource: "poster_schedule",
    },
    {
      date: firstDate,
      time: "21:00",
      title: "Friday Night at BARAKA BAŠTA",
      titleSource: "unnamed_schedule_fallback",
    },
    {
      date: firstDate,
      time: "23:00",
      title: "Friday Night at BARAKA BAŠTA",
      titleSource: "unnamed_schedule_fallback",
    },
    {
      date: secondDate,
      time: "22:00",
      title: "Charlie",
      titleSource: "poster_schedule",
    },
  ];

  const multipleFallbackTimesCaption = [
    `${firstDateLabel} | 21H`,
    `${firstDateLabel} | 23H`,
    `${secondDateLabel} - DJ Charlie 22H`,
  ].join("\n");
  const multipleFallbackTimes = prepareBaraka(
    { caption: multipleFallbackTimesCaption },
    {
      source_caption: multipleFallbackTimesCaption,
      schedule_entries: multipleFallbackModelSchedule,
    },
  );
  assert.deepEqual(
    summarizeFallbackRows(multipleFallbackTimes),
    expectedMultipleFallbackRows,
    "Conflicting fallback clocks must leave the named row untimed and preserve each clock.",
  );

  const reversedFallbackTimesCaption = [
    `${firstDateLabel} | 23H`,
    `${firstDateLabel} | 21H`,
    `${secondDateLabel} - DJ Charlie 22H`,
  ].join("\n");
  const reversedFallbackTimes = prepareBaraka(
    { caption: reversedFallbackTimesCaption },
    {
      source_caption: reversedFallbackTimesCaption,
      schedule_entries: multipleFallbackModelSchedule,
    },
  );
  assert.deepEqual(
    summarizeFallbackRows(reversedFallbackTimes),
    expectedMultipleFallbackRows,
    "Conflicting fallback-clock reconciliation must be invariant to source-row order.",
  );

  const splitCaptionFallbackTimes = [
    `${firstDateLabel} - DJ Bob`,
    `${firstDateLabel} | 21H`,
    `${secondDateLabel} - DJ Charlie 22H`,
  ].join("\n");
  const splitAltFallbackTimes = [
    `${firstDateLabel} | 23H`,
    `${secondDateLabel} - DJ Charlie 22H`,
  ].join("\n");
  const captionAltFallbackTimes = prepareBaraka(
    {
      caption: splitCaptionFallbackTimes,
      altText: splitAltFallbackTimes,
    },
    {
      source_caption: splitCaptionFallbackTimes,
      schedule_entries: multipleFallbackModelSchedule,
    },
  );
  assert.deepEqual(
    summarizeFallbackRows(captionAltFallbackTimes),
    expectedMultipleFallbackRows,
    "Fallback clocks split between caption and alt text must be grouped before enrichment.",
  );

  const reversedSourceCaption = [
    `${firstDateLabel} | 21H`,
    `${secondDateLabel} - DJ Charlie 22H`,
  ].join("\n");
  const reversedSourceAlt = [
    `${firstDateLabel} - DJ Bob`,
    `${firstDateLabel} | 23H`,
    `${secondDateLabel} - DJ Charlie 22H`,
  ].join("\n");
  const reversedCaptionAltFallbackTimes = prepareBaraka(
    {
      caption: reversedSourceCaption,
      altText: reversedSourceAlt,
    },
    {
      source_caption: reversedSourceCaption,
      schedule_entries: multipleFallbackModelSchedule,
    },
  );
  assert.deepEqual(
    summarizeFallbackRows(reversedCaptionAltFallbackTimes),
    expectedMultipleFallbackRows,
    "Named candidates from alt text must not replace caption fallback clocks before global reconciliation.",
  );
  assert.deepEqual(
    reversedCaptionAltFallbackTimes.map((result) => {
      assert.equal(result.kind, "ok");
      return readPreparedNormalizedFields(result).splitSource;
    }),
    ["poster_schedule", "caption_schedule", "alt_text_schedule", "poster_schedule"],
    "Caption/alt fallback provenance must remain attached to each retained clock.",
  );

  const exactCombinedDuplicateCaption = [
    `FRIDAY ${firstDateLabel} / SATURDAY ${secondDateLabel} | 21H`,
    `${firstDateLabel} | 21H`,
  ].join("\n");
  const exactCombinedDuplicates = prepareBaraka(
    { caption: exactCombinedDuplicateCaption },
    { source_caption: exactCombinedDuplicateCaption },
  );
  assert.deepEqual(
    exactCombinedDuplicates.map((result) => {
      assert.equal(result.kind, "ok");
      return { date: result.event.date, time: result.event.time };
    }),
    [
      { date: firstDate, time: "21:00" },
      { date: secondDate, time: "21:00" },
    ],
    "Combined and standalone caption parsers must share compatible dedupe keys.",
  );

  const malformedCombinedCaption =
    `FRIDAY ${firstDateLabel} / ${secondDateLabel} / SUNDAY ${thirdDateLabel} | 21H`;
  const malformedCombined = prepareBaraka(
    { caption: malformedCombinedCaption },
    { source_caption: malformedCombinedCaption },
  );
  assert.equal(
    malformedCombined.filter((result) => result.kind === "ok").length,
    0,
    "A combined line with an unpaired date must fail closed instead of dropping that date.",
  );

  const combinedPlusLaterCaption = [
    `FRIDAY ${firstDateLabel} / SATURDAY ${secondDateLabel} | 21.00`,
    `${thirdDateLabel} - DJ Third`,
  ].join("\n");
  const combinedPlusLater = prepareBaraka(
    { caption: combinedPlusLaterCaption },
    { source_caption: combinedPlusLaterCaption },
  );
  assert.deepEqual(
    combinedPlusLater.map((result) => {
      assert.equal(result.kind, "ok");
      return result.event.date;
    }),
    [firstDate, secondDate, thirdDate],
    "Combined rows must be accumulated with later dated caption rows.",
  );

  const shortActCaption = `${caption}\n#EZ`;
  const shortActRows = prepareBaraka(
    { caption: shortActCaption },
    {
      source_caption: shortActCaption,
      schedule_entries: [
        {
          date: firstDateLabel,
          time: "21:00",
          title: "EZ",
          artists: ["EZ"],
          description: "DJ set at BARAKA BAŠTA.",
          source_text: `${firstDateLabel} | EZ 21H`,
        },
        {
          date: secondDateLabel,
          time: "21:00",
          title: "EZ",
          artists: ["EZ"],
          description: "DJ set at BARAKA BAŠTA.",
          source_text: `${secondDateLabel} DJ EZ 21H`,
        },
      ],
    },
  );
  assert.deepEqual(
    shortActRows.map((result) => {
      assert.equal(result.kind, "ok");
      return { title: result.event.title, artists: result.event.artists };
    }),
    [
      { title: "EZ", artists: ["EZ"] },
      { title: "EZ", artists: ["EZ"] },
    ],
    "Short billed act names must remain valid when token-bound billing evidence exists.",
  );

  const oneCharacterCaption =
    `${firstDateLabel} - DJ X\n${secondDateLabel} - #X\n#X`;
  const oneCharacterRows = prepareBaraka(
    { caption: oneCharacterCaption },
    { source_caption: oneCharacterCaption },
  );
  assert.equal(oneCharacterRows.length, 2);
  assert.equal(oneCharacterRows[0].kind, "ok");
  assert.equal(oneCharacterRows[0].event.title, "DJ X");
  assert.deepEqual(oneCharacterRows[0].event.artists, ["DJ X"]);
  assert.equal(oneCharacterRows[1].kind, "ok");
  assert.deepEqual(oneCharacterRows[1].event.artists, []);
  assert.equal(
    readPreparedNormalizedFields(oneCharacterRows[1]).titleSource,
    "unnamed_schedule_fallback",
  );

  const captionHashtagRows = assertTwoUnnamedFallbacks(
    prepareBaraka(
      { caption: `${firstDateLabel} - #greizaci\n${secondDateLabel} - #greizaci` },
      {
        source_caption: `${firstDateLabel} - #greizaci\n${secondDateLabel} - #greizaci`,
      },
    ),
    "Caption schedule rows containing only hashtags must use unnamed fallbacks.",
  );
  assert.ok(captionHashtagRows.every((result) => !result.event.title.includes("#")));

  const altHashtagRows = assertTwoUnnamedFallbacks(
    prepareBaraka(
      {
        caption: "#greizaci",
        altText:
          `Photo by BARAKA BAŠTA. Text says '${firstDateLabel} - #greizaci ${secondDateLabel} - #greizaci'.`,
      },
      { source_caption: "#greizaci" },
    ),
    "Alt-text schedule rows containing only hashtags must use unnamed fallbacks.",
  );
  assert.ok(altHashtagRows.every((result) => !result.event.title.includes("#")));

  const combinedAltRows = prepareBaraka(
    {
      caption: "#greizaci",
      altText:
        `Photo text: 'FRIDAY ${firstDateLabel} / SATURDAY ${secondDateLabel} | 21H'.`,
    },
    { source_caption: "#greizaci" },
  );
  assert.deepEqual(
    combinedAltRows.map((result) => {
      assert.equal(result.kind, "ok");
      const fields = readPreparedNormalizedFields(result);
      assert.equal(fields.titleSource, "unnamed_schedule_fallback");
      assert.deepEqual(result.event.artists, []);
      return { date: result.event.date, title: result.event.title };
    }),
    [
      { date: firstDate, title: "Friday Night at BARAKA BAŠTA" },
      { date: secondDate, title: "Saturday Night at BARAKA BAŠTA" },
    ],
    "Combined alt-text schedules must fail closed to unnamed rows, not parse weekday fragments as artists.",
  );

  const malformedAltRows = prepareBaraka(
    {
      caption: "#greizaci",
      altText:
        `Photo text: 'FRIDAY ${firstDateLabel} / ${secondDateLabel} / SUNDAY ${thirdDateLabel} | 21H'.`,
    },
    { source_caption: "#greizaci" },
  );
  assert.equal(
    malformedAltRows.filter((result) => result.kind === "ok").length,
    0,
    "Alt-text combined schedules with an unpaired date must fail closed.",
  );

  const captionAltCaption = [
    `${firstDateLabel} - DJ Alpha 21H`,
    `${secondDateLabel} - DJ Alice 22H`,
  ].join("\n");
  const captionAltUnion = prepareBaraka(
    {
      caption: captionAltCaption,
      altText:
        `Photo text: '${secondDateLabel} - DJ Bob 23H ${thirdDateLabel} - DJ Charlie 24H'.`,
    },
    { source_caption: captionAltCaption },
  );
  assert.deepEqual(
    captionAltUnion.map((result) => {
      assert.equal(result.kind, "ok");
      return { date: result.event.date, artists: result.event.artists };
    }),
    [
      { date: firstDate, artists: ["DJ Alpha"] },
      { date: secondDate, artists: ["DJ Alice"] },
      { date: secondDate, artists: ["DJ Bob"] },
      { date: thirdDate, artists: ["DJ Charlie"] },
    ],
    "Caption/alt reconciliation must preserve distinct same-date acts while deduplicating coverage.",
  );

  const rowScopedCaption =
    `${firstDateLabel} - DJ greizaci\n${secondDateLabel} - #greizaci\n#greizaci`;
  const rowScopedCaptionRows = prepareBaraka(
    { caption: rowScopedCaption },
    { source_caption: rowScopedCaption },
  );
  assert.equal(rowScopedCaptionRows.length, 2);
  assert.equal(rowScopedCaptionRows[0].kind, "ok");
  assert.equal(rowScopedCaptionRows[1].kind, "ok");
  assert.deepEqual(rowScopedCaptionRows[0].event.artists, ["DJ greizaci"]);
  assert.deepEqual(rowScopedCaptionRows[1].event.artists, []);
  assert.equal(
    readPreparedNormalizedFields(rowScopedCaptionRows[1]).titleSource,
    "unnamed_schedule_fallback",
    "A billed identity on one caption row must not authorize a hashtag-only sibling row.",
  );

  const rowScopedAltRows = prepareBaraka(
    {
      caption: "#greizaci",
      altText:
        `Photo text: '${firstDateLabel} - DJ greizaci ${secondDateLabel} - #greizaci'.`,
    },
    { source_caption: "#greizaci" },
  );
  assert.equal(rowScopedAltRows.length, 2);
  assert.equal(rowScopedAltRows[0].kind, "ok");
  assert.equal(rowScopedAltRows[1].kind, "ok");
  assert.deepEqual(rowScopedAltRows[0].event.artists, ["DJ greizaci"]);
  assert.deepEqual(rowScopedAltRows[1].event.artists, []);
  assert.equal(
    readPreparedNormalizedFields(rowScopedAltRows[1]).titleSource,
    "unnamed_schedule_fallback",
    "A billed identity on one alt-text row must not authorize a hashtag-only sibling row.",
  );

  const directMixedCaption =
    `${firstDateLabel} - DJ Legit & #greizaci\n${secondDateLabel} - DJ Legit & #greizaci`;
  const directMixedCaptionRows = prepareBaraka(
    { caption: directMixedCaption },
    { source_caption: directMixedCaption },
  );
  assert.deepEqual(
    directMixedCaptionRows.map((result) => {
      assert.equal(result.kind, "ok");
      return { title: result.event.title, artists: result.event.artists };
    }),
    [
      { title: "DJ Legit", artists: ["DJ Legit"] },
      { title: "DJ Legit", artists: ["DJ Legit"] },
    ],
    "Caption rows must remove a hashtag-only co-artist while preserving billed artists.",
  );

  const directMixedAltRows = prepareBaraka(
    {
      caption: "#greizaci",
      altText:
        `Photo text: '${firstDateLabel} - DJ Legit & #greizaci ${secondDateLabel} - DJ Legit & #greizaci'.`,
    },
    { source_caption: "#greizaci" },
  );
  assert.deepEqual(
    directMixedAltRows.map((result) => {
      assert.equal(result.kind, "ok");
      return { title: result.event.title, artists: result.event.artists };
    }),
    [
      { title: "DJ Legit", artists: ["DJ Legit"] },
      { title: "DJ Legit", artists: ["DJ Legit"] },
    ],
    "Alt-text rows must remove a hashtag-only co-artist while preserving billed artists.",
  );

  const posterOnlyBilled = prepareBaraka(
    {},
    {
      schedule_entries: [
        {
          date: firstDateLabel,
          time: "21:00",
          title: "greizaci",
          artists: ["greizaci"],
          description: "DJ set at BARAKA BAŠTA.",
          source_text: `${firstDateLabel} DJ greizaci 21H`,
        },
        {
          date: secondDateLabel,
          time: "21:00",
          title: "greizaci",
          artists: ["greizaci"],
          description: "DJ set at BARAKA BAŠTA.",
          source_text: `${secondDateLabel} DJ greizaci 21H`,
        },
      ],
    },
  );
  assert.deepEqual(
    posterOnlyBilled.map((result) => {
      assert.equal(result.kind, "ok");
      return { title: result.event.title, artists: result.event.artists };
    }),
    [
      { title: "greizaci", artists: ["greizaci"] },
      { title: "greizaci", artists: ["greizaci"] },
    ],
    "A direct billed performer in poster row source_text must remain available for human review.",
  );

  const billedListCaption = `${caption}\n#Bob`;
  const billedArtistList = prepareBaraka(
    { caption: billedListCaption },
    {
      source_caption: billedListCaption,
      schedule_entries: [
        {
          date: firstDateLabel,
          time: "21:00",
          title: "Alice & Bob",
          artists: ["Alice", "Bob"],
          description: "DJ sets at BARAKA BAŠTA.",
          source_text: `${firstDateLabel} Alice & Bob 21H`,
        },
        {
          date: secondDateLabel,
          time: "21:00",
          title: "Alice & Bob",
          artists: ["Alice", "Bob"],
          description: "DJ sets at BARAKA BAŠTA.",
          source_text: `${secondDateLabel} Alice & Bob 21H`,
        },
      ],
    },
  );
  assert.deepEqual(
    billedArtistList.map((result) => {
      assert.equal(result.kind, "ok");
      return result.event.artists;
    }),
    [["Alice", "Bob"], ["Alice", "Bob"]],
    "A separately billed co-artist must remain valid even when the same name is also a hashtag.",
  );

  for (const separator of ["|", "●", "▪", "‣", "∙"]) {
    const mixedCreditAndBillingCaption =
      `${firstDateLabel} Photo: Alice ${separator} DJ Bob 21H\n#Bob`;
    const mixedCreditAndBilling = prepareBaraka(
      { caption: mixedCreditAndBillingCaption },
      {
        title: "Bob",
        date: firstDateLabel,
        time: "21:00",
        artists: ["Bob"],
        source_caption: mixedCreditAndBillingCaption,
      },
    );
    assert.equal(mixedCreditAndBilling.length, 1);
    assert.equal(mixedCreditAndBilling[0].kind, "ok");
    assert.equal(mixedCreditAndBilling[0].event.title, "Bob");
    assert.deepEqual(mixedCreditAndBilling[0].event.artists, ["Bob"]);
  }

  const longThankYouCaption =
    `${firstDateLabel} Hvala vam puno svima od srca na dugogodišnjoj podršci DJ Bob 21H\n#Bob`;
  const longThankYou = prepareBaraka(
    { caption: longThankYouCaption },
    {
      title: "Bob",
      date: firstDateLabel,
      time: "21:00",
      artists: ["Bob"],
      source_caption: longThankYouCaption,
    },
  );
  assert.equal(longThankYou.length, 1);
  assert.equal(longThankYou[0].kind, "ok");
  assert.notEqual(longThankYou[0].event.title, "Bob");
  assert.deepEqual(longThankYou[0].event.artists, []);

  const mixedArtists = prepareBaraka(
    { caption: `${caption}\nDJ Legit` },
    {
      source_caption: `${caption}\nDJ Legit`,
      schedule_entries: [
        {
          date: firstDateLabel,
          time: "21:00",
          title: "DJ Legit & greizaci",
          artists: ["DJ Legit", "greizaci"],
          description: "DJ set at BARAKA BAŠTA.",
          source_text: `${firstDateLabel} DJ Legit 21H`,
        },
        {
          date: secondDateLabel,
          time: "21:00",
          title: "DJ Legit & greizaci",
          artists: ["DJ Legit", "greizaci"],
          description: "DJ set at BARAKA BAŠTA.",
          source_text: `${secondDateLabel} DJ Legit 21H`,
        },
      ],
    },
  );
  assert.deepEqual(
    mixedArtists.map((result) => {
      assert.equal(result.kind, "ok");
      return { title: result.event.title, artists: result.event.artists };
    }),
    [
      { title: "DJ Legit", artists: ["DJ Legit"] },
      { title: "DJ Legit", artists: ["DJ Legit"] },
    ],
    "Mixed rows must retain billed artists while removing hashtag-only identities.",
  );

  const rowIndependentArtists = prepareBaraka(
    { caption: `${caption}\nDJ Legit` },
    {
      artists: ["greizaci", "DJ Legit"],
      source_caption: `${caption}\nDJ Legit`,
      schedule_entries: [
        {
          date: firstDateLabel,
          time: "21:00",
          title: "greizaci",
          artists: ["greizaci"],
          description: "Party night at BARAKA BAŠTA.",
          source_text: `${firstDateLabel} 21H`,
        },
        {
          date: secondDateLabel,
          time: "21:00",
          title: "DJ Legit",
          artists: ["DJ Legit"],
          description: "DJ set at BARAKA BAŠTA.",
          source_text: `${secondDateLabel} DJ Legit 21H`,
        },
      ],
    },
  );
  assert.deepEqual(
    rowIndependentArtists.map((result) => {
      assert.equal(result.kind, "ok");
      return { title: result.event.title, artists: result.event.artists };
    }),
    [
      { title: "Friday Night at BARAKA BAŠTA", artists: [] },
      { title: "DJ Legit", artists: ["DJ Legit"] },
    ],
    "A sanitized unnamed row must not inherit a performer from another schedule row.",
  );

  const namedRowWithSanitizedArtists = prepareBaraka(
    { caption: `${caption}\nDJ Legit` },
    {
      source_caption: `${caption}\nDJ Legit`,
      schedule_entries: [
        {
          date: firstDateLabel,
          time: "21:00",
          title: "Summer Party",
          artists: ["greizaci"],
          description: "Party night at BARAKA BAŠTA.",
          source_text: `${firstDateLabel} Summer Party 21H`,
        },
        {
          date: secondDateLabel,
          time: "21:00",
          title: "DJ Legit",
          artists: ["DJ Legit"],
          description: "DJ set at BARAKA BAŠTA.",
          source_text: `${secondDateLabel} DJ Legit 21H`,
        },
      ],
    },
  );
  assert.deepEqual(
    namedRowWithSanitizedArtists.map((result) => {
      assert.equal(result.kind, "ok");
      return { title: result.event.title, artists: result.event.artists };
    }),
    [
      { title: "Summer Party", artists: [] },
      { title: "DJ Legit", artists: ["DJ Legit"] },
    ],
    "A named row whose artists were sanitized must not repopulate artists from its title.",
  );

  const creditCaption = [
    `${firstDateLabel} photos by greizaci & friends 21H`,
    `${secondDateLabel} photos by greizaci & friends 21H`,
    "#greizaci",
  ].join("\n");
  assertTwoUnnamedFallbacks(
    prepareBaraka(
      { caption: creditCaption },
      {
        source_caption: creditCaption,
        schedule_entries: [
          {
            date: firstDateLabel,
            time: "21:00",
            title: "greizaci",
            artists: ["greizaci"],
            description: "Photo credit.",
            source_text: `${firstDateLabel} photos by greizaci & friends 21H`,
          },
          {
            date: secondDateLabel,
            time: "21:00",
            title: "greizaci",
            artists: ["greizaci"],
            description: "Photo credit.",
            source_text: `${secondDateLabel} photos by greizaci & friends 21H`,
          },
        ],
      },
    ),
    "Photo/production-style credits must not count as performer billing.",
  );

  const nonBillingCaption =
    `${firstDateLabel} | 21H Hvala puno DJ greizaci na podršci.\n#greizaci`;
  const nonBillingMention = assertSingleOkPreparedEvent(
    prepareBaraka(
      { caption: nonBillingCaption },
      {
        title: "DJ greizaci",
        date: firstDateLabel,
        time: "21:00",
        artists: ["greizaci"],
        source_caption: nonBillingCaption,
      },
    ),
  );
  assert.equal(nonBillingMention.event.title, "BARAKA BAŠTA");
  assert.deepEqual(nonBillingMention.event.artists, []);
  assert.equal(readPreparedNormalizedFields(nonBillingMention).titleUsedFallback, true);

  const substringCaption = `${firstDateLabel} RACE results at 21H.\n#ACE`;
  const substringIdentity = assertSingleOkPreparedEvent(
    prepareBaraka(
      { caption: substringCaption },
      {
        title: "ACE",
        date: firstDateLabel,
        time: "21:00",
        artists: ["ACE"],
        source_caption: substringCaption,
      },
    ),
  );
  assert.equal(substringIdentity.event.title, "BARAKA BAŠTA");
  assert.deepEqual(substringIdentity.event.artists, []);
  assert.equal(readPreparedNormalizedFields(substringIdentity).titleUsedFallback, true);

  const singleHashtagCaption = `${firstDateLabel} | 21H\n#greizaci`;
  const topLevelHashtagOnly = assertSingleOkPreparedEvent(
    prepareEventsForInsert(
      makeInstagramPost({
        caption: singleHashtagCaption,
        postType: "image",
        username: "baraka_basta",
      }),
      makeExtractedEvent({
        title: "greizaci",
        date: firstDateLabel,
        time: "21:00",
        venue: "BARAKA BAŠTA",
        artists: [],
        category: "nightlife",
        source_caption: singleHashtagCaption,
        schedule_entries: [],
      }),
      "https://cdn.example.com/baraka-single.jpg",
      { baraka_basta: "BARAKA BAŠTA" },
      {},
      { baraka_basta: "BARAKA BAŠTA" },
    ),
  );
  assert.equal(topLevelHashtagOnly.event.title, "BARAKA BAŠTA");
  const topLevelHashtagFields = readPreparedNormalizedFields(topLevelHashtagOnly);
  assert.equal(topLevelHashtagFields.rawTitle, "greizaci");
  assert.equal(topLevelHashtagFields.titleSource, "handle_fallback");
  assert.equal(topLevelHashtagFields.titleUsedFallback, true);

  const billedCaption = `${firstDateLabel} DJ greizaci at BARAKA BAŠTA. #greizaci`;
  const billed = assertSingleOkPreparedEvent(
    prepareEventsForInsert(
      makeInstagramPost({
        caption: billedCaption,
        postType: "image",
        username: "baraka_basta",
      }),
      makeExtractedEvent({
        title: "",
        date: firstDateLabel,
        time: "21:00",
        venue: "BARAKA BAŠTA",
        artists: ["greizaci"],
        category: "nightlife",
        source_caption: billedCaption,
        schedule_entries: [],
      }),
      "https://cdn.example.com/baraka-billed.jpg",
      { baraka_basta: "BARAKA BAŠTA" },
      {},
      { baraka_basta: "BARAKA BAŠTA" },
    ),
  );
  assert.equal(billed.event.title, "greizaci");
  assert.deepEqual(billed.event.artists, ["greizaci"]);
  const billedFields = readPreparedNormalizedFields(billed);
  assert.notEqual(billedFields.titleSource, "unnamed_schedule_fallback");
  assert.equal(billedFields.titleUsedFallback, false);
}

function runSourceGroundingAdversarialQa() {
  const firstDate = isoDateDaysFromNow(7);
  const secondDate = isoDateDaysFromNow(8);
  const firstDdmm = ddmmForIsoDate(firstDate);
  const secondDdmm = ddmmForIsoDate(secondDate);
  const evaluate = (overrides = {}) => evaluateCoreEventSourceGrounding({
    independentTextEvidence: `${firstDdmm} DJ ALICE 22:00`,
    title: "ALICE",
    normalizedDate: firstDate,
    postedAt: new Date().toISOString(),
    splitSource: "poster_schedule",
    titleUsedFallback: false,
    time: "22:00",
    artists: ["ALICE"],
    venue: "QA Venue",
    instagramHandle: "qa_handle",
    ...overrides,
  });

  assert.equal(evaluate().verified, true, "An exact raw row must remain eligible.");
  assert.equal(
    evaluate({
      independentTextEvidence: `${firstDdmm} ALICE 22:00\n${secondDdmm} BOB 23:00`,
      title: "BOB",
      artists: ["BOB"],
      time: "23:00",
    }).verified,
    false,
    "A model must not combine a date from one raw row with identity/time from another.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `${firstDdmm} ALICE 22:00 ${secondDdmm} BOB 23:00`,
      title: "BOB",
      artists: ["BOB"],
      time: "23:00",
    }).verified,
    false,
    "Compact multi-row alt text must not permit cross-row swaps.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `${firstDdmm} ALICE 22:00; BOB 23:00`,
      title: "BOB",
      artists: ["BOB"],
      time: "22:00",
    }).verified,
    false,
    "Same-date semicolon rows must not associate BOB with ALICE's time.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `${firstDdmm} ALICE 22h30 / BOB 23h30`,
      title: "BOB",
      artists: ["BOB"],
      time: "22:30",
    }).verified,
    false,
    "Slash-delimited rows and hMM clocks must not cross-associate BOB with ALICE.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `${firstDdmm} ALICE: 22:00 / BOB: 22:00`,
      title: "ALICE",
      artists: ["BOB"],
      time: "22:00",
    }).verified,
    false,
    "A title and unrelated artist sharing the same clock are not one billed row.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `${firstDdmm} ALICE 22:00 BOB 23:00`,
      title: "BOB",
      artists: ["BOB"],
      time: "22:00",
    }).verified,
    false,
    "A segment containing multiple clocks must fail closed.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `Summer memories ${firstDdmm}`,
      title: "Summer memories",
      artists: [],
      time: "",
    }).verified,
    false,
    "Arbitrary lifestyle prose plus a date is not a billed event identity.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `Summer memories from our last party. Throwback album ${firstDdmm}.`,
      title: "Summer memories",
      artists: [],
      time: "",
    }).verified,
    false,
    "An unrelated party cue elsewhere in prose must not validate a lifestyle slogan.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `Party people. Album drops ${firstDdmm}.`,
      title: "Party people",
      artists: [],
      time: "",
    }).verified,
    false,
    "A content-drop caption is not an event merely because the proposed title says party.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `${firstDdmm} Vidimo se!`,
      title: "Vidimo se",
      artists: [],
      time: "",
    }).verified,
    false,
    "A dated call to action is not an event identity.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `${firstDdmm} Dođite svi!`,
      title: "Dođite svi",
      artists: [],
      time: "",
    }).verified,
    false,
    "A Serbian dated call to action is not an event identity.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `${firstDdmm} Dress code WHITE. Doors open 22:00.`,
      title: "WHITE",
      artists: [],
      time: "22:00",
    }).verified,
    false,
    "Dress-code prose and a door time must not bill WHITE as an event.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `${firstDdmm} DJ ALICE`,
      title: "ALICE",
      artists: ["ALICE"],
      time: "",
    }).verified,
    true,
    "An explicit raw DJ billing with a date remains eligible without a published time.",
  );
  assert.equal(
    evaluate({ independentTextEvidence: "ALICE 22:00" }).verified,
    false,
    "A raw title without its event date must remain pending.",
  );
  assert.equal(
    evaluate({ independentTextEvidence: `${firstDdmm} 22:00` }).verified,
    false,
    "A raw date without a billed identity must remain pending.",
  );
  assert.equal(
    evaluate({ time: "23:00" }).verified,
    false,
    "A model-authored time that disagrees with the raw row must remain pending.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `${firstDdmm} QA Venue 22:00`,
      title: "QA Venue",
      artists: [],
      venue: "QA Venue",
    }).verified,
    false,
    "A venue name must not substitute for a separately billed event identity.",
  );

  const weakPrepared = assertSingleOkPreparedEvent(
    prepareEventsForInsert(
      makeInstagramPost({
        caption: `${firstDdmm} Vidimo se!`,
        postType: "image",
        username: "qa_handle",
      }),
      makeExtractedEvent({
        title: "Vidimo se",
        date: firstDate,
        time: "",
        venue: "QA Venue",
        artists: [],
        confidence: 0.95,
      }),
      "https://cdn.example.com/lifestyle.jpg",
      {},
      {},
      {},
    ),
  );
  assert.equal(weakPrepared.event.status, "pending");
  assert.equal(
    readPreparedNormalizedFields(weakPrepared).sourceGroundingVerified,
    false,
  );
  const protectedDuplicate = buildDuplicateUpdatePatch(
    {
      _id: "approved-existing",
      title: "Real Event",
      date: firstDate,
      time: "22:00",
      venue: "QA Venue",
      artists: ["REAL ARTIST"],
      eventType: "nightlife",
      status: "approved",
    },
    weakPrepared.event,
  );
  assert.equal(protectedDuplicate.protectedApprovedFromPending, true);
  assert.deepEqual(
    protectedDuplicate.patch,
    {},
    "A weak model identity must stay pending and cannot mutate an approved duplicate.",
  );

  const contentDropPrepared = assertSingleOkPreparedEvent(
    prepareEventsForInsert(
      makeInstagramPost({
        id: "content-drop-party-prose",
        shortCode: "content-drop-party-prose",
        caption: `Party people. (Album drops ${firstDdmm}. at 22:00.)`,
        altText: null,
        username: "qa_venue",
        imageUrl: "https://example.com/content-drop.jpg",
        images: ["https://example.com/content-drop.jpg"],
      }),
      makeExtractedEvent({
        title: "Party people",
        date: firstDate,
        time: "22:00",
        venue: "QA Venue",
        artists: [],
        confidence: 0.95,
      }),
      "https://example.com/content-drop.jpg",
      [],
    ),
  );
  assert.equal(contentDropPrepared.event.status, "pending");
  assert.equal(
    readPreparedNormalizedFields(contentDropPrepared).sourceGroundingVerified,
    false,
  );
  const protectedContentDropDuplicate = buildDuplicateUpdatePatch(
    {
      title: "REAL APPROVED EVENT",
      date: firstDate,
      time: "22:00",
      venue: "QA Venue",
      artists: ["REAL ARTIST"],
      eventType: "nightlife",
      status: "approved",
    },
    contentDropPrepared.event,
  );
  assert.equal(protectedContentDropDuplicate.protectedApprovedFromPending, true);
  assert.deepEqual(protectedContentDropDuplicate.patch, {});

  const numberedArchivePrepared = assertSingleOkPreparedEvent(
    prepareEventsForInsert(
      makeInstagramPost({
        id: "numbered-party-archive",
        shortCode: "numbered-party-archive",
        caption: `Party archive 20 photos drop ${firstDdmm}.`,
        altText: null,
        username: "qa_venue",
        imageUrl: "https://example.com/numbered-party-archive.jpg",
        images: ["https://example.com/numbered-party-archive.jpg"],
      }),
      makeExtractedEvent({
        title: "Party archive",
        date: firstDate,
        time: "",
        venue: "QA Venue",
        artists: [],
        confidence: 0.95,
      }),
      "https://example.com/numbered-party-archive.jpg",
      [],
    ),
  );
  assert.equal(numberedArchivePrepared.event.status, "pending");
  assert.equal(
    readPreparedNormalizedFields(numberedArchivePrepared).sourceGroundingVerified,
    false,
  );
  const protectedNumberedArchiveDuplicate = buildDuplicateUpdatePatch(
    {
      title: "REAL APPROVED EVENT",
      date: firstDate,
      time: null,
      venue: "QA Venue",
      artists: ["REAL ARTIST"],
      eventType: "nightlife",
      status: "approved",
    },
    numberedArchivePrepared.event,
  );
  assert.equal(protectedNumberedArchiveDuplicate.protectedApprovedFromPending, true);
  assert.deepEqual(
    protectedNumberedArchiveDuplicate.patch,
    {},
    "An unrelated number after an event-keyword title is not date evidence.",
  );

  const extraWeakCases = [
    {
      id: "age-marker-content-drop",
      caption: `18+ Summer Party DJ ALICE photo album drops ${firstDdmm}`,
      event: makeExtractedEvent({
        title: "Summer Party",
        date: firstDate,
        time: "",
        venue: "QA Venue",
        artists: ["ALICE"],
        confidence: 0.95,
      }),
    },
    {
      id: "extended-cta-title",
      caption: `${firstDdmm} Please join us for cocktails`,
      event: makeExtractedEvent({
        title: "Please join us for cocktails",
        date: firstDate,
        time: "",
        venue: "QA Venue",
        artists: [],
        confidence: 0.95,
      }),
    },
    {
      id: "sponsor-as-artist",
      caption: `${firstDdmm} Summer Party sponsored by ACME`,
      event: makeExtractedEvent({
        title: "Summer Party sponsored by ACME",
        date: firstDate,
        time: "",
        venue: "QA Venue",
        artists: ["ACME"],
        confidence: 0.95,
      }),
    },
  ];
  for (const testCase of extraWeakCases) {
    const prepared = assertSingleOkPreparedEvent(
      prepareEventsForInsert(
        makeInstagramPost({
          id: testCase.id,
          shortCode: testCase.id,
          caption: testCase.caption,
          altText: null,
          username: "qa_venue",
          imageUrl: `https://example.com/${testCase.id}.jpg`,
          images: [`https://example.com/${testCase.id}.jpg`],
        }),
        testCase.event,
        `https://example.com/${testCase.id}.jpg`,
        [],
      ),
    );
    assert.equal(prepared.event.status, "pending");
    assert.equal(readPreparedNormalizedFields(prepared).sourceGroundingVerified, false);
    const duplicatePatch = buildDuplicateUpdatePatch(
      {
        title: "REAL APPROVED EVENT",
        date: firstDate,
        time: null,
        venue: "QA Venue",
        artists: ["REAL ARTIST"],
        eventType: "nightlife",
        status: "approved",
      },
      prepared.event,
    );
    assert.equal(duplicatePatch.protectedApprovedFromPending, true);
    assert.deepEqual(duplicatePatch.patch, {});
  }
}

function runMaintenancePromotionGroundingQa() {
  const normalizedFields = {
    confidence: 0.99,
    dateConfidence: "high",
    sourceGroundingVerified: false,
  };
  const completeGrounding = {
    sourceGroundingVersion: 2,
    sourceGroundingEvidence: "instagram_caption_or_alt_text",
    sourceGroundingVerified: true,
    sourceGroundingTitleVerified: true,
    sourceGroundingDateVerified: true,
    sourceGroundingIdentityVerified: true,
    sourceGroundingIdentityContextVerified: true,
    sourceGroundingTimeVerified: null,
    sourceGroundingArtistsVerified: null,
    sourceGroundingRowVerified: true,
  };
  const event = {
    title: "ALICE",
    date: isoDateDaysFromNow(7),
    time: null,
    venue: "QA Venue",
    imageUrl: "https://cdn.example.com/poster.jpg",
    sourceCaption: `${ddmmForIsoDate(isoDateDaysFromNow(7))} ALICE`,
    normalizedFieldsJson: JSON.stringify(normalizedFields),
    rawExtractionJson: JSON.stringify({ confidence: 0.99 }),
  };
  const backfillBlocked = buildBackfillDecision(event);
  assert.equal(backfillBlocked.autoApproved, false);
  assert.ok(backfillBlocked.pendingReasons.includes("unverified_core_event_source"));
  const stalePartialEvent = {
    ...event,
    normalizedFieldsJson: JSON.stringify({
      ...normalizedFields,
      sourceGroundingVerified: true,
    }),
  };
  assert.equal(
    buildBackfillDecision(stalePartialEvent).autoApproved,
    false,
    "A stale single grounding boolean must not promote a pending event.",
  );
  assert.equal(buildTbdRepairPatch(stalePartialEvent).patch.status, undefined);
  const hardBlockedDecision = buildBackfillDecision({
    ...event,
    normalizedFieldsJson: JSON.stringify({
      ...normalizedFields,
      ...completeGrounding,
      moderationPendingReasons: ["non_event_closure_notice"],
      moderationSignals: ["non_event_closure_notice"],
    }),
  });
  assert.equal(
    hardBlockedDecision.autoApproved,
    false,
    "Backfill must not discard a persisted hard non-event blocker.",
  );
  assert.ok(hardBlockedDecision.pendingReasons.includes("non_event_closure_notice"));
  const hardBlockedTbdRepair = buildTbdRepairPatch({
    ...event,
    normalizedFieldsJson: JSON.stringify({
      ...normalizedFields,
      ...completeGrounding,
      moderationConfidenceScore: 0.99,
      moderationPendingReasons: ["non_event_closure_notice"],
      moderationSignals: ["non_event_closure_notice"],
    }),
  });
  assert.equal(
    hardBlockedTbdRepair.patch.status,
    undefined,
    "TBD repair must not approve an event carrying a hard non-event blocker.",
  );
  assert.ok(
    JSON.parse(hardBlockedTbdRepair.patch.normalizedFieldsJson)
      .moderationPendingReasons.includes("non_event_closure_notice"),
  );
  const completeBackfillDecision = buildBackfillDecision({
    ...event,
    normalizedFieldsJson: JSON.stringify({
      ...normalizedFields,
      ...completeGrounding,
    }),
  });
  assert.equal(completeBackfillDecision.autoApproved, false);
  assert.ok(completeBackfillDecision.pendingReasons.includes("requires_human_approval"));

  const repairBlocked = buildTbdRepairPatch(event);
  assert.equal(repairBlocked.patch.status, undefined);
  assert.ok(
    JSON.parse(repairBlocked.patch.normalizedFieldsJson)
      .moderationPendingReasons.includes("unverified_core_event_source"),
  );
  const completeTbdRepair = buildTbdRepairPatch({
    ...event,
    normalizedFieldsJson: JSON.stringify({
      ...normalizedFields,
      ...completeGrounding,
    }),
  });
  assert.equal(completeTbdRepair.patch.status, undefined);
  assert.ok(
    JSON.parse(completeTbdRepair.patch.normalizedFieldsJson)
      .moderationPendingReasons.includes("requires_human_approval"),
  );

  const invalidated = markModelDerivedRepairPending(
    {
      sourceGroundingVerified: true,
      moderationAutoApproved: true,
      moderationAutoApproveRule: "legacy",
    },
    "qa:model-repair",
  );
  assert.equal(invalidated.sourceGroundingVerified, false);
  assert.equal(invalidated.sourceGroundingIdentityContextVerified, false);
  assert.equal(invalidated.moderationAutoApproved, false);
  assert.ok(invalidated.moderationPendingReasons.includes("unverified_core_event_source"));

  const scheduleSource = {
    ...event,
    _id: "approved-source",
    status: "approved",
    sourcePostedAt: new Date().toISOString(),
    normalizedFieldsJson: JSON.stringify({ sourceGroundingVerified: true }),
  };
  const scheduleEntry = {
    date: event.date,
    time: "22:00",
    title: "MODEL ROW",
    artists: ["MODEL ROW"],
    description: "Model-derived repair row.",
    source_text: `${event.date} MODEL ROW 22:00`,
  };
  const schedulePatch = buildScheduleRepairPatch(scheduleSource, scheduleEntry, 0, 1);
  assert.equal(schedulePatch.status, "pending");
  const scheduleFields = JSON.parse(schedulePatch.normalizedFieldsJson);
  assert.equal(scheduleFields.sourceGroundingVerified, false);
  assert.equal(
    scheduleFields.sourceGroundingInvalidatedBy,
    "scripts/repair-event-schedule-entries.mjs",
  );
  assert.equal(
    buildSafeScheduleUpdatePatch({ ...scheduleSource, status: "approved" }, schedulePatch).status,
    "pending",
    "A model schedule repair must demote an approved record before changing public fields.",
  );

  const consistencyRepair = buildConsistencyRepair({
    ...scheduleSource,
    title: "This week",
    time: event.date.slice(5).replace("-", "."),
    artists: [],
    normalizedFieldsJson: JSON.stringify({
      splitEventIndex: 1,
      titleDerivedFromContext: true,
      sourceGroundingVerified: true,
    }),
    rawExtractionJson: JSON.stringify({ schedule_entries: [scheduleEntry] }),
  });
  assert.ok(consistencyRepair.patch);
  assert.equal(consistencyRepair.patch.status, "pending");
  assert.equal(
    JSON.parse(consistencyRepair.patch.normalizedFieldsJson).sourceGroundingVerified,
    false,
    "Consistency repair must invalidate stale source grounding.",
  );

  const qualityRepairAction = chooseEventQualityAction(
    {
      ...scheduleSource,
      normalizedFieldsJson: JSON.stringify(completeGrounding),
    },
    [
      {
        kind: "weak_title_source_grounded_repair",
        severity: "repair",
        patch: { title: "MODEL QUALITY REPAIR", artists: ["MODEL ARTIST"] },
      },
    ],
  );
  assert.equal(qualityRepairAction.action, "repair");
  assert.equal(qualityRepairAction.patch.status, "pending");
  const qualityRepairFields = JSON.parse(qualityRepairAction.patch.normalizedFieldsJson);
  assert.equal(qualityRepairFields.sourceGroundingVerified, false);
  assert.equal(
    qualityRepairFields.sourceGroundingInvalidatedBy,
    "scripts/audit-event-quality.mjs",
  );

  const qualityRejectAction = chooseEventQualityAction(
    {
      ...event,
      status: "pending",
      normalizedFieldsJson: JSON.stringify({
        ...normalizedFields,
        ...completeGrounding,
        moderationConfidenceScore: 0.99,
      }),
    },
    [
      {
        kind: "non_event_closure_notice",
        severity: "reject",
      },
    ],
  );
  assert.equal(qualityRejectAction.action, "reject");
  assert.equal(qualityRejectAction.patch.status, "rejected");
  const qualityRejectFields = JSON.parse(qualityRejectAction.patch.normalizedFieldsJson);
  assert.ok(qualityRejectFields.moderationPendingReasons.includes("non_event_closure_notice"));
  const rejectedTbdRepair = buildTbdRepairPatch({
    ...event,
    status: "rejected",
    normalizedFieldsJson: qualityRejectAction.patch.normalizedFieldsJson,
  });
  assert.equal(
    rejectedTbdRepair.patch.status,
    undefined,
    "TBD repair must never reapprove an event rejected by quality audit.",
  );
  assert.ok(
    JSON.parse(rejectedTbdRepair.patch.normalizedFieldsJson)
      .moderationPendingReasons.includes("non_event_closure_notice"),
  );
}

function runHallucinatedPhotoScheduleGroundingQa() {
  const titles = ["Theodore Flex", "Mona B2B Jale", "Lenno", "Vjeran Pas"];
  const dates = titles.map((_, index) => isoDateDaysFromNow(7 + index));
  const prepared = prepareEventsForInsert(
    makeInstagramPost({
      caption: "Fast and furious 🚨",
      altText: null,
      imageUrl: "https://cdn.example.com/lifestyle-photo.jpg",
      imageUrls: ["https://cdn.example.com/lifestyle-photo.jpg"],
      postType: "sidecar",
      username: "vjeran_pas",
    }),
    makeExtractedEvent({
      title: "",
      date: "",
      time: "",
      venue: "Svašta nam se dogadja",
      artists: [],
      category: "nightlife",
      description: "Weekly DJ schedule.",
      confidence: 0.95,
      source_caption: titles
        .map((title, index) => `${dates[index]} ${title} 22:00-03:00`)
        .join("\n"),
      field_confirmation: makeFieldConfirmation(0.95),
      schedule_entries: titles.map((title, index) => ({
        date: dates[index],
        time: "22:00-03:00",
        title,
        artists: [title],
        description: `DJ set by ${title}.`,
        source_text: `${dates[index]} ${title} 22:00-03:00`,
      })),
    }),
    "https://cdn.example.com/lifestyle-photo.jpg",
    {},
    {},
    {},
  );

  assert.equal(prepared.length, 4);
  for (const result of prepared) {
    assert.equal(result.kind, "ok");
    assert.equal(
      result.event.status,
      "pending",
      "A model-only schedule must never auto-publish when raw caption/alt text contains neither its title nor date.",
    );
    const fields = readPreparedNormalizedFields(result);
    assert.equal(fields.moderationAutoApproved, false);
    assert.ok(fields.moderationPendingReasons.includes("unverified_core_event_source"));
    assert.equal(fields.sourceGroundingTitleVerified, false);
    assert.equal(fields.sourceGroundingDateVerified, false);
    assert.equal(fields.sourceGroundingIdentityVerified, false);
    assert.equal(fields.sourceGroundingIdentityContextVerified, false);
    assert.equal(fields.sourceGroundingTimeVerified, false);
    assert.equal(fields.sourceGroundingArtistsVerified, false);
    assert.equal(fields.sourceGroundingRowVerified, false);
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

  const userReportedPiknikCaption = [
    "U saradnji sa @apgrade i @beat.bgd vodimo vas u Topčiderski park sledećeg vikenda!",
    "U subotu 11. jula očekuje vas program @apgrade i @beat.bgd a u nedelju 12. jula Piknik stiže u Topčiderski park.",
    "",
    "U nedelju 12. jula program traje od 12 do 21h i očekuju vas sve standardne Piknik zone i programi.",
    "",
    "Ulaz je slobodan kao i za svaki Piknik",
  ].join("\n");
  const userReportedPiknikPrepared = prepareEventsForInsert(
    makeInstagramPost({
      caption: userReportedPiknikCaption,
      postType: "image",
      postedAt: "2026-07-05T09:33:11.000Z",
      username: "piknikbg",
    }),
    makeExtractedEvent({
      title: "Piknik",
      date: "",
      time: "",
      venue: "Topčiderski park",
      artists: [],
      category: "event",
      description: "Piknik event held in Topčiderski park with standard zones and programs, free entry.",
      confidence: 0.85,
      source_caption: userReportedPiknikCaption,
      schedule_entries: [
        {
          date: "11.07.2026",
          time: "",
          title: "Program i",
          artists: ["@apgrade", "@beat.bgd"],
          description: "Program by @apgrade and @beat.bgd in Topčiderski park.",
          source_text: "U subotu 11. jula očekuje vas program @apgrade i @beat.bgd",
        },
        {
          date: "12.07.2026",
          time: "12:00-21:00",
          title: "Piknik",
          artists: [],
          description: "Piknik event with standard zones and programs, free entry.",
          source_text: "U nedelju 12. jula program traje od 12 do 21h i očekuju vas sve standardne Piknik zone i programi.",
        },
      ],
      field_confirmation: makeFieldConfirmation(0.85),
    }),
    "https://cdn.example.com/piknik.jpg",
    {},
    {},
    {},
  );
  const userReportedPiknikEvents = userReportedPiknikPrepared
    .filter((result) => result.kind === "ok")
    .map((result) => result.event);
  assert.equal(userReportedPiknikEvents[0].title, "Piknik");
  assert.notEqual(userReportedPiknikEvents[0].title, "Program i");
  assert.equal(JSON.parse(userReportedPiknikEvents[0].normalizedFieldsJson).titleSource, "model");

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
    "Ulaz od 10 do 20 evra",
    "Cena od 10 do 20 eura",
    "Karte od 10 do 20 dolara",
    "Tickets from 10 to 20 dollars",
    "Entry from 10 to 20 euros",
    "Open: 9h-17h",
    "Hours: 9h-17h",
    "Happy hour from 5 to 8",
    "Happy hours: 5h-8h",
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
  assert.equal(rawTimeFields.timeSource, "model");

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

  const unsupportedTimeContexts = [
    "Ulaz od 18 godina",
    "Raspon od 10 do 20",
    "Popust od 10 do 20%",
    "Radno vreme: od 9 do 17",
    "Working hours from 9 to 17",
    "Open daily from 9 to 17",
    "Otvoreno od 9 do 17",
    "Lokal radi od 9 do 17",
    "Bar hours: 9h-17h",
    "Od 10 do 20 posto popusta",
    "We are open from 9 to 17",
    "Otvoreni smo od 9 do 17",
    "Lokal je otvoren od 9 do 17",
    "Bar is open from 9 to 17",
    "Od 10 do 20 procenata popusta",
    "Ulaz od 10 do 20 evra",
    "Cena od 10 do 20 eura",
    "Karte od 10 do 20 dolara",
    "Tickets from 10 to 20 dollars",
    "Entry from 10 to 20 euros",
    "Open: 9h-17h",
    "Hours: 9h-17h",
    "Happy hour from 5 to 8",
    "Happy hours: 5h-8h",
  ];
  for (const [index, unsupportedText] of unsupportedTimeContexts.entries()) {
    for (const evidencePath of ["caption", "ocr"]) {
      const unsupportedTimeEvent = assertSingleOkPreparedEvent(
        prepareEventsForInsert(
          makeInstagramPost({
            caption: evidencePath === "caption" ? unsupportedText : "QA event announcement.",
            altText: evidencePath === "ocr" ? unsupportedText : null,
            postType: "image",
            username: "kcgrad",
          }),
          makeExtractedEvent({
            title: `Unsupported ${evidencePath} Time ${index}`,
            date: isoDateDaysFromNow(12),
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
      assert.equal(
        unsupportedTimeEvent.event.time,
        TBD_EVENT_TIME,
        `${evidencePath} must reject unsupported time context: ${unsupportedText}`,
      );
      assert.equal(unsupportedTimeEvent.event.timeSource, "unknown");
      assert.equal(unsupportedTimeEvent.event.timeConfidence, 0);
      assert.equal(unsupportedTimeEvent.event.timeStatus, "unknown");
      assert.equal(unsupportedTimeEvent.event.timeEvidenceText, undefined);
    }
  }

  for (const [index, mixedText] of [
    "Ulaz od 18 godina, početak u 21h",
    "Popust 20% pre 22h, početak u 21h",
    "Radno vreme do 17, koncert počinje u 21h",
    "Ulaz od 18 godina a početak u 21h",
    "Popust 20% pre 22h ali koncert počinje u 21h",
    "Radno vreme do 17 a koncert počinje u 21h",
    "Početak u 21h uz 20% popusta",
    "Ulaz od 10 do 20 evra, početak u 21h",
    "Tickets from 10 to 20 dollars but event starts at 21h",
    "Open: 9h-17h, concert starts at 21h",
    "Happy hour from 5 to 8 but show starts at 21h",
  ].entries()) {
    for (const evidencePath of ["caption", "ocr"]) {
      const mixedTimeEvent = assertSingleOkPreparedEvent(
        prepareEventsForInsert(
          makeInstagramPost({
            caption: evidencePath === "caption" ? mixedText : "QA event announcement.",
            altText: evidencePath === "ocr" ? mixedText : null,
            postType: "image",
            username: "kcgrad",
          }),
          makeExtractedEvent({
            title: `Mixed ${evidencePath} Time ${index}`,
            date: isoDateDaysFromNow(13),
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
      assert.equal(mixedTimeEvent.event.time, "21:00");
      assert.equal(
        mixedTimeEvent.event.timeSource,
        evidencePath === "caption" ? "caption" : "alt_text",
      );
      assert.equal(mixedTimeEvent.event.timeStatus, "inferred");
    }
  }
}

function runScheduleConsistencyQa() {
  assert.equal(looksLikeBareDate("19.06"), true);
  assert.equal(looksLikeBareDate("19:30"), false);
  assert.equal(normalizeEventTime("19.06").startLabel, undefined);
  assert.equal(normalizeEventTime("19.30").startLabel, "19:30");
  assert.equal(
    resolveEventTimeDisplay({ date: "2026-06-20", time: TBD_EVENT_TIME }).label,
    UNKNOWN_EVENT_TIME_LABEL,
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

function runQuotedCaptionTitleQa() {
  const date = isoDateDaysFromNow(7);
  const [year, month, day] = date.split("-");
  const captionDate = `${Number(day)}.${month}.${year.slice(-2)}.`;
  const caption = [
    `Utorak ${captionDate} u 21h u Zvezdi!`,
    "",
    "“Battle Royale” (2000)",
    "",
    "Kultni japanski film Battle Royale, u režiji Kinjija Fukasakua.",
    "",
    "Titl engleski. Vrata se otvaraju u 20:30h. Vidimo se!",
  ].join("\n");
  const results = prepareEventsForInsert(
    makeInstagramPost({
      caption,
      postType: "image",
      postedAt: new Date().toISOString(),
      username: "novi_bioskop_zvezda",
    }),
    makeExtractedEvent({
      title: "",
      date,
      time: "",
      venue: "New Cinema Zvezda",
      artists: [],
      category: "arts & culture",
      description: "Screening of the Japanese film Battle Royale (2000).",
      source_caption: caption,
      reasoning_notes: "The caption announces a Battle Royale screening.",
      confidence: 0.95,
    }),
    "https://images.example.com/battle-royale.jpg",
    {},
    {},
    {},
  );
  const prepared = results.find(
    (result) =>
      result.kind === "ok" &&
      JSON.parse(result.event.normalizedFieldsJson).normalizedDate === date,
  );
  assert.ok(prepared && prepared.kind === "ok", "Battle Royale fixture must produce an event.");
  assert.equal(
    prepared.event.title,
    "Battle Royale",
    "A quoted film title must beat a date/time/location-only caption line.",
  );

  function prepareQuotedFixture(testCaption, category = "nightlife") {
    const [result] = prepareEventsForInsert(
      makeInstagramPost({
        caption: testCaption,
        postType: "image",
        postedAt: new Date().toISOString(),
        username: "quoted_title_fixture",
      }),
      makeExtractedEvent({
        title: "",
        date,
        time: "21:00",
        venue: "Fixture Venue",
        artists: [],
        category,
        description: "Fixture event description.",
        source_caption: testCaption,
        confidence: 0.95,
      }),
      "https://images.example.com/fixture.jpg",
      {},
      {},
      {},
    );
    assert.equal(result.kind, "ok", "Quoted-title fixture must produce an event.");
    return result;
  }

  for (const { caption: negativeCaption, rejectedTitle, category } of [
    {
      caption: "Organizatori poručuju: “Vidimo se!”",
      rejectedTitle: "Vidimo se",
      category: "nightlife",
    },
    {
      caption: "Filmska projekcija večeras. Junak kaže: “Nikada više”.",
      rejectedTitle: "Nikada više",
      category: "arts & culture",
    },
    {
      caption: "Izložba umetnika. Moto večeri je “Make art not war”.",
      rejectedTitle: "Make art not war",
      category: "arts & culture",
    },
    {
      caption: "Kod za popust je “SUMMER20” (2026).",
      rejectedTitle: "SUMMER20",
      category: "nightlife",
    },
  ]) {
    const result = prepareQuotedFixture(negativeCaption, category);
    assert.notEqual(
      result.event.title,
      rejectedTitle,
      `Quoted promotional or dialogue text must not become the event title: ${rejectedTitle}`,
    );
  }

  const multipleQuoteResult = prepareQuotedFixture(
    [
      "Organizatori poručuju: “Vidimo se!”",
      "Večeras gledamo “Battle Royale” (2000).",
    ].join("\n"),
    "arts & culture",
  );
  assert.equal(
    multipleQuoteResult.event.title,
    "Battle Royale",
    "The matcher must skip an earlier CTA quote and recover the later year-qualified film title.",
  );

  const directlyLabeledWork = prepareQuotedFixture(
    "Predstava “Hamlet” igra se sledeće nedelje.",
    "arts & culture",
  );
  assert.equal(
    directlyLabeledWork.event.title,
    "Hamlet",
    "A directly labeled cultural work may supply a quoted title even without a release year.",
  );
}

function runNamedRepertoireScheduleDeduplicationQa() {
  const previousDateNow = Date.now;
  Date.now = () => new Date("2026-07-18T10:00:00.000Z").getTime();
  const caption = [
    "ŠEKSPIR FEST 2.0",
    "",
    "MLETAČKI TRGOVAC",
    "Režija: Strahinja Padežanin",
    "Premijera: 15. avgust u 21 č",
    "Naredna igranja:",
    "16, 19, 21. i 25. avgust",
    "3. septermbar",
    "10. oktobar",
    "",
    "BURA",
    "Režija: Vanja Vodeničarević",
    "Premijera: 22. avgust u 21 č",
    "Naredna igranja:",
    "23, 26. i 28. avgust",
    "1. i 10. septermbar",
    "11. oktobar",
    "",
    "CRNA DAMA IZ SONETA",
    "Režija: Anisja Gavrilović",
    "Premijera: 29. avgust u 21 č",
    "Naredna igranja:",
    "31. avgust",
    "2, 4, 8. i 17. septermbar",
    "12. oktobar",
    "",
    "VESELE ŽENE VINDZORSKE",
    "Režija: Ljubiša Ristić",
    "Premijera: 5. sdeptembar u 21 č",
    "Naredna igranja:",
    "6, 9, 11, 15. i 24. septermbar",
    "13. oktobar",
    "",
    "ROMEO I JULIJA",
    "Režija: Strahinja Padežanin",
    "Premijera: 13. septembar u 21 č",
    "Naredna igranja:",
    "16, 18. i 22. septermbar",
    "1. i 14. oktobar",
    "",
    "KROĆENJE GOROPADI",
    "Režija: Vanja Vodeničarević",
    "Premijera: 20. septembar u 21 č",
    "Naredna igranja:",
    "21, 23, 25. i 29. septermbar",
    "8. i 15. oktobar",
  ].join("\n");
  const plays = [
    ["MLETAČKI TRGOVAC", ["2026-08-15", "2026-08-16", "2026-08-19", "2026-08-21", "2026-08-25", "2026-09-03", "2026-10-10"]],
    ["BURA", ["2026-08-22", "2026-08-23", "2026-08-26", "2026-08-28", "2026-09-01", "2026-09-10", "2026-10-11"]],
    ["CRNA DAMA IZ SONETA", ["2026-08-29", "2026-08-31", "2026-09-02", "2026-09-04", "2026-09-08", "2026-09-17", "2026-10-12"]],
    ["VESELE ŽENE VINDZORSKE", ["2026-09-05", "2026-09-06", "2026-09-09", "2026-09-11", "2026-09-15", "2026-09-24", "2026-10-13"]],
    ["ROMEO I JULIJA", ["2026-09-13", "2026-09-16", "2026-09-18", "2026-09-22", "2026-10-01", "2026-10-14"]],
    ["KROĆENJE GOROPADI", ["2026-09-20", "2026-09-21", "2026-09-23", "2026-09-25", "2026-09-29", "2026-10-08", "2026-10-15"]],
  ];
  const scheduleEntries = plays.flatMap(([title, dates]) =>
    dates.map((date) => ({
      title,
      date,
      time: "21:00",
      artists: [],
      description: `Predstava ${title}`,
      source_text: date,
    })),
  );
  const expectedKeys = new Set(
    plays.flatMap(([title, dates]) => dates.map((date) => `${title}::${date}`)),
  );
  const prepared = prepareEventsForInsert(
    makeInstagramPost({
      caption,
      postType: "image",
      username: "kpgteatar",
      postedAt: "2026-07-17T12:00:00.000Z",
    }),
    makeExtractedEvent({
      title: "Šekspir Fest 2.0",
      date: "",
      time: "21:00",
      venue: "KPGT",
      artists: [],
      category: "arts & culture",
      source_caption: caption,
      schedule_entries: scheduleEntries,
    }),
    "https://cdn.example.com/kpgt-schedule.jpg",
    {},
    {},
    {},
  );
  Date.now = previousDateNow;
  const events = prepared.filter((result) => result.kind === "ok").map((result) => result.event);
  const actualKeys = new Set(events.map((event) => `${event.title}::${event.date}`));
  if (events.length !== expectedKeys.size) {
    console.error(JSON.stringify({
      missing: [...expectedKeys].filter((key) => !actualKeys.has(key)),
      unexpected: [...actualKeys].filter((key) => !expectedKeys.has(key)),
    }));
  }
  assert.equal(
    events.length,
    expectedKeys.size,
    "Caption helper text and date-list fragments must not create extra schedule events when model rows already cover the repertoire.",
  );
  assert.deepEqual(
    new Set(events.map((event) => `${event.title}::${event.date}`)),
    expectedKeys,
  );
  assert.ok(
    events.every((event) => !/^(?:premijera|naredna igranja|\d)/iu.test(event.title)),
    "Schedule headings and numeric date-list fragments must never become event titles.",
  );
}

function runAtomicDuplicateStatusPreconditionQa() {
  const approvalPublicFields = {
    title: "Grounded QA Event",
    date: "2026-07-30",
    time: TBD_EVENT_TIME,
    venue: "QA Venue",
    artists: ["QA Artist"],
    imageUrl: "https://example.com/grounded-qa-event.jpg",
    sourceCaption: "Grounded QA Event 30. jul @ QA Venue uz QA Artist",
  };
  const completeSourceGroundedApproval = JSON.stringify({
    title: approvalPublicFields.title,
    time: approvalPublicFields.time,
    artists: approvalPublicFields.artists,
    postAltText: null,
    sourceGroundingVersion: 2,
    sourceGroundingEvidence: "instagram_caption_or_alt_text",
    sourceGroundingVerified: true,
    sourceGroundingTitleVerified: true,
    sourceGroundingDateVerified: true,
    sourceGroundingIdentityVerified: true,
    sourceGroundingIdentityContextVerified: true,
    sourceGroundingTimeVerified: null,
    sourceGroundingArtistsVerified: true,
    sourceGroundingRowVerified: true,
    moderationAutoApproved: true,
    moderationAutoApproveRule: "source_grounded_core_event_fields",
    moderationPendingReasons: [],
    moderationSignals: ["time_tbd"],
    moderationConfidenceScore: 0.95,
    normalizedDate: "2026-07-30",
    normalizedVenue: "QA Venue",
    normalizedIsValid: true,
    titleUsedFallback: false,
    dateSuspiciousYear: false,
    dateConfidence: "high",
    missingImage: false,
    moderationAllowMissingImage: false,
  });
  assert.doesNotThrow(() => assertExpectedEventStatus("pending", "pending"));
  assert.doesNotThrow(() => assertExpectedEventStatus("approved", "approved"));
  assert.throws(
    () => assertExpectedEventStatus("approved", "pending"),
    /Event status changed during update/,
    "A moderator approval racing ingestion must abort the stale machine update.",
  );

  assert.doesNotThrow(() => assertServiceCreateEventPolicy("pending"));
  assert.throws(
    () => assertServiceCreateEventPolicy("approved"),
    /cannot approve an event/,
    "A service-authenticated create must not publish without complete source grounding.",
  );
  assert.throws(
    () =>
      assertServiceCreateEventPolicy(
        "approved",
        JSON.stringify({ sourceGroundingVerified: true }),
      ),
    /cannot approve an event/,
    "A stale aggregate grounding boolean must not authorize publication.",
  );
  assert.doesNotThrow(() =>
    assertServiceCreateEventPolicy(
      "approved",
      completeSourceGroundedApproval,
      approvalPublicFields,
    ),
  );
  assert.throws(
    () => assertServiceUpdateEventPolicy("pending", { status: "approved" }),
    /cannot approve an event/,
    "A service-authenticated update must not publish without complete source grounding.",
  );
  assert.doesNotThrow(() =>
    assertServiceUpdateEventPolicy(
      "pending",
      {
        status: "approved",
        normalizedFieldsJson: completeSourceGroundedApproval,
      },
      approvalPublicFields,
    ),
  );
  assert.throws(
    () =>
      assertServiceUpdateEventPolicy(
        "rejected",
        {
          status: "approved",
          normalizedFieldsJson: completeSourceGroundedApproval,
        },
        approvalPublicFields,
      ),
    /cannot approve an event/,
    "A service replay must not override a human rejection.",
  );
  assert.throws(
    () =>
      assertServiceUpdateEventPolicy(
        "pending",
        {
          status: "approved",
          normalizedFieldsJson: JSON.stringify({
            ...JSON.parse(completeSourceGroundedApproval),
            moderationPendingReasons: ["non_event_closure_notice"],
          }),
        },
        approvalPublicFields,
      ),
    /cannot approve an event/,
    "Any persisted moderation blocker must keep a service proposal pending.",
  );
  assert.throws(
    () =>
      assertServiceCreateEventPolicy(
        "approved",
        JSON.stringify({
          ...JSON.parse(completeSourceGroundedApproval),
          moderationSignals: ["time_tbd", "future_unknown_blocker"],
        }),
        approvalPublicFields,
      ),
    /cannot approve an event/,
    "Unknown moderation signals must fail closed.",
  );
  for (const [field, mismatchedValue] of [
    ["title", "MODEL-ONLY TITLE"],
    ["date", "2099-12-31"],
    ["time", "23:59"],
    ["venue", "DIFFERENT MODEL VENUE"],
    ["artists", ["MODEL-ONLY ARTIST"]],
  ]) {
    assert.throws(
      () =>
        assertServiceCreateEventPolicy(
          "approved",
          completeSourceGroundedApproval,
          { ...approvalPublicFields, [field]: mismatchedValue },
        ),
      /cannot approve an event/,
      `An attestation for different ${field} fields must not authorize publication.`,
    );
  }
  assert.throws(
    () =>
      assertServiceUpdateEventPolicy(
        "pending",
        {
          status: "approved",
          normalizedFieldsJson: completeSourceGroundedApproval,
          title: "MODEL-ONLY TITLE",
          date: "2099-12-31",
          time: "23:59",
          venue: "DIFFERENT MODEL VENUE",
          artists: ["MODEL-ONLY ARTIST"],
        },
        approvalPublicFields,
      ),
    /cannot approve an event/,
    "A valid attestation for another event must not authorize a mismatched merged update.",
  );
  assert.throws(
    () =>
      assertServiceCreateEventPolicy(
        "approved",
        JSON.stringify({
          ...JSON.parse(completeSourceGroundedApproval),
          artists: [],
          sourceGroundingArtistsVerified: null,
        }),
        approvalPublicFields,
      ),
    /cannot approve an event/,
    "Null artist grounding must not authorize nonempty public artists.",
  );
  assert.throws(
    () => assertServiceUpdateEventPolicy("approved", {}),
    /must demote an approved event/,
    "Even an empty service patch must not update an approved row's updatedAt timestamp.",
  );
  assert.throws(
    () => assertServiceUpdateEventPolicy("approved", { title: "MODEL HALLUCINATION" }),
    /must demote an approved event/,
    "A service may not change an approved event's public fields in place.",
  );
  assert.throws(
    () => assertServiceUpdateEventPolicy("approved", { sourceCaption: "UNREVIEWED MACHINE TEXT" }),
    /must demote an approved event/,
    "A service may not replace a publicly displayed caption on an approved event.",
  );
  assert.throws(
    () =>
      assertServiceUpdateEventPolicy("approved", {
        normalizedFieldsJson: JSON.stringify({ checked: true }),
      }),
    /must demote an approved event/,
    "Service metadata updates must also demote approved rows so future fields fail closed.",
  );
  assert.doesNotThrow(() =>
    assertServiceUpdateEventPolicy("approved", {
      status: "pending",
      title: "Needs renewed human review",
    }),
  );
}

async function runServiceApprovalMutationBoundaryQa() {
  const previousCronSecret = process.env.CRON_SECRET;
  const serviceSecret = "qa-service-approval-boundary-secret";
  process.env.CRON_SECRET = serviceSecret;

  const normalizedFieldsJson = JSON.stringify({
    title: "Grounded Handler Event",
    time: TBD_EVENT_TIME,
    artists: ["Grounded Handler Artist"],
    postAltText: null,
    sourceGroundingVersion: 2,
    sourceGroundingEvidence: "instagram_caption_or_alt_text",
    sourceGroundingVerified: true,
    sourceGroundingTitleVerified: true,
    sourceGroundingDateVerified: true,
    sourceGroundingIdentityVerified: true,
    sourceGroundingIdentityContextVerified: true,
    sourceGroundingTimeVerified: null,
    sourceGroundingArtistsVerified: true,
    sourceGroundingRowVerified: true,
    moderationAutoApproved: true,
    moderationAutoApproveRule: "source_grounded_core_event_fields",
    moderationPendingReasons: [],
    moderationSignals: ["time_tbd"],
    moderationConfidenceScore: 0.95,
    normalizedDate: "2026-07-30",
    normalizedVenue: "Grounded Handler Venue",
    normalizedIsValid: true,
    titleUsedFallback: false,
    dateSuspiciousYear: false,
    dateConfidence: "high",
    missingImage: false,
    moderationAllowMissingImage: false,
  });
  const groundedPublicFields = {
    title: "Grounded Handler Event",
    date: "2026-07-30",
    time: TBD_EVENT_TIME,
    venue: "Grounded Handler Venue",
    artists: ["Grounded Handler Artist"],
    imageUrl: "https://example.com/grounded-handler-event.jpg",
    sourceCaption:
      "Grounded Handler Event 30. jul @ Grounded Handler Venue uz Grounded Handler Artist",
    instagramPostUrl: "https://www.instagram.com/p/qa-handler-boundary/",
    instagramPostId: "qa-handler-boundary",
    eventType: "nightlife",
    status: "approved",
    normalizedFieldsJson,
  };
  let inserted = false;
  let patched = false;
  const fakeDb = {
    get: async () => ({
      _id: "qa-existing-event",
      ...groundedPublicFields,
      status: "pending",
    }),
    insert: async () => {
      inserted = true;
      return "qa-created-event";
    },
    patch: async () => {
      patched = true;
    },
    query: () => ({
      withIndex: () => ({ first: async () => null }),
    }),
  };
  const ctx = {
    auth: { getUserIdentity: async () => null },
    db: fakeDb,
  };

  try {
    await assert.rejects(
      () =>
        createEvent._handler(ctx, {
          ...groundedPublicFields,
          title: "MODEL-ONLY TITLE",
          date: "2099-12-31",
          time: "23:59",
          venue: "DIFFERENT MODEL VENUE",
          artists: ["MODEL-ONLY ARTIST"],
          serviceSecret,
        }),
      /bound to the public fields/,
      "The real create mutation must reject an attestation for different public fields.",
    );
    assert.equal(inserted, false);

    await assert.rejects(
      () =>
        updateEvent._handler(ctx, {
          id: "qa-existing-event",
          expectedStatus: "pending",
          serviceSecret,
          patch: {
            status: "approved",
            normalizedFieldsJson,
            title: "MODEL-ONLY TITLE",
          },
        }),
      /bound to the public fields/,
      "The real update mutation must reject a mismatched merged payload.",
    );
    assert.equal(patched, false);
  } finally {
    if (previousCronSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = previousCronSecret;
    }
  }
}

runPromptQa();
runVenueQa();
runArtistAndDescriptionQa();
runConfidenceQa();
runVideoModerationQa();
runUnverifiedPosterScheduleModerationQa();
runHashtagOnlyScheduleIdentityQa();
runSourceGroundingAdversarialQa();
runMaintenancePromotionGroundingQa();
runHallucinatedPhotoScheduleGroundingQa();
runCaptionDateRangeQa();
runNumericCaptionDatePrecedenceQa();
runSerbianRelativeDateQa();
runDescriptionStartTimeQa();
runQuotedCaptionTitleQa();
runScheduleConsistencyQa();
runTicketPriceQa();
runNamedRepertoireScheduleDeduplicationQa();
runAtomicDuplicateStatusPreconditionQa();
await runServiceApprovalMutationBoundaryQa();

console.log("QA passed: extraction prompt, venue standardization, artists, description, video moderation, source-grounded auto-approval, fail-closed review gating, service mutation payload binding, atomic duplicate status preconditions, caption date ranges, Serbian relative dates, description start times, schedule consistency, and ticket prices.");
