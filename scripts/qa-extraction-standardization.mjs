import assert from "node:assert/strict";
import { LEGACY_VENUE_ALIAS_SEEDS } from "../lib/config/legacy-venue-alias-seeds.ts";
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
  buildCanonicalVenueAliasesByHandle,
  buildCanonicalVenueLocationsByHandle,
  buildCanonicalVenueNamesByHandle,
  canonicalizeVenueName,
  canonicalizeVenueNameDetailed,
  normalizeExtractedArtists,
  normalizeExtractedDescription,
  normalizeVenueAliases,
  normalizeVenueFromEvidence,
  toSearchableText,
} from "../lib/pipeline/venue-normalization.ts";
import {
  areEventTimesCompatibleForTesting,
  buildDuplicateUpdatePatch,
  buildSourceOccurrenceChildTrackingKeyForTesting,
  buildSourceOccurrenceKeyForTesting,
  bindSourceOccurrenceMetadata,
  createEmptyIngestionSummary,
  evaluateCoreEventSourceGrounding,
  findBestExistingMatchForPreparedEventForTesting,
  getNonEventAutoApprovalBlockers,
  getPosterScheduleAutoApprovalBlockers,
  hasIncompleteAmbiguousCollisionContextForTesting,
  hasIncompleteSourceOccurrenceSetForTesting,
  normalizeEventDate,
  prepareEventsForInsert,
  processIngestionPostWithExtractionForTesting,
  reconcileAmbiguousOccurrenceKeysWithExistingEventsForTesting,
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
  hasTrustedSourceEventAnnouncementAutoApproval,
} from "../lib/events/event-update-precondition.ts";
import { isSensibleEventTitleForApproval } from "../lib/events/event-title-approval.ts";
import { isCaptionSourceCoherentWithEvent } from "../lib/events/event-source-approval.ts";
import { buildBackfillDecision } from "./backfill-moderation-scores.mjs";
import { buildPatch as buildTbdRepairPatch } from "./repair-event-tbd-times.mjs";
import {
  buildPatch as buildScheduleRepairPatch,
  buildSafeUpdatePatch as buildSafeScheduleUpdatePatch,
} from "./repair-event-schedule-entries.mjs";
import { buildRepair as buildConsistencyRepair } from "./repair-event-consistency.mjs";
import { chooseAction as chooseEventQualityAction } from "./audit-event-quality.mjs";
import { markModelDerivedRepairPending } from "./source-grounding-guard.mjs";
import {
  createEvent,
  getInstagramSourceOccurrenceReceipt,
  mergeApprovedEvents,
  reconcileInstagramSourceOccurrenceReceipt,
  reprocessPendingSourceGroundingBatch,
  recordInstagramSourceOccurrenceSatisfaction,
  setEventStatus,
  updateSourceOccurrenceExpectedCount,
  updateEvent,
  updateEventAndRecordInstagramSourceOccurrenceSatisfaction,
} from "../convex/events.ts";
import { recordProcessingResult } from "../convex/scrapedPosts.ts";
import { adaptInstagramScrapedPostToSourceDocument } from "../lib/domain/source-documents.ts";
import { buildInstagramSourceOccurrenceFingerprint } from "../lib/domain/occurrences/source-fingerprint.ts";

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
    postId: "qa-post",
    caption: "",
    altText: null,
    imageUrl: null,
    imageUrls: [],
    postType: "video",
    locationName: null,
    instagramPostUrl: "https://www.instagram.com/p/qa-post/",
    postedAt: new Date(Date.now()).toISOString(),
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
  const date = isoDateDaysFromNow(7);
  return {
    // Most fixtures in this long-running regression suite exercise the legacy
    // deterministic grounding paths. Dedicated event_evidence_v2 fixtures
    // override this value and carry source-bound evidence below.
    extraction_contract_version: "legacy_qa_fixture_v1",
    is_event: true,
    non_event_reason: "",
    title: "QA Event",
    date,
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
    date_evidence: {
      exact_text: date,
      source: "caption",
      is_relative: false,
      resolved_date: date,
    },
    time_evidence: {
      status: "start_time_stated",
      exact_text: "21:00",
      source: "caption",
    },
    source_conflicts: [],
    shared_schedule_context: {
      venue: {
        applies_to_all: false,
        value: "",
        evidence: "",
        source: "unknown",
      },
      time: {
        applies_to_all: false,
        value: "",
        evidence: "",
        source: "unknown",
      },
    },
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
    /is_event" to false for closures/i,
    "Prompt must classify closures explicitly as non-events.",
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
    /A lineup member or DJ set inside one occurrence is not a separate event/i,
    "Prompt must consolidate performer slots inside one real occurrence.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /one overall event window.*ONE schedule entry/is,
    "Prompt must bind a consolidated lineup to its overall event window.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /continuous same-night sequence.*after midnight.*earliest explicit event\/segment start/is,
    "Prompt must keep a later after-midnight act inside the same event without inventing its handoff time.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /except that a consolidated one-event running order may include its performer-slot times/i,
    "Prompt must permit factual slot times only in a consolidated running order.",
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
    /schedule row with no event title or billed act.*same row.*exact readable date.*specific physical venue name or a clear event-kind phrase/is,
    "Prompt must retain only source-grounded unnamed schedule rows for deterministic fallback handling.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /Keep "title" empty and "artists" \[\].*Omit every other unnamed row/is,
    "Prompt must keep qualifying unnamed rows blank and omit ungrounded ones.",
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
    instagramSourceRole: "venue",
    instagramSourceName: "KC Grad",
    sourceImageUrl: "https://cdn.example.com/poster.jpg",
  });

  assert.match(userPrompt, /Instagram location tag: KC Grad/);
  assert.match(userPrompt, /Canonical venue hint: KC Grad/);
  assert.match(userPrompt, /Instagram source role: venue/);
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /use that canonical venue for every event and schedule row/i,
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /Never use a promoter or organizer account name as the venue/i,
  );
  assert.match(userPrompt, /Instagram source\/account name: KC Grad/);
  assert.match(userPrompt, /Instagram alt text:/);
  assert.match(userPrompt, /schedule_entries/i);
  assert.match(EVENT_EXTRACTION_SYSTEM_PROMPT, /promoter-role account name identifies the organizer/i);
  assert.match(EVENT_EXTRACTION_SYSTEM_PROMPT, /Preserve an explicitly billed Instagram artist handle/i);
  assert.match(EVENT_EXTRACTION_SYSTEM_PROMPT, /minor connector-word difference/i);
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /poster and caption as complementary primary evidence/i,
    "Prompt must combine non-conflicting caption and poster evidence without a caption-first bias.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /physical venue always beats.*promoter.*ticket brand/i,
    "Prompt must prefer a printed physical venue over promoter and ticketing identities.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /locative ending.*Stazi.*Staza.*not an event title/i,
    "Prompt must normalize Serbian locative venue evidence instead of turning it into a title.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /exact street address.*last-resort venue label/i,
    "Prompt must retain an exact occurrence address when no venue name is available.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /Preserve the full legible lineup/i,
    "Prompt must keep every readable performer from a single-event poster.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /"19H - 01H" → "19:00-01:00"/i,
    "Prompt must show how to normalize the reported cross-midnight poster range.",
  );
}

function runVenueQa() {
  // Model the post-migration resolver directory: compatibility seeds are
  // persisted as durable venue identities before runtime stops consulting the
  // seed file directly.
  const canonicalVenues = [
    { name: "Drugstore", instagramHandle: "drugstore_beograd" },
    { name: "Zappa Baza", instagramHandle: "zappabaza" },
    { name: "Kulturni centar GRAD", instagramHandle: "kcgrad" },
    { name: "Silosi Beograd ••••IIII Dom kulture", instagramHandle: "silosibeograd" },
    { name: "Art space in Belgrade, Serbia", instagramHandle: "kvaka22_catch22" },
    { name: "Chillton - Чилтон", instagramHandle: "chillton_chillton" },
    { name: "Chillton Bašta", instagramHandle: "chillton_bashta" },
    { name: "Dub Gastro Pub", instagramHandle: "dubgastropub" },
    {
      name: "Klub Studenata Tehnike KST",
      instagramHandle: "klubstudenatatehnike",
    },
    { name: "Freestyler", instagramHandle: "freestylerbelgrade_official" },
    { name: "Kolarac", instagramHandle: "kolarac_art_bioskop" },
    { name: "Sinnerman Jazz Club", instagramHandle: "sinnermanjazzclub" },
    { name: "Beton Club & Event Center", instagramHandle: "betonbelgrade" },
    { name: "Nula pet _0.5", instagramHandle: "nulapet_0.5" },
    { name: "Muzej Jugoslavije", instagramHandle: "muzej_jugoslavije" },
    { name: "Кафе Шупа", instagramHandle: "kafesupa" },
    { name: "Muzej grada Beograda", instagramHandle: "muzejgradabeograda" },
    {
      name: "Novi Bioskop Zvezda",
      instagramHandle: "novi_bioskop_zvezda",
      aliases: ["New Cinema Zvezda"],
    },
    { name: "ica", instagramHandle: "icketa" },
    {
      name: "La Variete",
      instagramHandle: "lavariete.belgrade",
      location: "Francuska 6",
    },
  ].map((venue) => {
    const seed = LEGACY_VENUE_ALIAS_SEEDS.find(
      (candidate) => candidate.canonicalHandle === venue.instagramHandle,
    );
    return {
      ...venue,
      aliases: [...new Set([...(venue.aliases ?? []), ...(seed?.aliases ?? [])])],
    };
  });
  const canonicalVenueNamesByHandle = buildCanonicalVenueNamesByHandle(canonicalVenues);
  const canonicalVenueAliasesByHandle = buildCanonicalVenueAliasesByHandle(canonicalVenues);
  const canonicalVenueLocationsByHandle =
    buildCanonicalVenueLocationsByHandle(canonicalVenues);
  assert.equal(canonicalVenueLocationsByHandle["lavariete.belgrade"], "Francuska 6");
  const venueNameOverridesByHandle = {
    kcgrad: "KC Grad",
    silosibeograd: "Silosi",
    kvaka22_catch22: "Kvaka 22",
    chillton_chillton: "Chillton",
    chillton_bashta: "Chillton Bašta",
    dubgastropub: "Dub Gastro Pub",
    klubstudenatatehnike: "Klub Studenata Tehnike KST",
    freestylerbelgrade_official: "Freestyler",
    kolarac_art_bioskop: "Kolarac",
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

  for (const [handle, expectedVenue] of [
    ["chillton_chillton", "Chillton"],
    ["chillton_bashta", "Chillton Bašta"],
    ["dubgastropub", "Dub Gastro Pub"],
    ["klubstudenatatehnike", "Klub Studenata Tehnike KST"],
    ["freestylerbelgrade_official", "Freestyler"],
    ["kolarac_art_bioskop", "Kolarac"],
  ]) {
    const requestedHandleMapping = normalizeVenueFromEvidence({
      handle,
      rawModelVenue: "",
      locationName: "",
      canonicalVenueNamesByHandle,
      handleVenueNamesByHandle: venueNameOverridesByHandle,
      staticVenueByHandle: STATIC_VENUE_BY_HANDLE,
    });
    assert.equal(requestedHandleMapping.venue, expectedVenue);
    assert.equal(requestedHandleMapping.source, "handle_map");
  }

  const promoterCannotBecomeVenueFromPostingHandle = normalizeVenueFromEvidence({
    handle: "kcgrad",
    rawModelVenue: "",
    locationName: "",
    canonicalVenueNamesByHandle,
    handleVenueNamesByHandle: venueNameOverridesByHandle,
    staticVenueByHandle: STATIC_VENUE_BY_HANDLE,
    allowCanonicalHandleFallback: false,
  });
  assert.equal(promoterCannotBecomeVenueFromPostingHandle.venue, null);
  assert.equal(promoterCannotBecomeVenueFromPostingHandle.source, null);

  const legacyPromoterVenueMap = {
    ...venueNameOverridesByHandle,
    "1by1.party": "JEDNA PO JEDNA",
  };
  const canonicalAtHandleVenue = normalizeVenueFromEvidence({
    handle: "1by1.party",
    rawModelVenue: "JEDNA PO JEDNA",
    locationName: "",
    immutableEvidenceTexts: [
      "Organizuje @1by1.party; vidimo se sutra od 20h @kcgrad",
    ],
    canonicalVenueNamesByHandle,
    handleVenueNamesByHandle: legacyPromoterVenueMap,
    staticVenueByHandle: STATIC_VENUE_BY_HANDLE,
  });
  assert.equal(canonicalAtHandleVenue.venue, "KC Grad");
  assert.equal(canonicalAtHandleVenue.source, "evidence_handle");
  assert.equal(canonicalAtHandleVenue.evidenceHandle, "kcgrad");

  for (const evidence of ["at @kcgrad", "vidimo se @kcgrad", "venue @kcgrad"]) {
    const immediateLocativeHandleVenue = normalizeVenueFromEvidence({
      handle: "silosibeograd",
      rawModelVenue: "Silosi",
      locationName: "",
      immutableEvidenceTexts: [evidence],
      canonicalVenueNamesByHandle,
      handleVenueNamesByHandle: venueNameOverridesByHandle,
      staticVenueByHandle: STATIC_VENUE_BY_HANDLE,
    });
    assert.equal(
      immediateLocativeHandleVenue.venue,
      "KC Grad",
      `Expected immediate locative evidence '${evidence}' to override the posting venue.`,
    );
    assert.equal(immediateLocativeHandleVenue.source, "evidence_handle");
  }

  const canonicalHashtagVenue = normalizeVenueFromEvidence({
    handle: "1by1.party",
    rawModelVenue: "JEDNA PO JEDNA",
    locationName: "",
    immutableEvidenceTexts: ["Poster: #kcgrad"],
    canonicalVenueNamesByHandle,
    handleVenueNamesByHandle: { kcgrad: "KC Grad" },
    staticVenueByHandle: STATIC_VENUE_BY_HANDLE,
  });
  assert.equal(canonicalHashtagVenue.venue, "KC Grad");
  assert.equal(canonicalHashtagVenue.source, "evidence_handle");

  const ambiguousCanonicalHandles = normalizeVenueFromEvidence({
    handle: "1by1.party",
    rawModelVenue: "KC Grad",
    locationName: "KC Grad",
    immutableEvidenceTexts: ["Program: @kcgrad i @silosibeograd"],
    canonicalVenueNamesByHandle,
    handleVenueNamesByHandle: legacyPromoterVenueMap,
    staticVenueByHandle: STATIC_VENUE_BY_HANDLE,
    allowCanonicalHandleFallback: false,
  });
  assert.equal(
    ambiguousCanonicalHandles.venue,
    "KC Grad",
    "Ambiguous handle tags must fall through to consistent explicit venue evidence.",
  );
  assert.equal(ambiguousCanonicalHandles.source, "location_name");

  const venueAccountCasualCollaboratorTag = normalizeVenueFromEvidence({
    handle: "kcgrad",
    rawModelVenue: "KC Grad",
    locationName: "",
    immutableEvidenceTexts: ["Hvala @silosibeograd na podršci programu."],
    canonicalVenueNamesByHandle,
    handleVenueNamesByHandle: { kcgrad: "KC Grad" },
    staticVenueByHandle: STATIC_VENUE_BY_HANDLE,
  });
  assert.equal(
    venueAccountCasualCollaboratorTag.venue,
    "KC Grad",
    "A casual tag must not override the configured physical venue account.",
  );
  assert.equal(venueAccountCasualCollaboratorTag.source, "handle_map");

  for (const evidence of [
    "Not at @silosibeograd",
    "Nije u @silosibeograd",
    "Ne u @silosibeograd",
    "Vidimo se u KC Gradu, hvala @silosibeograd na podršci",
    "Vidimo se u KC Gradu hvala @silosibeograd na podršci",
    "Venue KC Grad @silosibeograd",
  ]) {
    const nonLocativeTaggedVenue = normalizeVenueFromEvidence({
      handle: "kcgrad",
      rawModelVenue: "KC Grad",
      locationName: "",
      immutableEvidenceTexts: [evidence],
      canonicalVenueNamesByHandle,
      handleVenueNamesByHandle: venueNameOverridesByHandle,
      staticVenueByHandle: STATIC_VENUE_BY_HANDLE,
    });
    assert.equal(
      nonLocativeTaggedVenue.venue,
      "KC Grad",
      `Expected '${evidence}' not to override the configured physical venue.`,
    );
    assert.equal(nonLocativeTaggedVenue.source, "handle_map");
  }

  const aliasCases = [
    ["Kulturni centar GRAD", "KC Grad"],
    ["KC Grad", "KC Grad"],
    ["KC Gradu", "KC Grad"],
    ["Silosi Beograd ••••IIII Dom kulture", "Silosi"],
    ["Medonosni vrt Silosa", "Silosi"],
    ["Kvaka 22", "Kvaka 22"],
    ["Chillton", "Chillton"],
    ["Chillton Bashta", "Chillton Bašta"],
    ["Dub Gastro", "Dub Gastro Pub"],
    ["KST", "Klub Studenata Tehnike KST"],
    ["Freestyler Belgrade", "Freestyler"],
    ["Art bioskop Kolarac", "Kolarac"],
    ["SinnerMan", "Sinnerman Jazz Club"],
    ["Beton Club", "Beton"],
    ["Pab 0,5", "Nula Pet"],
    ["Bašta Paba Nula Pet", "Nula Pet"],
    ["Amphitheater in front of the Museum of Yugoslav History", "Muzej Jugoslavije"],
    ["Museum of Yugoslavia", "Muzej Jugoslavije"],
    ["Šupa", "Кафе Шупа"],
    ["шупа", "Кафе Шупа"],
    ["Kafe Šupa", "Кафе Шупа"],
    ["Спомен-музеј Иве Андрића", "Muzej grada Beograda"],
    ["Spomen-muzej Ive Andrica", "Muzej grada Beograda"],
  ];
  for (const [input, expected] of aliasCases) {
    const resolved = canonicalizeVenueName(input, canonicalVenueNamesByHandle, {
      canonicalVenueAliasesByHandle,
      handleVenueNamesByHandle: venueNameOverridesByHandle,
    });
    assert.equal(resolved, expected, `Expected venue alias '${input}' to resolve.`);
  }

  const detailedAlias = canonicalizeVenueNameDetailed("Pab 0,5", canonicalVenueNamesByHandle, {
    canonicalVenueAliasesByHandle,
    handleVenueNamesByHandle: venueNameOverridesByHandle,
  });
  assert.equal(detailedAlias?.reason, "alias");
  assert.equal(detailedAlias?.handle, "nulapet_0.5");

  const renamedVenueAlias = canonicalizeVenueNameDetailed(
    "New Cinema Zvezda",
    canonicalVenueNamesByHandle,
    { canonicalVenueAliasesByHandle },
  );
  assert.deepEqual(renamedVenueAlias, {
    venue: "Novi Bioskop Zvezda",
    reason: "alias",
    handle: "novi_bioskop_zvezda",
    matchedVenue: "New Cinema Zvezda",
    matchedAlias: "New Cinema Zvezda",
  });

  const renamedVenueFromModel = normalizeVenueFromEvidence({
    handle: "random_promoter",
    rawModelVenue: "New Cinema Zvezda",
    locationName: "",
    canonicalVenueNamesByHandle,
    canonicalVenueAliasesByHandle,
  });
  assert.equal(renamedVenueFromModel.venue, "Novi Bioskop Zvezda");
  assert.equal(renamedVenueFromModel.source, "model");

  const exactCanonicalNameEvidence = normalizeVenueFromEvidence({
    handle: "qa_promoter_source",
    rawModelVenue: "",
    locationName: "",
    immutableEvidenceTexts: ["Subota, 20h — Muzej Jugoslavije"],
    canonicalVenueNamesByHandle,
    canonicalVenueAliasesByHandle,
    handleVenueNamesByHandle: venueNameOverridesByHandle,
    staticVenueByHandle: STATIC_VENUE_BY_HANDLE,
    allowCanonicalHandleFallback: false,
  });
  assert.equal(exactCanonicalNameEvidence.venue, "Muzej Jugoslavije");
  assert.equal(exactCanonicalNameEvidence.source, "evidence_name");

  for (const [evidence, expectedVenue] of [
    ["Poster venue: Freestyler", "Freestyler"],
    ["Lokacija: Art bioskop Kolarac", "Kolarac"],
  ]) {
    const requestedNameEvidence = normalizeVenueFromEvidence({
      handle: "qa_promoter_source",
      rawModelVenue: "",
      locationName: "",
      immutableEvidenceTexts: [evidence],
      canonicalVenueNamesByHandle,
      canonicalVenueAliasesByHandle,
      handleVenueNamesByHandle: venueNameOverridesByHandle,
      staticVenueByHandle: STATIC_VENUE_BY_HANDLE,
      allowCanonicalHandleFallback: false,
    });
    assert.equal(requestedNameEvidence.venue, expectedVenue);
    assert.equal(requestedNameEvidence.source, "evidence_name");
  }

  const exactAliasEvidence = normalizeVenueFromEvidence({
    handle: "qa_promoter_source",
    rawModelVenue: "",
    locationName: "",
    immutableEvidenceTexts: ["Večeras u KST od 21h"],
    canonicalVenueNamesByHandle,
    canonicalVenueAliasesByHandle,
    handleVenueNamesByHandle: venueNameOverridesByHandle,
    staticVenueByHandle: STATIC_VENUE_BY_HANDLE,
    allowCanonicalHandleFallback: false,
  });
  assert.equal(exactAliasEvidence.venue, "Klub Studenata Tehnike KST");
  assert.equal(exactAliasEvidence.source, "evidence_name");

  const shortAliasWithoutVenueContextRejected = normalizeVenueFromEvidence({
    handle: "qa_promoter_source",
    rawModelVenue: "",
    locationName: "",
    immutableEvidenceTexts: ["KST predstavlja novi singl večeras"],
    canonicalVenueNamesByHandle,
    canonicalVenueAliasesByHandle,
    handleVenueNamesByHandle: venueNameOverridesByHandle,
    staticVenueByHandle: STATIC_VENUE_BY_HANDLE,
    allowCanonicalHandleFallback: false,
  });
  assert.equal(shortAliasWithoutVenueContextRejected.venue, null);
  assert.equal(shortAliasWithoutVenueContextRejected.source, null);

  const exactNamePrecedesPostingHandleFallback = normalizeVenueFromEvidence({
    handle: "freestylerbelgrade_official",
    rawModelVenue: "",
    locationName: "",
    immutableEvidenceTexts: ["Lokacija: Dub Gastro Pub"],
    canonicalVenueNamesByHandle,
    canonicalVenueAliasesByHandle,
    staticVenueByHandle: STATIC_VENUE_BY_HANDLE,
  });
  assert.equal(exactNamePrecedesPostingHandleFallback.venue, "Dub Gastro Pub");
  assert.equal(exactNamePrecedesPostingHandleFallback.source, "evidence_name");

  const specificNestedVenueName = normalizeVenueFromEvidence({
    handle: "qa_promoter_source",
    rawModelVenue: "",
    locationName: "",
    immutableEvidenceTexts: ["Program je u Chillton Bašti."],
    canonicalVenueNamesByHandle,
    canonicalVenueAliasesByHandle,
    handleVenueNamesByHandle: venueNameOverridesByHandle,
    staticVenueByHandle: STATIC_VENUE_BY_HANDLE,
    allowCanonicalHandleFallback: false,
  });
  assert.equal(specificNestedVenueName.venue, "Chillton Bašta");
  assert.equal(specificNestedVenueName.source, "evidence_name");

  const explicitVenuePrecedesImmutableNameEvidence = normalizeVenueFromEvidence({
    handle: "qa_promoter_source",
    rawModelVenue: "Muzej Jugoslavije",
    locationName: "",
    immutableEvidenceTexts: ["Afterparty: Dub Gastro Pub"],
    canonicalVenueNamesByHandle,
    canonicalVenueAliasesByHandle,
    handleVenueNamesByHandle: venueNameOverridesByHandle,
    staticVenueByHandle: STATIC_VENUE_BY_HANDLE,
    allowCanonicalHandleFallback: false,
  });
  assert.equal(
    explicitVenuePrecedesImmutableNameEvidence.venue,
    "Muzej Jugoslavije",
  );
  assert.equal(explicitVenuePrecedesImmutableNameEvidence.source, "model");

  const fuzzyPostingProfileNameRejected = normalizeVenueFromEvidence({
    handle: "dubgastropub_events",
    rawModelVenue: "",
    locationName: "",
    immutableEvidenceTexts: [],
    canonicalVenueNamesByHandle,
    canonicalVenueAliasesByHandle,
    handleVenueNamesByHandle: venueNameOverridesByHandle,
    staticVenueByHandle: STATIC_VENUE_BY_HANDLE,
    allowCanonicalHandleFallback: false,
  });
  assert.equal(fuzzyPostingProfileNameRejected.venue, null);
  assert.equal(fuzzyPostingProfileNameRejected.source, null);

  const nonCanonicalProfileMentionRejected = normalizeVenueFromEvidence({
    handle: "qa_promoter_source",
    rawModelVenue: "",
    locationName: "",
    immutableEvidenceTexts: [
      "Follow @freestyler and https://instagram.com/freestyler for updates",
    ],
    canonicalVenueNamesByHandle,
    canonicalVenueAliasesByHandle,
    handleVenueNamesByHandle: venueNameOverridesByHandle,
    staticVenueByHandle: STATIC_VENUE_BY_HANDLE,
    allowCanonicalHandleFallback: false,
  });
  assert.equal(nonCanonicalProfileMentionRejected.venue, null);
  assert.equal(nonCanonicalProfileMentionRejected.source, null);

  const ambiguousNameEvidence = normalizeVenueFromEvidence({
    handle: "qa_promoter_source",
    rawModelVenue: "",
    locationName: "",
    immutableEvidenceTexts: ["Shared Hall"],
    canonicalVenueNamesByHandle: {
      "venue.one": "Venue One",
      "venue.two": "Venue Two",
    },
    canonicalVenueAliasesByHandle: {
      "venue.one": ["Shared Hall"],
      "venue.two": ["Shared Hall"],
    },
    allowCanonicalHandleFallback: false,
  });
  assert.equal(ambiguousNameEvidence.venue, null);
  assert.equal(ambiguousNameEvidence.source, null);

  for (const evidence of [
    "Dub Gastro Pub / Freestyler",
    "Chillton Bašta program; afterparty at Chillton",
  ]) {
    const multipleVenueNamesRejected = normalizeVenueFromEvidence({
      handle: "qa_promoter_source",
      rawModelVenue: "",
      locationName: "",
      immutableEvidenceTexts: [evidence],
      canonicalVenueNamesByHandle,
      canonicalVenueAliasesByHandle,
      handleVenueNamesByHandle: venueNameOverridesByHandle,
      staticVenueByHandle: STATIC_VENUE_BY_HANDLE,
      allowCanonicalHandleFallback: false,
    });
    assert.equal(
      multipleVenueNamesRejected.venue,
      null,
      `Expected multi-venue evidence '${evidence}' to fail closed.`,
    );
    assert.equal(multipleVenueNamesRejected.source, null);
  }

  assert.equal(
    canonicalizeVenueName(
      "Shared Hall",
      { "venue.one": "Venue One", "venue.two": "Venue Two" },
      {
        canonicalVenueAliasesByHandle: {
          "venue.one": ["Shared Hall"],
          "venue.two": ["Shared Hall"],
        },
      },
    ),
    null,
    "Ambiguous aliases must fail closed instead of using insertion order.",
  );
  assert.deepEqual(
    normalizeVenueAliases([" New Cinema   Zvezda ", "new cinema zvezda"]),
    ["New Cinema Zvezda"],
  );

  const promoterAliasDate = isoDateDaysFromNow(8);
  const promoterAliasCaption = [
    "QA Promoter Screening",
    promoterAliasDate,
    "21:00",
    "New Cinema Zvezda",
  ].join(" | ");
  const [promoterAliasPrepared] = prepareEventsForInsert(
    makeInstagramPost({
      caption: promoterAliasCaption,
      imageUrl: "https://images.example.com/promoter-alias.jpg",
      imageUrls: ["https://images.example.com/promoter-alias.jpg"],
      postType: "image",
      username: "qa_promoter_source",
    }),
    makeExtractedEvent({
      title: "QA Promoter Screening",
      date: promoterAliasDate,
      venue: "New Cinema Zvezda",
      source_caption: promoterAliasCaption,
      date_evidence: {
        exact_text: promoterAliasDate,
        source: "caption",
        is_relative: false,
        resolved_date: promoterAliasDate,
      },
      field_confirmation: {
        ...makeFieldConfirmation(0.95),
        location_name: {
          confidence: 0.95,
          found_in: ["caption"],
          evidence: "New Cinema Zvezda",
          evidence_snippets: [
            { source: "caption", text: "New Cinema Zvezda" },
          ],
          notes: "Exact learned venue alias in a promoter caption.",
        },
      },
    }),
    "https://images.example.com/promoter-alias.jpg",
    canonicalVenueNamesByHandle,
    {},
    {},
    {
      canonicalVenueAliasesByHandle,
      sourceRolesByHandle: { qa_promoter_source: "promoter" },
    },
  );
  assert.equal(promoterAliasPrepared.kind, "ok");
  assert.equal(
    promoterAliasPrepared.event.venue,
    "Novi Bioskop Zvezda",
    "A promoter post must resolve a learned alias from the global venue directory.",
  );

  const promoterHeadingDate = isoDateDaysFromNow(9);
  const promoterHeadingCaption = `FREESTYLER WINTER STAGE / ${promoterHeadingDate} / 23:00`;
  const [promoterHeadingPrepared] = prepareEventsForInsert(
    makeInstagramPost({
      caption: promoterHeadingCaption,
      imageUrl: "https://images.example.com/freestyler-heading.jpg",
      imageUrls: ["https://images.example.com/freestyler-heading.jpg"],
      postType: "image",
      username: "qa_promoter_source",
    }),
    makeExtractedEvent({
      extraction_contract_version: "event_evidence_v2",
      title: "FREESTYLER WINTER STAGE",
      date: promoterHeadingDate,
      time: "23:00",
      venue: "",
      source_caption: promoterHeadingCaption,
      date_evidence: {
        exact_text: promoterHeadingDate,
        source: "caption",
        is_relative: false,
        resolved_date: promoterHeadingDate,
      },
      time_evidence: {
        status: "start_time_stated",
        exact_text: "23:00",
        source: "caption",
      },
      field_confirmation: {
        ...makeFieldConfirmation(0.95),
        location_name: {
          confidence: 0,
          found_in: [],
          evidence: "",
          evidence_snippets: [],
          notes: "Model omitted the embedded venue name.",
        },
      },
    }),
    "https://images.example.com/freestyler-heading.jpg",
    canonicalVenueNamesByHandle,
    venueNameOverridesByHandle,
    venueNameOverridesByHandle,
    {
      canonicalVenueAliasesByHandle,
      sourceRolesByHandle: { qa_promoter_source: "promoter" },
    },
  );
  assert.equal(promoterHeadingPrepared.kind, "ok");
  assert.equal(promoterHeadingPrepared.event.venue, "Freestyler");
  assert.equal(
    JSON.parse(promoterHeadingPrepared.event.normalizedFieldsJson).venueSource,
    "evidence_name",
    "Exact immutable venue-name evidence must survive the downstream grounding gate.",
  );

  const splitVenueDates = [10, 11, 12].map(isoDateDaysFromNow);
  const splitVenueLines = [
    `${splitVenueDates[0]} 21:00 FIRST EVENT — Freestyler`,
    `${splitVenueDates[1]} 22:00 SECOND EVENT — u @dubgastropub`,
    `${splitVenueDates[2]} 20:00 THIRD EVENT`,
  ];
  const splitVenueCaption = splitVenueLines.join("\n");
  const splitVenuePrepared = prepareEventsForInsert(
    makeInstagramPost({
      caption: splitVenueCaption,
      imageUrl: "https://images.example.com/split-row-venues.jpg",
      imageUrls: ["https://images.example.com/split-row-venues.jpg"],
      postId: "qa-split-row-venue-evidence",
      instagramPostUrl:
        "https://www.instagram.com/p/qa-split-row-venue-evidence/",
      postType: "image",
      username: "qa_promoter_source",
    }),
    makeExtractedEvent({
      extraction_contract_version: "event_evidence_v2",
      title: "",
      date: "",
      time: "",
      venue: "",
      artists: [],
      description: "",
      source_caption: splitVenueCaption,
      source_url:
        "https://www.instagram.com/p/qa-split-row-venue-evidence/",
      date_evidence: {
        exact_text: "",
        source: "unknown",
        is_relative: false,
        resolved_date: "",
      },
      time_evidence: {
        status: "not_stated",
        exact_text: "",
        source: "unknown",
      },
      shared_schedule_context: {
        venue: {
          applies_to_all: false,
          value: "",
          evidence: "",
          source: "unknown",
        },
        time: {
          applies_to_all: false,
          value: "",
          evidence: "",
          source: "unknown",
        },
      },
      schedule_entries: splitVenueLines.map((sourceText, index) => ({
        date: splitVenueDates[index],
        time: ["21:00", "22:00", "20:00"][index],
        venue: "",
        title: ["FIRST EVENT", "SECOND EVENT", "THIRD EVENT"][index],
        artists: [],
        description: `Schedule row ${index + 1}.`,
        source_text: sourceText,
        date_evidence: {
          exact_text: splitVenueDates[index],
          source: "caption",
          is_relative: false,
          resolved_date: splitVenueDates[index],
        },
        time_evidence: {
          status: "start_time_stated",
          exact_text: ["21:00", "22:00", "20:00"][index],
          source: "caption",
        },
      })),
      field_confirmation: {
        ...makeFieldConfirmation(0.95),
        location_name: {
          confidence: 0,
          found_in: [],
          evidence: "",
          evidence_snippets: [],
          notes: "Venue evidence is occurrence-local.",
        },
      },
    }),
    "https://images.example.com/split-row-venues.jpg",
    canonicalVenueNamesByHandle,
    venueNameOverridesByHandle,
    venueNameOverridesByHandle,
    {
      canonicalVenueAliasesByHandle,
      sourceRolesByHandle: { qa_promoter_source: "promoter" },
    },
  );
  assert.equal(splitVenuePrepared.length, 3);
  const [nameVenueRow, handleVenueRow, noVenueRow] = splitVenuePrepared;
  for (const row of splitVenuePrepared) assert.equal(row.kind, "ok");
  assert.equal(nameVenueRow.event.venue, "Freestyler");
  assert.equal(nameVenueRow.normalizedFields.venueSource, "evidence_name");
  assert.equal(nameVenueRow.normalizedFields.venueEvidenceVerified, true);
  assert.equal(handleVenueRow.event.venue, "Dub Gastro Pub");
  assert.equal(handleVenueRow.normalizedFields.venueSource, "evidence_handle");
  assert.equal(
    handleVenueRow.normalizedFields.canonicalVenueEvidenceHandle,
    "dubgastropub",
  );
  assert.equal(handleVenueRow.normalizedFields.venueEvidenceVerified, true);
  assert.equal(
    noVenueRow.event.venue,
    "",
    "A canonical venue mentioned by another schedule row must not propagate.",
  );
  assert.equal(noVenueRow.normalizedFields.canonicalVenueEvidenceHandle, null);
  assert.equal(noVenueRow.event.status, "pending");
  assert.ok(
    noVenueRow.normalizedFields.moderationPendingReasons.includes(
      "unscoped_canonical_venue_evidence",
    ),
  );

  const canonicalHandleEventDate = isoDateDaysFromNow(9);
  const canonicalHandleCaption = [
    "Ariana Grande theme party",
    canonicalHandleEventDate,
    "20:00",
    "Lokacija je označena na posteru",
  ].join(" | ");
  const sourceMappedCanonicalVenues = {
    ...canonicalVenueNamesByHandle,
    "1by1.party": "JEDNA PO JEDNA",
  };
  const sourceConfiguredVenueNames = {
    ...sourceMappedCanonicalVenues,
    ...legacyPromoterVenueMap,
  };
  const [canonicalHandlePrepared] = prepareEventsForInsert(
    makeInstagramPost({
      caption: canonicalHandleCaption,
      altText: "Poster text: venue @kcgrad",
      postId: "qa-canonical-venue-handle",
      instagramPostUrl:
        "https://www.instagram.com/p/qa-canonical-venue-handle/",
      username: "1by1.party",
    }),
    makeExtractedEvent({
      extraction_contract_version: "event_evidence_v2",
      title: "Ariana Grande theme party",
      date: canonicalHandleEventDate,
      time: "20:00",
      venue: "JEDNA PO JEDNA",
      artists: [],
      source_caption: canonicalHandleCaption,
      source_url:
        "https://www.instagram.com/p/qa-canonical-venue-handle/",
      date_evidence: {
        exact_text: canonicalHandleEventDate,
        source: "caption",
        is_relative: false,
        resolved_date: canonicalHandleEventDate,
      },
      time_evidence: {
        status: "start_time_stated",
        exact_text: "20:00",
        source: "caption",
      },
      field_confirmation: {
        ...makeFieldConfirmation(0.95),
        title: {
          confidence: 0.95,
          found_in: ["caption"],
          evidence: "Ariana Grande theme party",
          evidence_snippets: [
            { source: "caption", text: "Ariana Grande theme party" },
          ],
          notes: "Exact caption title.",
        },
        location: {
          confidence: 0.95,
          found_in: ["alt_text"],
          evidence: "@kcgrad",
          evidence_snippets: [{ source: "alt_text", text: "@kcgrad" }],
          notes: "Exact canonical venue handle in immutable alt text.",
        },
        location_name: {
          confidence: 0.95,
          found_in: ["alt_text"],
          evidence: "@kcgrad",
          evidence_snippets: [{ source: "alt_text", text: "@kcgrad" }],
          notes: "Exact canonical venue handle in immutable alt text.",
        },
      },
    }),
    null,
    sourceMappedCanonicalVenues,
    {},
    sourceConfiguredVenueNames,
    {
      canonicalVenueAliasesByHandle,
      eventDateFilterNow: new Date(QA_NOW_ISO),
      // This deliberately models the bad legacy classification. Immutable
      // @kcgrad evidence must still outrank the posting-account venue map.
      sourceRolesByHandle: { "1by1.party": "venue" },
    },
  );
  assert.equal(canonicalHandlePrepared.kind, "ok", JSON.stringify(canonicalHandlePrepared));
  assert.equal(canonicalHandlePrepared.event.venue, "KC Grad");
  assert.equal(canonicalHandlePrepared.normalizedFields.venueSource, "evidence_handle");
  assert.equal(canonicalHandlePrepared.normalizedFields.canonicalVenueEvidenceHandle, "kcgrad");
  assert.equal(canonicalHandlePrepared.normalizedFields.venueEvidenceVerified, true);
  assert.equal(canonicalHandlePrepared.normalizedFields.trustedVenueSource, false);
  assert.equal(toSearchableText("šupa"), "supa");
  assert.equal(toSearchableText("шупа"), "supa");
  assert.equal(toSearchableText("ʙᴇʟɢʀᴀᴅᴇ ᴋɪᴛᴄʜᴇɴ ᴘᴀʀᴛʏ"), "belgrade kitchen party");
  assert.equal(toSearchableText("𝗦𝗠𝗣"), "smp");
  assert.equal(toSearchableText("ǫ Ǫ"), "q q");

  const muzejGradaPost = normalizeVenueFromEvidence({
    handle: "muzejgradabeograda",
    rawModelVenue: "Спомен-музеј Иве Андрића",
    locationName: "",
    canonicalVenueAliasesByHandle,
    canonicalVenueNamesByHandle,
    handleVenueNamesByHandle: venueNameOverridesByHandle,
    staticVenueByHandle: STATIC_VENUE_BY_HANDLE,
  });
  assert.equal(muzejGradaPost.venue, "Muzej grada Beograda");
  assert.notEqual(muzejGradaPost.venue, "ica");

  const andricVenue = canonicalizeVenueNameDetailed("Спомен-музеј Иве Андрића", canonicalVenueNamesByHandle, {
    canonicalVenueAliasesByHandle,
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
  assert.equal(
    highConfidenceVideo.event.status,
    "approved",
    JSON.stringify({ event: highConfidenceVideo.event, fields: highConfidenceFields }, null, 2),
  );
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
      {
        canonicalVenueAliasesByHandle: {
          kcgrad: ["KC Grad", "KC Gradu"],
        },
      },
    ),
  );
  const fallbackTitleCoreFieldsNormalized = readPreparedNormalizedFields(fallbackTitleCoreFields);
  assert.equal(fallbackTitleCoreFields.event.status, "pending");
  assert.equal(fallbackTitleCoreFields.event.time, TBD_EVENT_TIME);
  assert.equal(fallbackTitleCoreFieldsNormalized.moderationAutoApproveRule, null);
  assert.deepEqual(fallbackTitleCoreFieldsNormalized.moderationPendingReasons, [
    "requires_human_approval",
    "unverified_core_event_source",
    "unusable_event_title",
    "caption_source_event_mismatch",
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
    "caption_source_event_mismatch",
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
    ["@kaya_ostojic", "Adisskaljo & Puls Bend"],
  );
  assert.deepEqual(lavashEvents[1].artists, ["@adisskaljo", "@puls_bend"]);
  assert.equal(lavashEvents[1].sourceCaption, lavashCaption);

  const safeTimeFirstDate = isoDateDaysFromNow(9);
  const safeTimeSecondDate = isoDateDaysFromNow(10);
  const safeTimeCaption = [
    `${ddmmForIsoDate(safeTimeFirstDate)}. @alice 21h`,
    `${ddmmForIsoDate(safeTimeSecondDate)}. @bob 22h`,
  ].join("\n");
  const safeTimePrepared = prepareEventsForInsert(
    makeInstagramPost({ caption: safeTimeCaption, postType: "image", username: "qa_handle" }),
    makeExtractedEvent({
      title: "",
      date: "",
      time: "23:00",
      venue: "QA Venue",
      artists: [],
      confidence: 0.95,
      source_caption: safeTimeCaption,
      schedule_entries: [
        {
          date: safeTimeFirstDate,
          time: "21:00",
          title: "@alice",
          artists: ["@alice"],
          source_text: `${ddmmForIsoDate(safeTimeFirstDate)}. @alice 21h`,
        },
        {
          date: safeTimeSecondDate,
          time: "22:00",
          title: "@bob",
          artists: ["@bob"],
          source_text: `${ddmmForIsoDate(safeTimeSecondDate)}. @bob 22h`,
        },
      ],
    }),
    "https://cdn.example.com/safe-time-schedule.jpg",
    {},
    {},
    {},
  );
  const safeTimeEvents = safeTimePrepared.map((result) => assertSingleOkPreparedEvent([result]));
  assert.deepEqual(safeTimeEvents.map((result) => result.event.time), ["21:00", "22:00"]);
  for (const result of safeTimeEvents) {
    const fields = readPreparedNormalizedFields(result);
    assert.equal(
      fields.sourceGroundingVerified,
      true,
      JSON.stringify({ event: result.event, fields }),
    );
    assert.equal(fields.approvalCaptionSourceCoherent, true);
    assert.equal(result.event.status, "approved");
  }

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
      "caption_source_event_mismatch",
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

  const [, repeatedSingleEventMonth, repeatedSingleEventDay] = firstDate.split("-");
  const repeatedSingleEventDateText = `${Number(repeatedSingleEventDay)}. ${
    SERBIAN_MONTH_GENITIVES[Number(repeatedSingleEventMonth) - 1]
  }`;
  const repeatedSingleEventCaption = [
    `ℹ️ Beogradski koncert Joss Stone ${repeatedSingleEventDateText} seli se u Ložionicu!`,
    "",
    `Beogradski koncert britanske zvezde Joss Stone, zakazan za petak, ${repeatedSingleEventDateText}, biće održan u prostoru Ložionice.`,
  ].join("\n");
  const repeatedSingleEvent = prepareEventsForInsert(
    makeInstagramPost({
      caption: repeatedSingleEventCaption,
      postType: "image",
      username: "tickets.rs",
    }),
    makeExtractedEvent({
      title: "Joss Stone",
      date: firstDateLabel,
      time: "",
      venue: "Ložionica",
      artists: ["Joss Stone"],
      category: "live music",
      description: "Joss Stone concert at Ložionica.",
      source_caption: repeatedSingleEventCaption,
      schedule_entries: [
        {
          date: firstDateLabel,
          time: "",
          title: "Joss Stone",
          artists: ["Joss Stone"],
          description: "Joss Stone concert at Ložionica.",
          source_text: `JOSS STONE ${firstDateLabel}. LOŽIONICA`,
        },
      ],
    }),
    "https://cdn.example.com/joss-stone.jpg",
    { "tickets.rs": "Ložionica" },
    {},
    { "tickets.rs": "Ložionica" },
  );
  assert.equal(
    repeatedSingleEvent.length,
    1,
    "Repeated caption prose for one identity/date must not manufacture duplicate schedule rows.",
  );
  assert.equal(repeatedSingleEvent[0].kind, "ok");
  assert.deepEqual(
    {
      title: repeatedSingleEvent[0].event.title,
      artists: repeatedSingleEvent[0].event.artists,
      date: repeatedSingleEvent[0].event.date,
      time: repeatedSingleEvent[0].event.time,
      status: repeatedSingleEvent[0].event.status,
    },
    {
      title: "Joss Stone",
      artists: ["Joss Stone"],
      date: firstDate,
      time: TBD_EVENT_TIME,
      status: "approved",
    },
    "A repeated same-event announcement must keep the canonical grounded model event.",
  );

  const hardMappedVenueMismatch = prepareEventsForInsert(
    makeInstagramPost({
      caption: repeatedSingleEventCaption,
      postType: "image",
      username: "kcgrad",
    }),
    makeExtractedEvent({
      title: "Joss Stone",
      date: firstDateLabel,
      time: "",
      venue: "Ložionica",
      artists: ["Joss Stone"],
      category: "live music",
      description: "Joss Stone concert at Ložionica.",
      source_caption: repeatedSingleEventCaption,
      schedule_entries: [
        {
          date: firstDateLabel,
          time: "",
          title: "Joss Stone",
          artists: ["Joss Stone"],
          description: "Joss Stone concert at Ložionica.",
          source_text: `JOSS STONE ${firstDateLabel}. LOŽIONICA`,
        },
      ],
    }),
    "https://cdn.example.com/joss-stone-hard-mapped-venue.jpg",
    { kcgrad: "KC Grad" },
    { kcgrad: "KC Grad" },
    { kcgrad: "KC Grad" },
  );
  assert.equal(
    hardMappedVenueMismatch.length,
    2,
    "A hard per-handle venue override that disagrees with the source-owned venue must block destructive caption suppression.",
  );
  assert.deepEqual(
    hardMappedVenueMismatch.map((result) => {
      assert.equal(result.kind, "ok");
      return {
        status: result.event.status,
        venue: result.event.venue,
        splitSourceLine: readPreparedNormalizedFields(result).splitSourceLine,
      };
    }),
    repeatedSingleEventCaption.split("\n").filter(Boolean).map((splitSourceLine) => ({
      status: "pending",
      venue: "KC Grad",
      splitSourceLine,
    })),
    "Venue-authority disagreement must preserve both exact source rows as pending while retaining the final normalized venue.",
  );

  const sharedUmbrellaDistinctEventsCaption = [
    `${firstDateLabel} Cinema Week presents Film A`,
    `${firstDateLabel} Cinema Week presents Film B`,
  ].join("\n");
  const sharedUmbrellaDistinctEvents = prepareEventsForInsert(
    makeInstagramPost({
      caption: sharedUmbrellaDistinctEventsCaption,
      postType: "image",
      username: "cinema.week",
    }),
    makeExtractedEvent({
      title: "Cinema Week",
      date: firstDateLabel,
      time: "",
      venue: "Ložionica",
      artists: [],
      category: "film",
      description: "Cinema Week at Ložionica.",
      source_caption: sharedUmbrellaDistinctEventsCaption,
      schedule_entries: [
        {
          date: firstDateLabel,
          time: "",
          title: "Cinema Week",
          artists: [],
          description: "Cinema Week at Ložionica.",
          source_text: `${firstDateLabel} Cinema Week`,
        },
      ],
    }),
    "https://cdn.example.com/cinema-week.jpg",
    { "cinema.week": "Ložionica" },
    {},
    { "cinema.week": "Ložionica" },
  );
  assert.equal(
    sharedUmbrellaDistinctEvents.length,
    2,
    "Distinct rows that share only a canonical umbrella title must never collapse.",
  );
  assert.deepEqual(
    sharedUmbrellaDistinctEvents.map((result) => {
      assert.equal(result.kind, "ok");
      return readPreparedNormalizedFields(result).splitSourceLine;
    }).sort(),
    sharedUmbrellaDistinctEventsCaption.split("\n").sort(),
    "Every shared-umbrella source row must survive deterministic reconciliation.",
  );

  const announcementCueDistinctTitlesCaption = [
    `${firstDateLabel} Cinema Week scheduled Star at Ložionica`,
    `${firstDateLabel} Cinema Week scheduled Concert at Ložionica`,
  ].join("\n");
  const announcementCueDistinctTitles = prepareEventsForInsert(
    makeInstagramPost({
      caption: announcementCueDistinctTitlesCaption,
      postType: "image",
      username: "cinema.week",
    }),
    makeExtractedEvent({
      title: "Cinema Week",
      date: firstDateLabel,
      time: "",
      venue: "Ložionica",
      artists: [],
      category: "film",
      description: "Cinema Week at Ložionica.",
      source_caption: announcementCueDistinctTitlesCaption,
      schedule_entries: [
        {
          date: firstDateLabel,
          time: "",
          title: "Cinema Week",
          artists: [],
          description: "Cinema Week at Ložionica.",
          source_text: `${firstDateLabel} Cinema Week`,
        },
      ],
    }),
    "https://cdn.example.com/cinema-week-announcement-titles.jpg",
    { "cinema.week": "Ložionica" },
    {},
    { "cinema.week": "Ložionica" },
  );
  assert.equal(
    announcementCueDistinctTitles.length,
    2,
    "An announcement verb must not hide different trailing event titles.",
  );
  assert.deepEqual(
    announcementCueDistinctTitles.map((result) => {
      assert.equal(result.kind, "ok");
      return readPreparedNormalizedFields(result).splitSourceLine;
    }).sort(),
    announcementCueDistinctTitlesCaption.split("\n").sort(),
    "Identity-like suffixes must survive even when every row uses a reschedule cue.",
  );

  for (const [caseName, firstSuffix, secondSuffix] of [
    ["allowed context words", "The Venue", "The Space"],
    ["bare numeric identities", "42", "54"],
  ]) {
    const acceptedGrammarDistinctTitlesCaption = [
      `Beogradski koncert Joss Stone ${repeatedSingleEventDateText} ${firstSuffix} seli se u Ložionicu!`,
      `Beogradski koncert Joss Stone ${repeatedSingleEventDateText} ${secondSuffix} seli se u Ložionicu!`,
    ].join("\n");
    const acceptedGrammarDistinctTitles = prepareEventsForInsert(
      makeInstagramPost({
        caption: acceptedGrammarDistinctTitlesCaption,
        postType: "image",
        username: "tickets.rs",
      }),
      makeExtractedEvent({
        title: "Joss Stone",
        date: firstDateLabel,
        time: "",
        venue: "Ložionica",
        artists: ["Joss Stone"],
        category: "live music",
        description: "Joss Stone concert at Ložionica.",
        source_caption: acceptedGrammarDistinctTitlesCaption,
        schedule_entries: [
          {
            date: firstDateLabel,
            time: "",
            title: "Joss Stone",
            artists: ["Joss Stone"],
            description: "Joss Stone concert at Ložionica.",
            source_text: `JOSS STONE ${firstDateLabel}. LOŽIONICA`,
          },
        ],
      }),
      "https://cdn.example.com/joss-stone-accepted-grammar-negative.jpg",
      { "tickets.rs": "Ložionica" },
      {},
      { "tickets.rs": "Ložionica" },
    );
    assert.equal(
      acceptedGrammarDistinctTitles.length,
      2,
      `${caseName} must not be discarded as harmless announcement metadata.`,
    );
    assert.deepEqual(
      acceptedGrammarDistinctTitles.map((result) => {
        assert.equal(result.kind, "ok");
        return readPreparedNormalizedFields(result).splitSourceLine;
      }).sort(),
      acceptedGrammarDistinctTitlesCaption.split("\n").sort(),
      `${caseName} must retain both exact source rows.`,
    );
  }

  for (const venueCollisionCase of [
    {
      name: "extra prefix-colliding venue token",
      canonicalVenue: "Ložionica",
      relocationVenue: "Ložionicu Ložionizer",
      heldVenue: "Ložionice Ložionizer",
    },
    {
      name: "substituted prefix-colliding venue token",
      canonicalVenue: "Ložionica",
      relocationVenue: "Ložionizer",
      heldVenue: "Ložionizer",
    },
    {
      name: "missing canonical multiword venue token",
      canonicalVenue: "Kulturni Centar",
      relocationVenue: "Kulturni",
      heldVenue: "Kulturni",
    },
    {
      name: "reordered canonical multiword venue tokens",
      canonicalVenue: "Kulturni Centar",
      relocationVenue: "Centar Kulturni",
      heldVenue: "Centar Kulturni",
    },
  ]) {
    const venueCollisionCaption = [
      `Beogradski koncert Joss Stone ${repeatedSingleEventDateText} seli se u ${venueCollisionCase.relocationVenue}`,
      `Beogradski koncert britanske zvezde Joss Stone, zakazan za petak, ${repeatedSingleEventDateText}, biće održan u prostoru ${venueCollisionCase.heldVenue}`,
    ].join("\n");
    const venueCollisionResults = prepareEventsForInsert(
      makeInstagramPost({
        caption: venueCollisionCaption,
        postType: "image",
        username: "tickets.rs",
      }),
      makeExtractedEvent({
        title: "Joss Stone",
        date: firstDateLabel,
        time: "",
        venue: venueCollisionCase.canonicalVenue,
        artists: ["Joss Stone"],
        category: "live music",
        description: `Joss Stone concert at ${venueCollisionCase.canonicalVenue}.`,
        source_caption: venueCollisionCaption,
        schedule_entries: [
          {
            date: firstDateLabel,
            time: "",
            title: "Joss Stone",
            artists: ["Joss Stone"],
            description: `Joss Stone concert at ${venueCollisionCase.canonicalVenue}.`,
            source_text: `JOSS STONE ${firstDateLabel}. ${venueCollisionCase.canonicalVenue}`,
          },
        ],
      }),
      "https://cdn.example.com/joss-stone-venue-collision.jpg",
      { "tickets.rs": venueCollisionCase.canonicalVenue },
      {},
      { "tickets.rs": venueCollisionCase.canonicalVenue },
    );
    assert.equal(
      venueCollisionResults.length,
      2,
      `${venueCollisionCase.name} must block destructive caption suppression.`,
    );
    assert.deepEqual(
      venueCollisionResults.map((result) => {
        assert.equal(result.kind, "ok");
        return readPreparedNormalizedFields(result).splitSourceLine;
      }).sort(),
      venueCollisionCaption.split("\n").sort(),
      `${venueCollisionCase.name} must retain both exact source rows.`,
    );
  }

  const conflictingSingleDateAltText = `Poster text: ${firstDateLabel} - Alice live at Ložionica`;
  const repeatedSingleEventWithConflictingAlt = prepareEventsForInsert(
    makeInstagramPost({
      caption: repeatedSingleEventCaption,
      altText: conflictingSingleDateAltText,
      postType: "image",
      username: "tickets.rs",
    }),
    makeExtractedEvent({
      title: "Joss Stone",
      date: firstDateLabel,
      time: "",
      venue: "Ložionica",
      artists: ["Joss Stone"],
      category: "live music",
      description: "Joss Stone concert at Ložionica.",
      source_caption: repeatedSingleEventCaption,
      schedule_entries: [
        {
          date: firstDateLabel,
          time: "",
          title: "Joss Stone",
          artists: ["Joss Stone"],
          description: "Joss Stone concert at Ložionica.",
          source_text: `JOSS STONE ${firstDateLabel}. LOŽIONICA`,
        },
      ],
    }),
    "https://cdn.example.com/joss-stone-conflicting-alt.jpg",
    { "tickets.rs": "Ložionica" },
    {},
    { "tickets.rs": "Ložionica" },
  );
  assert.equal(
    repeatedSingleEventWithConflictingAlt.length,
    2,
    "Nonempty single-date alt/poster evidence must block destructive caption suppression.",
  );
  assert.deepEqual(
    repeatedSingleEventWithConflictingAlt.map((result) => {
      assert.equal(result.kind, "ok");
      return readPreparedNormalizedFields(result).splitSourceLine;
    }).sort(),
    repeatedSingleEventCaption.split("\n").filter(Boolean).sort(),
    "Conflicting single-date alt evidence must retain the exact caption-derived rows.",
  );

  const partialTimeRepeatedIdentityCaption = [
    `${firstDateLabel} Cinema Week moved to Ložionica at 19H`,
    `${firstDateLabel} Cinema Week moved to Ložionica`,
  ].join("\n");
  const partialTimeRepeatedIdentity = prepareEventsForInsert(
    makeInstagramPost({
      caption: partialTimeRepeatedIdentityCaption,
      postType: "image",
      username: "cinema.week",
    }),
    makeExtractedEvent({
      title: "Cinema Week",
      date: firstDateLabel,
      time: "",
      venue: "Ložionica",
      artists: [],
      category: "film",
      description: "Cinema Week at Ložionica.",
      source_caption: partialTimeRepeatedIdentityCaption,
      schedule_entries: [
        {
          date: firstDateLabel,
          time: "",
          title: "Cinema Week",
          artists: [],
          description: "Cinema Week at Ložionica.",
          source_text: `${firstDateLabel} Cinema Week`,
        },
      ],
    }),
    "https://cdn.example.com/cinema-week-time.jpg",
    { "cinema.week": "Ložionica" },
    {},
    { "cinema.week": "Ložionica" },
  );
  assert.equal(
    partialTimeRepeatedIdentity.length,
    2,
    "One explicit and one missing candidate time must remain separate rather than inheriting one canonical event.",
  );
  assert.deepEqual(
    partialTimeRepeatedIdentity.map((result) => {
      assert.equal(result.kind, "ok");
      return readPreparedNormalizedFields(result).splitSourceLine;
    }).sort(),
    partialTimeRepeatedIdentityCaption.split("\n").sort(),
    "Partial candidate-time coverage must preserve every source row.",
  );

  const competingSupportActsCaption = [
    `Koncert Joss Stone ${repeatedSingleEventDateText} uz Alice.`,
    `Koncert Joss Stone ${repeatedSingleEventDateText} uz Bob.`,
  ].join("\n");
  const competingSupportActs = prepareEventsForInsert(
    makeInstagramPost({
      caption: competingSupportActsCaption,
      postType: "image",
      username: "tickets.rs",
    }),
    makeExtractedEvent({
      title: "Joss Stone",
      date: firstDateLabel,
      time: "",
      venue: "Ložionica",
      artists: ["Joss Stone"],
      category: "live music",
      description: "Joss Stone concert at Ložionica.",
      source_caption: competingSupportActsCaption,
      schedule_entries: [
        {
          date: firstDateLabel,
          time: "",
          title: "Joss Stone",
          artists: ["Joss Stone"],
          description: "Joss Stone concert at Ložionica.",
          source_text: `JOSS STONE ${firstDateLabel}. LOŽIONICA`,
        },
      ],
    }),
    "https://cdn.example.com/joss-stone-support.jpg",
    { "tickets.rs": "Ložionica" },
    {},
    { "tickets.rs": "Ložionica" },
  );
  assert.equal(
    competingSupportActs.length,
    2,
    "Repeated canonical identity/date prose with different locally billed support acts must not collapse.",
  );
  assert.deepEqual(
    competingSupportActs.map((result) => {
      assert.equal(result.kind, "ok");
      return {
        status: result.event.status,
        splitSourceLine: readPreparedNormalizedFields(result).splitSourceLine,
      };
    }),
    competingSupportActsCaption.split("\n").map((splitSourceLine) => ({
      status: "pending",
      splitSourceLine,
    })),
    "Competing support-act rows must stay separately pending for human review.",
  );

  const competingAmpersandCaption = [
    `${firstDateLabel} - Joss Stone & Alice`,
    `${firstDateLabel} - Joss Stone & Bob`,
  ].join("\n");
  const competingAmpersandRows = prepareEventsForInsert(
    makeInstagramPost({
      caption: competingAmpersandCaption,
      postType: "image",
      username: "tickets.rs",
    }),
    makeExtractedEvent({
      title: "Joss Stone",
      date: firstDateLabel,
      time: "",
      venue: "Ložionica",
      artists: ["Joss Stone"],
      category: "live music",
      description: "Joss Stone concert at Ložionica.",
      source_caption: competingAmpersandCaption,
      schedule_entries: [
        {
          date: firstDateLabel,
          time: "",
          title: "Joss Stone",
          artists: ["Joss Stone"],
          description: "Joss Stone concert at Ložionica.",
          source_text: `${firstDateLabel} - Joss Stone`,
        },
      ],
    }),
    "https://cdn.example.com/joss-stone-ampersand.jpg",
    { "tickets.rs": "Ložionica" },
    {},
    { "tickets.rs": "Ložionica" },
  );
  assert.deepEqual(
    competingAmpersandRows.map((result) => {
      assert.equal(result.kind, "ok");
      return {
        status: result.event.status,
        splitSourceLine: readPreparedNormalizedFields(result).splitSourceLine,
      };
    }),
    competingAmpersandCaption.split("\n").map((splitSourceLine) => ({
      status: "pending",
      splitSourceLine,
    })),
    "Competing ampersand-billed rows must bypass canonical model reconciliation and remain distinct.",
  );

  const distinctHeadlinerRowsCaption = [
    `${firstDateLabel} - Koncert Joss Stone: Acoustic Set | Alice`,
    `${firstDateLabel} - Koncert Joss Stone: Electric Set | Bob`,
  ].join("\n");
  const distinctHeadlinerRows = prepareEventsForInsert(
    makeInstagramPost({
      caption: distinctHeadlinerRowsCaption,
      postType: "image",
      username: "tickets.rs",
    }),
    makeExtractedEvent({
      title: "Joss Stone",
      date: firstDateLabel,
      time: "",
      venue: "Ložionica",
      artists: ["Joss Stone"],
      category: "live music",
      description: "Joss Stone concert at Ložionica.",
      source_caption: distinctHeadlinerRowsCaption,
      schedule_entries: [
        {
          date: firstDateLabel,
          time: "",
          title: "Joss Stone",
          artists: ["Joss Stone"],
          description: "Joss Stone concert at Ložionica.",
          source_text: `${firstDateLabel} - Joss Stone`,
        },
      ],
    }),
    "https://cdn.example.com/joss-stone-distinct-rows.jpg",
    { "tickets.rs": "Ložionica" },
    {},
    { "tickets.rs": "Ložionica" },
  );
  assert.equal(
    distinctHeadlinerRows.length,
    2,
    "Schedule-shaped rows with the same headliner but different suffix titles and billed artists must not collapse.",
  );
  assert.deepEqual(
    distinctHeadlinerRows.map((result) => {
      assert.equal(result.kind, "ok");
      return {
        status: result.event.status,
        splitSourceLine: readPreparedNormalizedFields(result).splitSourceLine,
      };
    }),
    distinctHeadlinerRowsCaption.split("\n").map((splitSourceLine) => ({
      status: "pending",
      splitSourceLine,
    })),
    "Distinct shared-headliner rows must retain both source rows for review.",
  );

  const conflictingShowtimesCaption = [
    `${firstDateLabel} - Joss Stone 19H`,
    `${firstDateLabel} - Joss Stone 22H`,
  ].join("\n");
  const conflictingShowtimes = prepareEventsForInsert(
    makeInstagramPost({
      caption: conflictingShowtimesCaption,
      postType: "image",
      username: "tickets.rs",
    }),
    makeExtractedEvent({
      title: "Joss Stone",
      date: firstDateLabel,
      time: "19:00",
      venue: "Ložionica",
      artists: ["Joss Stone"],
      category: "live music",
      source_caption: conflictingShowtimesCaption,
      schedule_entries: [
        {
          date: firstDateLabel,
          time: "19:00",
          title: "Joss Stone",
          artists: ["Joss Stone"],
          description: "Joss Stone concert at Ložionica.",
          source_text: `${firstDateLabel} - Joss Stone 19H`,
        },
      ],
    }),
    "https://cdn.example.com/joss-stone-showtimes.jpg",
    { "tickets.rs": "Ložionica" },
    {},
    { "tickets.rs": "Ložionica" },
  );
  assert.deepEqual(
    conflictingShowtimes.map((result) => {
      assert.equal(result.kind, "ok");
      return result.event.time;
    }),
    ["19:00", "22:00"],
    "Repeated identity/date rows with conflicting explicit times must remain distinct.",
  );

  const distinctIdentityCaption = [
    `${firstDateLabel} - Summer Festival | Alice`,
    `${firstDateLabel} - Autumn Showcase | Bob`,
  ].join("\n");
  const distinctIdentityRows = prepareEventsForInsert(
    makeInstagramPost({
      caption: distinctIdentityCaption,
      postType: "image",
      username: "tickets.rs",
    }),
    makeExtractedEvent({
      title: "Summer Festival",
      date: firstDateLabel,
      time: "",
      venue: "Ložionica",
      artists: ["Alice"],
      category: "live music",
      source_caption: distinctIdentityCaption,
      schedule_entries: [
        {
          date: firstDateLabel,
          time: "",
          title: "Summer Festival",
          artists: ["Alice"],
          description: "Summer Festival with Alice.",
          source_text: `${firstDateLabel} - Summer Festival | Alice`,
        },
      ],
    }),
    "https://cdn.example.com/summer-festival.jpg",
    { "tickets.rs": "Ložionica" },
    {},
    { "tickets.rs": "Ložionica" },
  );
  assert.equal(
    distinctIdentityRows.length,
    2,
    "Same-date rows with different identities must remain distinct.",
  );
  assert.deepEqual(
    distinctIdentityRows.map((result) => {
      assert.equal(result.kind, "ok");
      return readPreparedNormalizedFields(result).splitSourceLine;
    }),
    distinctIdentityCaption.split("\n"),
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
      independentTextEvidence: `${firstDdmm}. @verajamarko`,
      title: "Verajamarko",
      artists: ["Verajamarko"],
      time: "",
    }).verified,
    true,
    "A compact raw schedule row may bill an exact artist identity without a redundant DJ label.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `📅 ${firstDdmm} | 🕘 20.30\n🎬 SAUNDTREK ZA PREVRAT (Soundtrack to a Coup d'Etat) | 150’`,
      title: "SAUNDTREK ZA PREVRAT (Soundtrack to a Coup d'Etat)",
      artists: [],
      time: "20:30",
      splitSource: "caption_schedule",
    }).verified,
    true,
    "A multiline schedule row may bind one explicit date/time header to its single immediately following event line.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `📅 ${firstDdmm} | 🕘 20.30\n🎬 ZEMLJA (Zemlja) | 10’\n🎬 DŽOJMEJKERS (Joymakers) | 46’`,
      title: "ZEMLJA (Zemlja)",
      artists: [],
      time: "20:30",
      splitSource: "caption_schedule",
    }).verified,
    false,
    "One shared date/time header must not auto-publish one arbitrary title from a multi-title block.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `📅 ${firstDdmm} | 🕘 20.30\nNENAJAVLJENI FILM | 70’\n🎬 SAUNDTREK ZA PREVRAT (Soundtrack to a Coup d'Etat) | 150’`,
      title: "SAUNDTREK ZA PREVRAT (Soundtrack to a Coup d'Etat)",
      artists: [],
      time: "20:30",
      splitSource: "caption_schedule",
    }).verified,
    false,
    "A dated block with any extra unmarked row must remain ambiguous even when exactly one later row has an event marker.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `📅 ${firstDdmm} | 🕘 20.30 | 🎬 EVENT A\n🎬 EVENT B`,
      title: "EVENT B",
      artists: [],
      time: "20:30",
      splitSource: "caption_schedule",
    }).verified,
    false,
    "A date line that already contains an event identity cannot serve as a pure header for another row.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `📅 ${firstDdmm} | 🕘 20.30 | 1984\n🎬 EVENT B`,
      title: "EVENT B",
      artists: [],
      time: "20:30",
      splitSource: "caption_schedule",
    }).verified,
    false,
    "Numeric title content cannot be hidden inside a reusable date header.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `📅 ${firstDdmm} | 🕘 20.30\n🎬 EVENT A | 🎬 EVENT B`,
      title: "EVENT B",
      artists: [],
      time: "20:30",
      splitSource: "caption_schedule",
    }).verified,
    false,
    "A single following row with multiple event markers remains ambiguous.",
  );
  const markedAndUnmarkedCaption = `📅 ${firstDdmm} | 🕘 20.30\n🎬 EVENT A | EVENT B`;
  assert.equal(
    evaluate({
      independentTextEvidence: markedAndUnmarkedCaption,
      title: "EVENT A",
      artists: [],
      time: "20:30",
      splitSource: "caption_schedule",
    }).verified,
    false,
    "A single following row with one marked and one unmarked event identity remains ambiguous.",
  );
  const markedAndUnmarkedPrepared = assertSingleOkPreparedEvent(
    prepareEventsForInsert(
      makeInstagramPost({
        caption: markedAndUnmarkedCaption,
        postType: "image",
        username: "qa_handle",
      }),
      makeExtractedEvent({
        title: "EVENT A",
        date: firstDate,
        time: "20:30",
        venue: "QA Venue",
        artists: [],
        category: "culture",
        description: "EVENT A.",
        source_caption: markedAndUnmarkedCaption,
      }),
      "https://cdn.example.com/ambiguous-event-row.jpg",
      { qa_handle: "QA Venue" },
      {},
      { qa_handle: "QA Venue" },
    ),
  );
  const markedAndUnmarkedFields = readPreparedNormalizedFields(markedAndUnmarkedPrepared);
  assert.equal(
    markedAndUnmarkedPrepared.event.status,
    "pending",
    "A marked-plus-unmarked event row must fail closed through prepareEventsForInsert.",
  );
  assert.equal(markedAndUnmarkedFields.sourceGroundingVerified, false);
  assert.ok(
    markedAndUnmarkedFields.moderationPendingReasons.includes("unverified_core_event_source"),
  );

  const compactAndNumericAmbiguousRows = [
    "🎬 EVENT A|EVENT B",
    "🎬 EVENT A |EVENT B",
    "🎬 EVENT A| EVENT B",
    "🎬 EVENT A/EVENT B",
    "🎬 EVENT A /EVENT B",
    "🎬 EVENT A/ EVENT B",
    "🎬 EVENT A | 42",
    "🎬 EVENT A/42",
  ];
  for (const [variantIndex, eventRow] of compactAndNumericAmbiguousRows.entries()) {
    const ambiguousCaption = `📅 ${firstDdmm} | 🕘 20.30\n${eventRow}`;
    assert.equal(
      evaluate({
        independentTextEvidence: ambiguousCaption,
        title: "EVENT A",
        artists: [],
        time: "20:30",
        splitSource: "caption_schedule",
      }).verified,
      false,
      `Compact or numeric delimited event row must remain ambiguous: ${eventRow}`,
    );

    const preparedVariants = prepareEventsForInsert(
      makeInstagramPost({
        caption: ambiguousCaption,
        postId: `qa-ambiguous-delimiter-${variantIndex}`,
        postType: "image",
        username: "qa_handle",
      }),
      makeExtractedEvent({
        title: "EVENT A",
        date: firstDate,
        time: "20:30",
        venue: "QA Venue",
        artists: [],
        category: "culture",
        description: "EVENT A.",
        source_caption: ambiguousCaption,
      }),
      `https://cdn.example.com/ambiguous-delimiter-${variantIndex}.jpg`,
      { qa_handle: "QA Venue" },
      {},
      { qa_handle: "QA Venue" },
    );
    const preparedOkVariants = preparedVariants.filter((result) => result.kind === "ok");
    assert.ok(
      preparedOkVariants.length >= 1,
      `Ambiguous delimiter fixture must reach moderation: ${eventRow}`,
    );
    for (const preparedVariant of preparedOkVariants) {
      assert.equal(
        preparedVariant.event.status,
        "pending",
        `Ambiguous delimiter fixture must fail closed through prepareEventsForInsert: ${eventRow}`,
      );
      assert.ok(
        readPreparedNormalizedFields(preparedVariant).moderationPendingReasons.includes(
          "unverified_core_event_source",
        ),
      );
    }
  }

  assert.equal(
    evaluate({
      independentTextEvidence: `${firstDdmm} DJ ALICE\nStarts at 22:00\nDJ BOB\nStarts at 23:00`,
      title: "ALICE",
      artists: ["ALICE"],
      time: "23:00",
      splitSource: null,
    }).verified,
    false,
    "Separated start rows must never be Cartesian-joined to another billed artist.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `U subotu ${firstDdmm}. ponovo kao na moru!\nSlušamo @bendarhivatori`,
      title: "Bendarhivatori",
      artists: ["Bendarhivatori"],
      time: "",
      splitSource: null,
    }).verified,
    false,
    "Listening-language alone must remain moderator evidence rather than live-performer authority.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `U subotu ${firstDdmm}. ponovo kao na moru!\nSlušamo #bendarhivatori`,
      title: "Bendarhivatori",
      artists: ["Bendarhivatori"],
      time: "",
      splitSource: null,
    }).verified,
    false,
    "A hashtag after a local billing phrase must not establish performer identity.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `ALICE | ${firstDdmm}.\nPlaylist curated by @alice`,
      title: "ALICE",
      artists: ["ALICE"],
      time: "",
      splitSource: null,
    }).verified,
    false,
    "A playlist curator mention must not be treated as a billed live performer.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `${firstDdmm}. #verajamarko`,
      title: "Verajamarko",
      artists: ["Verajamarko"],
      time: "",
    }).verified,
    false,
    "A hashtag-only identity must not become source authority for an event title or artist.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `${firstDdmm}. od 21h u VOXu svira Inke.`,
      title: "INKE",
      artists: ["INKE"],
      time: "21:00",
      splitSource: null,
    }).verified,
    true,
    "An explicit Serbian performance sentence must ground its named artist, date, and time.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `MILENA ĆERANIĆ | ${firstDdmm}. | 23h\nLet the music begin w/ @ceranicmilena`,
      title: "MILENA ĆERANIĆ",
      artists: ["MILENA ĆERANIĆ"],
      time: "23:00",
      splitSource: null,
    }).verified,
    true,
    "A single dated row may bind its immediately adjacent explicit billed mention.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `${firstDdmm}. U 21h na otvorenom!\n“(500) Days of Summer” (2009)\nVrata se otvaraju u 20:30h.`,
      title: "(500) Days of Summer",
      artists: [],
      time: "21:00",
      splitSource: null,
    }).verified,
    true,
    "A single dated start row may bind its immediately adjacent quoted work with year while ignoring a doors clock.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `${firstDdmm}. U 21h\n“(500) Days of Summer” (2009)\n🎬 SECOND FILM`,
      title: "(500) Days of Summer",
      artists: [],
      time: "21:00",
      splitSource: null,
    }).verified,
    false,
    "An adjacent quoted work must not hide a second explicit event row.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `${firstDdmm}. U 21h\n\n“(500) Days of Summer” (2009)`,
      title: "(500) Days of Summer",
      artists: [],
      time: "21:00",
      splitSource: null,
    }).verified,
    false,
    "Adjacent layout binding must not cross a blank paragraph boundary.",
  );
  for (const extraRow of ["• CHARLIE", "2. CHARLIE"]) {
    assert.equal(
      evaluate({
        independentTextEvidence: `${firstDdmm}. 20:30\n• ALICE with @bob\n${extraRow}`,
        title: "ALICE",
        artists: ["bob"],
        time: "20:30",
        splitSource: null,
      }).verified,
      false,
      `A bounded adjacent layout must reject a third structured row: ${extraRow}`,
    );
  }
  assert.equal(
    evaluate({
      independentTextEvidence: `Cocktails with friends ${firstDdmm}. at 22h`,
      title: "Cocktails with friends",
      artists: [],
      time: "22:00",
      splitSource: null,
    }).verified,
    false,
    "A title-like lifestyle phrase at the start of ordinary prose is not event billing.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `Cocktails with friends ${firstDdmm}. at 22h`,
      title: "Cocktails with friends",
      artists: ["Cocktails with friends"],
      time: "22:00",
      splitSource: null,
    }).verified,
    false,
    "A model cannot turn ordinary prose into billing by copying the title into artists.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `${firstDdmm}. DJ ALICE 22h\nwith friends`,
      title: "friends",
      artists: ["friends"],
      time: "22:00",
      splitSource: null,
    }).verified,
    false,
    "An untagged adjacent 'with friends' prose line must not become performer billing.",
  );
  for (const [caption, title, artists] of [
    [
      `ALICE | ${firstDdmm}. | 20:30\nLet the music begin with @bob`,
      "BOB",
      ["BOB"],
    ],
    [`ALICE | ${firstDdmm}. | 20:30\nwith @notalice`, "NOTALICE", ["NOTALICE"]],
    [`ALICE | ${firstDdmm}. | 20:30\nwith @alice_music`, "ALICE MUSIC", ["ALICE MUSIC"]],
    [
      `${firstDdmm}. | 20:30 | EVENT A\n“EVENT B” (2001)`,
      "EVENT B",
      [],
    ],
    [
      `${firstDdmm}. | 20:30\n🎤 ALICE with @bob 🎤 CHARLIE`,
      "ALICE",
      ["bob"],
    ],
    [
      `${firstDdmm}. | 20:30\nALICE with @bob | CHARLIE`,
      "ALICE",
      ["bob"],
    ],
    [
      `${firstDdmm}. | 20:30\n“FILM A” (2001) / “FILM B” (2002)`,
      "FILM A",
      [],
    ],
  ]) {
    assert.equal(
      evaluate({
        independentTextEvidence: caption,
        title,
        artists,
        time: "20:30",
        splitSource: null,
      }).verified,
      false,
      `Adjacent evidence must not cross competing identities: ${caption}`,
    );
  }
  assert.equal(
    evaluate({
      independentTextEvidence: `COCKTAILS WITH FRIENDS | ${firstDdmm}. | 22h`,
      title: "COCKTAILS WITH FRIENDS",
      artists: ["COCKTAILS WITH FRIENDS"],
      time: "22:00",
      splitSource: null,
    }).verified,
    false,
    "An all-caps layout still needs independent source authority for a claimed artist.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `Cocktails with friends. More at @cocktailswithfriends. ${firstDdmm}. at 22h.`,
      title: "Cocktails with friends",
      artists: ["Cocktails with friends"],
      time: "22:00",
      splitSource: null,
    }).verified,
    false,
    "An unrelated matching account mention must not establish local performer billing.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `Cinema Night ${firstDdmm}. at 21h. Doors open at 20h.`,
      title: "Cinema Night",
      artists: [],
      time: "21:00",
      splitSource: null,
    }).verified,
    false,
    "Door-opening logistics alone must not establish a generic no-artist event identity.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `Film recommendations for friends. ${firstDdmm}. at 22h.`,
      title: "Film recommendations for friends",
      artists: [],
      time: "22:00",
      splitSource: null,
    }).verified,
    false,
    "A cultural keyword prefix does not turn recommendations or prose into event billing.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `Projekcija filma "Searching for Sugar Man" | ${firstDdmm}. | 20:45h`,
      title: `Projekcija filma "Searching for Sugar Man"`,
      artists: [],
      time: "20:45",
      splitSource: null,
    }).verified,
    true,
    "A quoted cultural work bound to an explicit local projection label is source-grounded.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `Projekcija filma Cinema Night | ${firstDdmm}. | Doors open at 20:30.`,
      title: "Projekcija filma Cinema Night",
      artists: [],
      time: "20:30",
      splitSource: null,
    }).verified,
    false,
    "A door-opening clock must not verify the event start time.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `Projekcija filma Cinema Night | ${firstDdmm}. | Doors open at 20. Happy hour ends at 20h.`,
      title: "Projekcija filma Cinema Night",
      artists: [],
      time: "20:00",
      splitSource: null,
    }).verified,
    false,
    "A bare door hour must not borrow an unrelated same-value clock from another clause.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `Projekcija filma Cinema Night | ${firstDdmm}. | Doors open at 20:30.`,
      title: "Projekcija filma Cinema Night",
      artists: [],
      time: "",
      splitSource: null,
    }).verified,
    true,
    "A grounded event with only a door-opening clock may remain eligible with a missing start time.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: `Projekcija filma Cinema Night | ${firstDdmm}. | Doors open at 20:30. Početak u 21h.`,
      title: "Projekcija filma Cinema Night",
      artists: [],
      time: "21:00",
      splitSource: null,
    }).verified,
    false,
    "A separated start sentence must remain pending without strict continuation binding.",
  );
  const earlyDateGrounding = {
    independentTextEvidence: "08.07. DJ ALICE 22h",
    title: "ALICE",
    artists: ["ALICE"],
    time: "22:00",
    postedAt: "2026-07-01T12:00:00.000Z",
  };
  assert.equal(
    evaluate({ ...earlyDateGrounding, normalizedDate: "2026-07-08" }).verified,
    true,
    "Serbian numeric dates must use the authoritative day-month interpretation.",
  );
  assert.equal(
    evaluate({ ...earlyDateGrounding, normalizedDate: "2026-08-07" }).verified,
    false,
    "The alternate month-day interpretation must not ground the same Serbian row.",
  );
  assert.equal(
    evaluate({
      ...earlyDateGrounding,
      independentTextEvidence: "08.07. DJ ALICE 22h\n07.08. DJ BOB 23h",
      normalizedDate: "2026-08-07",
    }).verified,
    false,
    "A second row must not supply the swapped date interpretation for the first artist.",
  );
  assert.equal(
    evaluate({
      independentTextEvidence: "MILENA ĆERANIĆ | 08.07. | 23h\nLet the music begin w/ @ceranicmilena",
      title: "MILENA ĆERANIĆ",
      artists: ["MILENA ĆERANIĆ"],
      time: "23:00",
      normalizedDate: "2026-07-08",
      postedAt: "2026-07-01T12:00:00.000Z",
      splitSource: null,
    }).verified,
    true,
    "An early-month single dated row may bind its immediately adjacent explicit billed mention.",
  );
  const prepareSingleGroundingCase = ({
    caption,
    title,
    time,
    artists = [],
    category = "nightlife",
  }) =>
    assertSingleOkPreparedEvent(
      prepareEventsForInsert(
        makeInstagramPost({ caption, postType: "image", username: "qa_venue" }),
        makeExtractedEvent({
          title,
          date: firstDate,
          time,
          venue: "QA Venue",
          artists,
          category,
          confidence: 0.95,
          source_caption: caption,
          schedule_entries: [],
        }),
        "https://cdn.example.com/source-grounding-case.jpg",
        { qa_venue: "QA Venue" },
        {},
        { qa_venue: "QA Venue" },
      ),
    );
  const arbitraryProsePrepared = prepareSingleGroundingCase({
    caption: `Cocktails with friends. ${firstDdmm}. at 22h.`,
    title: "Cocktails with friends",
    time: "22:00",
  });
  assert.equal(arbitraryProsePrepared.event.status, "pending");
  assert.equal(readPreparedNormalizedFields(arbitraryProsePrepared).sourceGroundingVerified, false);
  const arbitrarySelfArtistPrepared = prepareSingleGroundingCase({
    caption: `Cocktails with friends. ${firstDdmm}. at 22h.`,
    title: "Cocktails with friends",
    artists: ["Cocktails with friends"],
    time: "22:00",
  });
  assert.equal(arbitrarySelfArtistPrepared.event.status, "pending");
  assert.equal(
    readPreparedNormalizedFields(arbitrarySelfArtistPrepared).sourceGroundingVerified,
    false,
  );
  const unrelatedMentionPrepared = prepareSingleGroundingCase({
    caption: `Cocktails with friends. More at @cocktailswithfriends. ${firstDdmm}. at 22h.`,
    title: "Cocktails with friends",
    artists: ["Cocktails with friends"],
    time: "22:00",
  });
  assert.equal(unrelatedMentionPrepared.event.status, "pending");
  assert.equal(
    readPreparedNormalizedFields(unrelatedMentionPrepared).sourceGroundingVerified,
    false,
  );
  const doorClockPrepared = prepareSingleGroundingCase({
    caption: `Projekcija filma Cinema Night | ${firstDdmm}. | Doors open at 20:30.`,
    title: "Projekcija filma Cinema Night",
    time: "20:30",
    category: "arts & culture",
  });
  assert.equal(doorClockPrepared.event.status, "pending");
  assert.equal(readPreparedNormalizedFields(doorClockPrepared).sourceGroundingTimeVerified, false);
  for (const [doorText, proposedTime] of [
    ["Vrata se otvaraju u 20 časova.", "20:00"],
    ["Vrata se otvaraju u 20 casova.", "20:00"],
    ["Vrata se otvaraju u 20 čas.", "20:00"],
    ["Vrata se otvaraju u 20 cas.", "20:00"],
    ["Vrata se otvaraju u 20 sati.", "20:00"],
    ["Vrata se otvaraju u 20 sata.", "20:00"],
    ["Vrata se otvaraju u 20 sat.", "20:00"],
    ["Doors open at 20h.", "20:00"],
    ["Doors open at 20 hour.", "20:00"],
    ["Doors open at 20 hours.", "20:00"],
    ["Doors open at 20 hr.", "20:00"],
    ["Doors open at 20 hrs.", "20:00"],
    ["Doors open at 8:30 am.", "08:30"],
    ["Doors open at 8:30 a.m.", "08:30"],
    ["Doors open at 8:30 pm.", "20:30"],
    ["Doors open at 8:30 p.m.", "20:30"],
  ]) {
    const doorSuffixAsStart = prepareSingleGroundingCase({
      caption: `Projekcija filma Cinema Night | ${firstDdmm}. | ${doorText}`,
      title: "Projekcija filma Cinema Night",
      time: proposedTime,
      category: "arts & culture",
    });
    assert.equal(
      doorSuffixAsStart.event.status,
      "pending",
      `Door-only clock must not publish as start time: ${doorText}`,
    );
    assert.equal(
      readPreparedNormalizedFields(doorSuffixAsStart).sourceGroundingTimeVerified,
      false,
      `Door-only clock must not verify source start time: ${doorText}`,
    );

    const doorSuffixAsTbd = prepareSingleGroundingCase({
      caption: `Projekcija filma Cinema Night | ${firstDdmm}. | ${doorText}`,
      title: "Projekcija filma Cinema Night",
      time: "",
      category: "arts & culture",
    });
    assert.equal(
      doorSuffixAsTbd.event.status,
      "approved",
      `Grounded event with only a door clock should remain eligible as TBD: ${doorText}`,
    );
    assert.equal(doorSuffixAsTbd.event.time, TBD_EVENT_TIME);
  }
  const crossClauseDoorClockPrepared = prepareSingleGroundingCase({
    caption: `Projekcija filma Cinema Night | ${firstDdmm}. | Doors open at 20. Happy hour ends at 20h.`,
    title: "Projekcija filma Cinema Night",
    time: "20:00",
    category: "arts & culture",
  });
  assert.equal(crossClauseDoorClockPrepared.event.status, "pending");
  assert.equal(
    readPreparedNormalizedFields(crossClauseDoorClockPrepared).sourceGroundingVerified,
    false,
  );
  const doorClockTbdPrepared = prepareSingleGroundingCase({
    caption: `Projekcija filma Cinema Night | ${firstDdmm}. | Doors open at 20:30.`,
    title: "Projekcija filma Cinema Night",
    time: "",
    category: "arts & culture",
  });
  assert.equal(doorClockTbdPrepared.event.time, TBD_EVENT_TIME);
  assert.equal(doorClockTbdPrepared.event.status, "approved");
  assert.equal(readPreparedNormalizedFields(doorClockTbdPrepared).sourceGroundingVerified, true);
  const naturalLanguageCaption = `${firstDdmm}. od 21h u VOXu svira Inke.`;
  const coherentNumericMediaId = {
    title: "INKE",
    date: firstDate,
    time: "21:00",
    venue: "Vox Blues club",
    artists: ["INKE"],
    sourceCaption: naturalLanguageCaption,
    sourcePostedAt: `${firstDate}T08:00:00.000Z`,
    instagramPostId: "3944924586821733370",
    instagramPostUrl: "https://www.instagram.com/p/Da_MAK3Nsv6/",
    sourceInstagramHandle: "voxbluesclub",
    venueInstagramHandle: "voxbluesclub",
  };
  assert.equal(
    isCaptionSourceCoherentWithEvent(coherentNumericMediaId),
    true,
    "Apify numeric media IDs and Instagram URL shortcodes are distinct valid identities from one source post.",
  );
  assert.equal(
    isCaptionSourceCoherentWithEvent({
      ...coherentNumericMediaId,
      title: "MILENA ĆERANIĆ",
      artists: ["MILENA ĆERANIĆ"],
      time: "23:00",
      sourceCaption: `MILENA ĆERANIĆ | ${firstDdmm}. | 23h\nLet the music begin w/ @ceranicmilena`,
    }),
    true,
    "The approval boundary must share the bounded adjacent billed-mention layout parser.",
  );
  assert.equal(
    isCaptionSourceCoherentWithEvent({
      ...coherentNumericMediaId,
      title: "(500) Days of Summer",
      artists: [],
      time: "21:00",
      sourceCaption: `${firstDdmm}. U 21h na otvorenom!\n“(500) Days of Summer” (2009)\nVrata se otvaraju u 20:30h.`,
    }),
    true,
    "The approval boundary must bind an adjacent quoted work while excluding a doors-only clock.",
  );
  assert.equal(
    isCaptionSourceCoherentWithEvent({
      ...coherentNumericMediaId,
      title: "(500) Days of Summer",
      artists: [],
      time: "21:00",
      sourceCaption: `${firstDdmm}. U 21h na otvorenom!\nTickets in bio\n“(500) Days of Summer” (2009)`,
    }),
    false,
    "A non-adjacent quoted work must not be joined to a dated event row.",
  );
  assert.equal(
    isCaptionSourceCoherentWithEvent({
      ...coherentNumericMediaId,
      title: "friends",
      artists: ["friends"],
      time: "22:00",
      sourceCaption: `${firstDdmm}. DJ ALICE 22h\nwith friends`,
    }),
    false,
    "The approval boundary must reject an untagged adjacent 'with friends' prose line.",
  );
  for (const [caption, title, artists] of [
    [
      `ALICE | ${firstDdmm}. | 20:30\nLet the music begin with @bob`,
      "BOB",
      ["BOB"],
    ],
    [`ALICE | ${firstDdmm}. | 20:30\nwith @notalice`, "NOTALICE", ["NOTALICE"]],
    [`ALICE | ${firstDdmm}. | 20:30\nwith @alice_music`, "ALICE MUSIC", ["ALICE MUSIC"]],
    [
      `${firstDdmm}. | 20:30 | EVENT A\n“EVENT B” (2001)`,
      "EVENT B",
      [],
    ],
    [
      `${firstDdmm}. | 20:30\n🎤 ALICE with @bob 🎤 CHARLIE`,
      "ALICE",
      ["bob"],
    ],
    [
      `${firstDdmm}. | 20:30\nALICE with @bob | CHARLIE`,
      "ALICE",
      ["bob"],
    ],
    [
      `${firstDdmm}. | 20:30\n“FILM A” (2001) / “FILM B” (2002)`,
      "FILM A",
      [],
    ],
  ]) {
    assert.equal(
      isCaptionSourceCoherentWithEvent({
        ...coherentNumericMediaId,
        title,
        artists,
        time: "20:30",
        sourceCaption: caption,
      }),
      false,
      `The approval boundary must reject competing adjacent identities: ${caption}`,
    );
  }
  assert.equal(
    isCaptionSourceCoherentWithEvent({
      ...coherentNumericMediaId,
      title: "(500) Days of Summer",
      artists: [],
      time: "21:00",
      sourceCaption: `${firstDdmm}. U 21h\n“(500) Days of Summer” (2009)\n🎬 SECOND FILM`,
    }),
    false,
    "The approval boundary must reject a joined work when another explicit event row exists.",
  );
  assert.equal(
    isCaptionSourceCoherentWithEvent({
      ...coherentNumericMediaId,
      title: "(500) Days of Summer",
      artists: [],
      time: "21:00",
      sourceCaption: `${firstDdmm}. U 21h\n\n“(500) Days of Summer” (2009)`,
    }),
    false,
    "The approval boundary must not join evidence across a blank paragraph boundary.",
  );
  for (const extraRow of ["• CHARLIE", "2. CHARLIE"]) {
    assert.equal(
      isCaptionSourceCoherentWithEvent({
        ...coherentNumericMediaId,
        title: "ALICE",
        artists: ["bob"],
        time: "20:30",
        sourceCaption: `${firstDdmm}. 20:30\n• ALICE with @bob\n${extraRow}`,
      }),
      false,
      `The approval boundary must reject a third structured row: ${extraRow}`,
    );
  }
  assert.equal(
    isCaptionSourceCoherentWithEvent({
      ...coherentNumericMediaId,
      instagramPostId: "9999999999999999999",
    }),
    false,
    "A numeric media ID must decode exactly from the URL shortcode.",
  );
  assert.equal(
    isCaptionSourceCoherentWithEvent({
      ...coherentNumericMediaId,
      instagramPostUrl: "https://www.instagram.com/p/ADa_MAK3Nsv6/",
    }),
    false,
    "A leading-zero shortcode alias must not match the canonical numeric media ID.",
  );
  assert.equal(
    isCaptionSourceCoherentWithEvent({
      ...coherentNumericMediaId,
      instagramPostId: "123",
      instagramPostUrl: "https://www.instagram.com/p/123/",
    }),
    false,
    "A numeric post ID must not bypass decoding through direct shortcode equality.",
  );
  assert.equal(
    isCaptionSourceCoherentWithEvent({
      ...coherentNumericMediaId,
      instagramPostId: "unrelated-opaque-id",
    }),
    false,
    "An unrelated opaque post ID must not be accepted as coherent with a different shortcode.",
  );
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
    sourceGroundingVersion: 4,
    sourceGroundingEvidence: "instagram_caption",
    sourceGroundingSourceKind: "caption",
    sourceGroundingSourceCaption: `${ddmmForIsoDate(isoDateDaysFromNow(7))} ALICE`,
    sourceGroundingInstagramPostId: "qa-maintenance-post",
    sourceGroundingInstagramPostUrl: "https://www.instagram.com/p/qa-maintenance-post/",
    sourceGroundingInstagramHandle: "qa_venue",
    approvalTitleSensible: true,
    approvalCaptionSourceCoherent: true,
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
    venueInstagramHandle: "qa_venue",
    imageUrl: "https://cdn.example.com/poster.jpg",
    sourceCaption: `${ddmmForIsoDate(isoDateDaysFromNow(7))} ALICE`,
    instagramPostId: "qa-maintenance-post",
    instagramPostUrl: "https://www.instagram.com/p/qa-maintenance-post/",
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

  assertRelativeDateCase({
    caption: "Sledeći petak stiže Mega Band.",
    expectedDates: [weekdayIsoDateFrom(baseMondayIsoDate, 5, "next")],
    label: "masculine next-weekday adjective: sledeći petak",
    postedAt,
  });
  assertRelativeDateCase({
    caption: "Trodnevni program počinje sledećeg petka.",
    expectedDates: [weekdayIsoDateFrom(baseMondayIsoDate, 5, "next")],
    label: "genitive next-weekday adjective: sledećeg petka",
    postedAt,
  });

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
    ["Уживо музика од 19ч.", "19:00"],
    ["17-00h", "17:00-00:00"],
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
    sourcePostedAt: "2026-07-01T12:00:00.000Z",
    instagramPostId: "grounded-qa-event-post",
    instagramPostUrl: "https://www.instagram.com/p/grounded-qa-event-post/",
    venueInstagramHandle: "qa_venue",
  };
  const completeSourceGroundedApproval = JSON.stringify({
    title: approvalPublicFields.title,
    time: approvalPublicFields.time,
    artists: approvalPublicFields.artists,
    postAltText: null,
    sourceGroundingSourceKind: "caption",
    sourceGroundingSourceCaption: approvalPublicFields.sourceCaption,
    sourceGroundingInstagramPostId: approvalPublicFields.instagramPostId,
    sourceGroundingInstagramPostUrl: approvalPublicFields.instagramPostUrl,
    sourceGroundingInstagramHandle: "qa_venue",
    sourceGroundingVersion: 4,
    sourceGroundingEvidence: "instagram_caption",
    approvalTitleSensible: true,
    approvalCaptionSourceCoherent: true,
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
  for (const title of [
    "World Cup Final",
    "Finale Svetskog prvenstva 2026",
    "Street Party",
    "Open Air Summer Season Closing",
    "Every Thursday Night",
    "Docile Bodies",
    "I Bog stvori trans",
  ]) {
    assert.equal(
      isSensibleEventTitleForApproval({ title, venue: "QA Venue" }),
      true,
      `Expected a sensible event title: ${title}`,
    );
  }
  for (const title of [
    "FINAL",
    "petak 17.7",
    "🗓️ 20",
    "Karađorđeva 44 2nd Floor",
    "i njegov trio održaće Koncert",
    "SPECIAL PIZZA AND KOKTELS IN BUFFALO 50",
    "Closed for vacation",
    "QA Venue",
  ]) {
    assert.equal(
      isSensibleEventTitleForApproval({ title, venue: "QA Venue" }),
      false,
      `Expected an unusable event title: ${title}`,
    );
  }
  assert.equal(
    isSensibleEventTitleForApproval({
      title: "Cantina de Frida hours",
      venue: "Cantina de Frida",
    }),
    false,
    "A venue opening-hours label must not be approvable as an event title.",
  );
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
  const explicitUngroundedTimeFields = {
    ...JSON.parse(completeSourceGroundedApproval),
    time: "21:00",
    sourceGroundingTimeVerified: true,
    moderationSignals: [],
  };
  assert.throws(
    () =>
      assertServiceCreateEventPolicy(
        "approved",
        JSON.stringify(explicitUngroundedTimeFields),
        { ...approvalPublicFields, time: "21:00" },
      ),
    /cannot approve an event/,
    "An explicit public time must appear in the exact source caption.",
  );
  assert.throws(
    () =>
      assertServiceCreateEventPolicy(
        "approved",
        JSON.stringify({
          ...JSON.parse(completeSourceGroundedApproval),
          sourceGroundingInstagramHandle: "qa.venue",
        }),
        approvalPublicFields,
      ),
    /cannot approve an event/,
    "Source handles that differ only after punctuation erasure must not be considered equal.",
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
    ["sourceCaption", "UNRELATED SOURCE CAPTION"],
    ["instagramPostId", "unrelated-post-id"],
    ["instagramPostUrl", "https://www.instagram.com/p/unrelated-post-id/"],
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
    () =>
      assertServiceCreateEventPolicy(
        "approved",
        JSON.stringify({
          ...JSON.parse(completeSourceGroundedApproval),
          sourceGroundingSourceKind: "alt_text",
          sourceGroundingSourceCaption: null,
          postAltText: "UNRELATED ALT TEXT",
        }),
        approvalPublicFields,
      ),
    /cannot approve an event/,
    "Alt-text-only metadata must not authorize automatic publication.",
  );
  assert.throws(
    () =>
      assertServiceCreateEventPolicy(
        "approved",
        JSON.stringify({
          ...JSON.parse(completeSourceGroundedApproval),
          sourceGroundingSourceCaption:
            "Unrelated Showcase 30. jul @ QA Venue uz QA Artist",
        }),
        {
          ...approvalPublicFields,
          sourceCaption: "Unrelated Showcase 30. jul @ QA Venue uz QA Artist",
        },
      ),
    /cannot approve an event/,
    "A self-consistent but unrelated caption attestation must not authorize publication.",
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
  const previousAdminUserIds = process.env.ADMIN_CLERK_USER_IDS;
  const serviceSecret = "qa-service-approval-boundary-secret";
  const adminUserId = "qa-admin-user";
  process.env.CRON_SECRET = serviceSecret;
  process.env.ADMIN_CLERK_USER_IDS = adminUserId;

  const sourceCaption =
    "Grounded Handler Event 30. jul @ Grounded Handler Venue uz Grounded Handler Artist";
  const instagramPostUrl = "https://www.instagram.com/p/qa-handler-boundary/";
  const instagramPostId = "qa-handler-boundary";
  const normalizedFieldsJson = JSON.stringify({
    title: "Grounded Handler Event",
    time: TBD_EVENT_TIME,
    artists: ["Grounded Handler Artist"],
    postAltText: null,
    sourceGroundingSourceKind: "caption",
    sourceGroundingSourceCaption: sourceCaption,
    sourceGroundingInstagramPostId: instagramPostId,
    sourceGroundingInstagramPostUrl: instagramPostUrl,
    sourceGroundingInstagramHandle: "qa_venue",
    sourceGroundingVersion: 4,
    sourceGroundingEvidence: "instagram_caption",
    approvalTitleSensible: true,
    approvalCaptionSourceCoherent: true,
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
    sourceCaption,
    sourcePostedAt: "2026-07-01T12:00:00.000Z",
    instagramPostUrl,
    instagramPostId,
    eventType: "nightlife",
    status: "approved",
    normalizedFieldsJson,
  };
  let inserted = false;
  let patched = false;
  let lastPatch = null;
  let lastAudit = null;
  let sameDateEvents = [];
  let existingVenue = groundedPublicFields.venue;
  let existingVenueInstagramHandle = "qa_venue";
  let persistedSourcePost = {
    handle: "qa_venue",
    username: "qa_venue",
    postId: instagramPostId,
    instagramPostUrl,
    caption: sourceCaption,
    postedAt: "2026-07-01T12:00:00.000Z",
  };
  const fakeDb = {
    get: async () => ({
      _id: "qa-existing-event",
      ...groundedPublicFields,
      venue: existingVenue,
      venueInstagramHandle: existingVenueInstagramHandle,
      status: "pending",
      updatedAt: 1,
    }),
    insert: async (table, value) => {
      if (table === "eventAuditLog") {
        lastAudit = value;
        return "qa-audit-row";
      }
      inserted = true;
      return "qa-created-event";
    },
    patch: async (_id, patch) => {
      patched = true;
      lastPatch = patch;
    },
    query: (table) =>
      table === "venues"
        ? {
            collect: async () => [
              {
                _id: "qa-venue-id",
                name: "Grounded Handler Venue",
                instagramHandle: "qa_venue",
                category: "nightlife",
                publicStatus: "published",
              },
            ],
            take: async (limit) => [
              {
                _id: "qa-venue-id",
                name: "Grounded Handler Venue",
                instagramHandle: "qa_venue",
                category: "nightlife",
                publicStatus: "published",
              },
            ].slice(0, limit),
          }
        : table === "venueIdentities"
          ? {
              withIndex: () => ({ take: async () => [] }),
            }
        : table === "scrapedPosts"
          ? {
              withIndex: () => ({
                first: async () => persistedSourcePost,
                take: async (limit) => (persistedSourcePost && limit > 0 ? [persistedSourcePost] : []),
              }),
            }
          : {
              withIndex: () => ({
                collect: async () => sameDateEvents,
                first: async () => null,
                take: async (limit) => sameDateEvents.slice(0, limit),
              }),
            },
  };
  const ctx = {
    auth: { getUserIdentity: async () => ({ subject: adminUserId }) },
    db: fakeDb,
  };

  try {
    const trustedSourceCaption =
      "Koncert Trusted Venue Announcement 31.12.2099 at Grounded Handler Venue uz Grounded Handler Artist";
    const trustedPostId = "qa-trusted-handler-boundary";
    const trustedPostUrl = `https://www.instagram.com/p/${trustedPostId}/`;
    const trustedNormalizedFieldsJson = JSON.stringify({
      title: "Trusted Venue Announcement",
      normalizedDate: "2099-12-31",
      normalizedVenue: "Grounded Handler Venue",
      trustedVenueSource: true,
      normalizedIsValid: true,
      titleUsedFallback: false,
      dateSuspiciousYear: false,
      dateConfidence: "high",
      moderationConfidenceScore: 0.72,
      moderationAutoApproved: true,
      moderationAutoApproveRule: "trusted_source_event_announcement",
      moderationPendingReasons: [],
      moderationSignals: ["unverified_core_event_source"],
      sourceGroundingInstagramHandle: "qa_venue",
      sourceGroundingTitleVerified: true,
      sourceGroundingDateVerified: true,
      sourceGroundingIdentityContextVerified: true,
      sourceGroundingSourceCaption: trustedSourceCaption,
      sourceGroundingInstagramPostId: trustedPostId,
      sourceGroundingInstagramPostUrl: trustedPostUrl,
    });
    const trustedOriginalPersistedSourcePost = persistedSourcePost;
    persistedSourcePost = {
      ...persistedSourcePost,
      postId: trustedPostId,
      instagramPostUrl: trustedPostUrl,
      caption: trustedSourceCaption,
    };
    inserted = false;
    await createEvent._handler(ctx, {
      ...groundedPublicFields,
      title: "Trusted Venue Announcement",
      date: "2099-12-31",
      instagramPostId: trustedPostId,
      instagramPostUrl: trustedPostUrl,
      sourceCaption: trustedSourceCaption,
      normalizedFieldsJson: trustedNormalizedFieldsJson,
      serviceSecret,
    });
    assert.equal(
      inserted,
      true,
      "The real service mutation must allow an evidence-bound trusted venue announcement.",
    );

    for (const unsafeTrustedCase of [
      { label: "unknown mapping", patch: { trustedVenueSource: false } },
      { label: "non-event", patch: { moderationSignals: ["non_event_closure_notice"] } },
      { label: "past date", patch: { normalizedDate: "2020-12-31" }, eventPatch: { date: "2020-12-31" } },
      { label: "cross-venue", patch: { sourceGroundingInstagramHandle: "other_venue" } },
      { label: "fabricated title", patch: { sourceGroundingTitleVerified: false } },
      { label: "fabricated date", patch: { sourceGroundingDateVerified: false } },
    ]) {
      inserted = false;
      await assert.rejects(
        () =>
          createEvent._handler(ctx, {
            ...groundedPublicFields,
            title: "Trusted Venue Announcement",
            date: "2099-12-31",
            normalizedFieldsJson: JSON.stringify({
              ...JSON.parse(trustedNormalizedFieldsJson),
              ...unsafeTrustedCase.patch,
            }),
            ...unsafeTrustedCase.eventPatch,
            serviceSecret,
          }),
        /bound to the public fields/,
        `The real service mutation must reject trusted-source ${unsafeTrustedCase.label}.`,
      );
      assert.equal(inserted, false);
    }
    persistedSourcePost = trustedOriginalPersistedSourcePost;

    const genericCaption = "A calm evening at Grounded Handler Venue on 31.12.2099.";
    persistedSourcePost = {
      ...persistedSourcePost,
      postId: trustedPostId,
      instagramPostUrl: trustedPostUrl,
      caption: genericCaption,
    };
    inserted = false;
    await assert.rejects(
      () =>
        createEvent._handler(ctx, {
          ...groundedPublicFields,
          title: "Trusted Venue Announcement",
          date: "2099-12-31",
          instagramPostId: trustedPostId,
          instagramPostUrl: trustedPostUrl,
          sourceCaption: genericCaption,
          normalizedFieldsJson: JSON.stringify({
            ...JSON.parse(trustedNormalizedFieldsJson),
            sourceGroundingSourceCaption: genericCaption,
          }),
          serviceSecret,
        }),
      /bound to the public fields/,
      "A generic venue post with a date but no event announcement evidence must not publish.",
    );
    assert.equal(inserted, false);
    persistedSourcePost = trustedOriginalPersistedSourcePost;

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
      /(?:bound to the public fields|resolved source venue handle)/,
      "The real create mutation must reject an attestation for different public fields.",
    );
    assert.equal(inserted, false);

    patched = false;
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

    const ticketClearDecision = buildDuplicateUpdatePatch(
      {
        ...groundedPublicFields,
        status: "pending",
        imageUrl: undefined,
        ticketPrice: "2500 RSD",
      },
      {
        ...groundedPublicFields,
        status: "pending",
        imageUrl: undefined,
        ticketPrice: undefined,
      },
    );
    assert.equal(ticketClearDecision.patch.clearTicketPrice, true);
    assert.equal(Object.hasOwn(ticketClearDecision.patch, "ticketPrice"), false);

    lastPatch = null;
    lastAudit = null;
    await updateEvent._handler(ctx, {
      id: "qa-existing-event",
      expectedStatus: "pending",
      serviceSecret,
      patch: { clearTicketPrice: ticketClearDecision.patch.clearTicketPrice },
    });
    assert.equal(patched, true);
    assert.equal(lastPatch.ticketPrice, undefined);
    assert.equal(
      Object.hasOwn(lastPatch, "clearTicketPrice"),
      false,
      "The transport-only clear flag must never be written to the event document.",
    );
    assert.equal(JSON.parse(lastAudit.patchJson).clearTicketPrice, true);
    patched = false;

    const sourceSwapCases = [
      {
        label: "caption",
        createPatch: { sourceCaption: "UNRELATED SOURCE CAPTION" },
        updatePatch: { sourceCaption: "UNRELATED SOURCE CAPTION" },
      },
      {
        label: "post ID",
        createPatch: { instagramPostId: "unrelated-post-id" },
        updatePatch: { instagramPostId: "unrelated-post-id" },
      },
      {
        label: "post URL",
        createPatch: {
          instagramPostUrl: "https://www.instagram.com/p/unrelated-post-id/",
        },
        updatePatch: {
          instagramPostUrl: "https://www.instagram.com/p/unrelated-post-id/",
        },
      },
      {
        label: "source account",
        normalizedFieldsJson: JSON.stringify({
          ...JSON.parse(normalizedFieldsJson),
          sourceGroundingInstagramHandle: "unrelated_venue",
        }),
        createPatch: {},
        updatePatch: {},
      },
      {
        label: "self-consistent unrelated caption",
        normalizedFieldsJson: JSON.stringify({
          ...JSON.parse(normalizedFieldsJson),
          sourceGroundingSourceCaption:
            "Unrelated Showcase 30. jul @ Grounded Handler Venue uz Grounded Handler Artist",
        }),
        createPatch: {
          sourceCaption:
            "Unrelated Showcase 30. jul @ Grounded Handler Venue uz Grounded Handler Artist",
        },
        updatePatch: {
          sourceCaption:
            "Unrelated Showcase 30. jul @ Grounded Handler Venue uz Grounded Handler Artist",
        },
      },
      {
        label: "alt-text-only source",
        normalizedFieldsJson: JSON.stringify({
          ...JSON.parse(normalizedFieldsJson),
          sourceGroundingSourceKind: "alt_text",
          sourceGroundingSourceCaption: null,
          postAltText: "UNRELATED ALT TEXT",
        }),
        createPatch: {},
        updatePatch: {},
      },
    ];
    for (const testCase of sourceSwapCases) {
      inserted = false;
      patched = false;
      const candidateNormalizedFieldsJson =
        testCase.normalizedFieldsJson ?? normalizedFieldsJson;
      await assert.rejects(
        () =>
          createEvent._handler(ctx, {
            ...groundedPublicFields,
            ...testCase.createPatch,
            normalizedFieldsJson: candidateNormalizedFieldsJson,
            serviceSecret,
          }),
        /bound to the public fields/,
        `The real create mutation must reject a swapped ${testCase.label}.`,
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
              normalizedFieldsJson: candidateNormalizedFieldsJson,
              ...testCase.updatePatch,
            },
          }),
        /bound to the public fields/,
        `The real update mutation must reject a swapped ${testCase.label}.`,
      );
      assert.equal(patched, false);
    }

    const forgedPostId = "forged-handler-post";
    const forgedPostUrl = `https://www.instagram.com/reel/${forgedPostId}/`;
    const forgedCaption =
      "Forged Handler Event 30. jul @ Grounded Handler Venue uz Grounded Handler Artist";
    const forgedNormalizedFieldsJson = JSON.stringify({
      ...JSON.parse(normalizedFieldsJson),
      title: "Forged Handler Event",
      sourceGroundingSourceCaption: forgedCaption,
      sourceGroundingInstagramPostId: forgedPostId,
      sourceGroundingInstagramPostUrl: forgedPostUrl,
    });
    await assert.rejects(
      () =>
        createEvent._handler(ctx, {
          ...groundedPublicFields,
          title: "Forged Handler Event",
          sourceCaption: forgedCaption,
          instagramPostId: forgedPostId,
          instagramPostUrl: forgedPostUrl,
          normalizedFieldsJson: forgedNormalizedFieldsJson,
          serviceSecret,
        }),
      /persisted Instagram post/,
      "A self-consistent caption, post-ID, and URL swap must fail against the persisted source post.",
    );
    assert.equal(inserted, false);

    const originalPersistedSourcePost = persistedSourcePost;
    const forgedGroundingCases = [
      {
        label: "hashtag-only source identity",
        title: "HashtagOnly",
        date: "2026-07-30",
        artists: [],
        caption: "#HashtagOnly 30. jul",
      },
      {
        label: "giveaway language without a positive event occurrence",
        title: "Grounded Handler Event",
        date: "2026-07-30",
        artists: ["Grounded Handler Artist"],
        caption:
          "Giveaway Grounded Handler Event 30. jul @ Grounded Handler Venue uz Grounded Handler Artist",
      },
      {
        label: "title and date stitched across source blocks",
        title: "Grounded Handler Event",
        date: "2026-07-30",
        artists: ["Grounded Handler Artist"],
        caption:
          "Grounded Handler Event\n30. jul @ Grounded Handler Venue uz Grounded Handler Artist",
      },
      {
        label: "implausible caller-forged source year",
        title: "Grounded Handler Event",
        date: "2099-07-30",
        artists: ["Grounded Handler Artist"],
        caption:
          "Grounded Handler Event 30. jul @ Grounded Handler Venue uz Grounded Handler Artist",
      },
    ];
    for (const forged of forgedGroundingCases) {
      persistedSourcePost = {
        ...originalPersistedSourcePost,
        caption: forged.caption,
      };
      const forgedGroundingJson = JSON.stringify({
        ...JSON.parse(normalizedFieldsJson),
        title: forged.title,
        artists: forged.artists,
        normalizedDate: forged.date,
        sourceGroundingSourceCaption: forged.caption,
        sourceGroundingArtistsVerified: forged.artists.length > 0 ? true : null,
      });
      inserted = false;
      await assert.rejects(
        () =>
          createEvent._handler(ctx, {
            ...groundedPublicFields,
            title: forged.title,
            date: forged.date,
            artists: forged.artists,
            sourceCaption: forged.caption,
            normalizedFieldsJson: forgedGroundingJson,
            serviceSecret,
          }),
        /(?:cannot approve|independently ground)/,
        `The real service mutation must reject ${forged.label}.`,
      );
      assert.equal(inserted, false, `${forged.label} must perform no event insert.`);
    }
    persistedSourcePost = originalPersistedSourcePost;

    sameDateEvents = [];
    inserted = false;
    await assert.doesNotReject(() =>
      createEvent._handler(ctx, {
        ...groundedPublicFields,
        serviceSecret,
      }),
    );
    assert.equal(inserted, true, "A fully bound unique service create should write.");

    patched = false;
    await assert.doesNotReject(() =>
      updateEvent._handler(ctx, {
        id: "qa-existing-event",
        expectedStatus: "pending",
        serviceSecret,
        patch: {
          status: "approved",
          normalizedFieldsJson,
        },
      }),
    );
    assert.equal(patched, true, "A fully bound unique pending promotion should write.");

    sameDateEvents = [
      {
        _id: "qa-approved-conflict",
        title: "Other Approved Event",
        date: groundedPublicFields.date,
        venue: groundedPublicFields.venue,
        venueId: "qa-venue-id",
        status: "approved",
      },
    ];
    inserted = false;
    patched = false;
    await assert.rejects(
      () =>
        createEvent._handler(ctx, {
          ...groundedPublicFields,
          serviceSecret,
        }),
      /same-day occurrence is ambiguous/,
      "Service create must keep an unresolved same-day occurrence out of the public feed.",
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
          },
        }),
      /same-day occurrence is ambiguous/,
      "Service update must keep an unresolved same-day occurrence out of the public feed.",
    );
    assert.equal(patched, false);

    sameDateEvents = [
      {
        _id: "qa-approved-first-occurrence",
        title: "Grounded Handler Event",
        date: groundedPublicFields.date,
        time: "19:00",
        venue: groundedPublicFields.venue,
        venueId: "qa-venue-id",
        instagramPostId,
        instagramPostUrl,
        sourceOccurrenceKey: "occurrence:first",
        status: "approved",
      },
    ];
    const secondOccurrenceFieldsJson = JSON.stringify({
      ...JSON.parse(normalizedFieldsJson),
      sourceOccurrenceKey: "occurrence:second",
    });
    inserted = false;
    await assert.doesNotReject(() =>
      createEvent._handler(ctx, {
        ...groundedPublicFields,
        normalizedFieldsJson: secondOccurrenceFieldsJson,
        serviceSecret,
      }),
    );
    assert.equal(
      inserted,
      true,
      "A second source-keyed occurrence at the same venue/date must persist independently.",
    );

    inserted = false;
    await assert.rejects(
      () =>
        createEvent._handler(ctx, {
          ...groundedPublicFields,
          normalizedFieldsJson: JSON.stringify({
            ...JSON.parse(normalizedFieldsJson),
            sourceOccurrenceKey: "occurrence:first",
          }),
          serviceSecret,
        }),
      /canonical occurrence/,
      "The exact same source occurrence key must still be rejected as a duplicate.",
    );
    assert.equal(inserted, false);

    sameDateEvents = [
      {
        _id: "qa-approved-conflict",
        title: "Other Approved Event",
        date: groundedPublicFields.date,
        venue: groundedPublicFields.venue,
        venueId: "qa-venue-id",
        status: "approved",
      },
    ];
    existingVenue = "@qa_venue";
    existingVenueInstagramHandle = undefined;
    patched = false;
    await assert.rejects(
      () =>
        setEventStatus._handler(ctx, {
          id: "qa-existing-event",
          status: "approved",
          reviewedBy: adminUserId,
        }),
      /same-day occurrence is ambiguous/,
      "Manual moderation must resolve a legacy venue alias before classifying the occurrence.",
    );
    assert.equal(patched, false);

    sameDateEvents = [
      {
        _id: "qa-approved-source-duplicate",
        title: "Different Title",
        date: groundedPublicFields.date,
        venue: "Different Venue",
        instagramPostId,
        instagramPostUrl: `https://www.instagram.com/reel/${instagramPostId}/`,
        status: "approved",
      },
    ];
    await assert.rejects(
      () =>
        setEventStatus._handler(ctx, {
          id: "qa-existing-event",
          status: "approved",
          reviewedBy: adminUserId,
        }),
      /same-day occurrence is ambiguous/,
      "One post may contain multiple events, but an occurrence with no distinct key/time must remain ambiguous.",
    );
    assert.equal(patched, false);
  } finally {
    if (previousCronSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = previousCronSecret;
    }
    if (previousAdminUserIds === undefined) {
      delete process.env.ADMIN_CLERK_USER_IDS;
    } else {
      process.env.ADMIN_CLERK_USER_IDS = previousAdminUserIds;
    }
  }
}

async function runHardMappedVenueAuthorityMutationBoundaryQa() {
  const previousCronSecret = process.env.CRON_SECRET;
  const serviceSecret = "qa-hard-mapped-venue-authority-secret";
  process.env.CRON_SECRET = serviceSecret;

  const eventDate = isoDateDaysFromNow(7);
  const eventDateLabel = ddmmForIsoDate(eventDate);
  const [, month, day] = eventDate.split("-");
  const eventDateText = `${Number(day)}. ${SERBIAN_MONTH_GENITIVES[Number(month) - 1]}`;
  const sourceCaption = [
    `ℹ️ Beogradski koncert Joss Stone ${eventDateText} seli se u Ložionicu!`,
    `Beogradski koncert britanske zvezde Joss Stone, zakazan za petak, ${eventDateText}, biće održan u prostoru Ložionice.`,
  ].join("\n");
  const instagramPostId = "qa-kcgrad-lozionica-authority";
  const instagramPostUrl = `https://www.instagram.com/p/${instagramPostId}/`;
  const prepared = prepareEventsForInsert(
    makeInstagramPost({
      postId: instagramPostId,
      instagramPostUrl,
      caption: sourceCaption,
      postType: "image",
      username: "kcgrad",
    }),
    makeExtractedEvent({
      title: "Joss Stone",
      date: eventDateLabel,
      time: "",
      venue: "Ložionica",
      artists: ["Joss Stone"],
      category: "live music",
      description: "Joss Stone concert at Ložionica.",
      source_caption: sourceCaption,
      schedule_entries: [
        {
          date: eventDateLabel,
          time: "",
          title: "Joss Stone",
          artists: ["Joss Stone"],
          description: "Joss Stone concert at Ložionica.",
          source_text: `JOSS STONE ${eventDateLabel}. LOŽIONICA`,
        },
      ],
    }),
    "https://cdn.example.com/joss-stone-hard-mapped-boundary.jpg",
    { kcgrad: "KC Grad" },
    { kcgrad: "KC Grad" },
    { kcgrad: "KC Grad" },
  );

  assert.equal(prepared.length, 2);
  const firstPrepared = prepared[0];
  assert.equal(firstPrepared.kind, "ok");
  assert.equal(firstPrepared.event.status, "pending");
  assert.equal(firstPrepared.event.venue, "KC Grad");

  let insertedEvent = null;
  const ctx = {
    auth: { getUserIdentity: async () => null },
    db: {
      get: async (id) =>
        id === "qa-hard-mapped-event" && insertedEvent
          ? { _id: id, ...insertedEvent }
          : null,
      insert: async (table, value) => {
        if (table === "events") {
          insertedEvent = value;
          return "qa-hard-mapped-event";
        }
        return "qa-hard-mapped-audit";
      },
      patch: async (id, patch) => {
        if (id !== "qa-hard-mapped-event" || !insertedEvent) {
          throw new Error(`Unexpected hard-mapped event patch ${id}`);
        }
        insertedEvent = { ...insertedEvent, ...structuredClone(patch) };
      },
      query: (table) =>
        table === "venues"
        ? {
            collect: async () => [
                {
                  _id: "qa-kcgrad-venue",
                  name: "KC Grad",
                  instagramHandle: "kcgrad",
                  category: "culture",
                publicStatus: "published",
              },
            ],
            take: async (limit) => [
              {
                _id: "qa-kcgrad-venue",
                name: "KC Grad",
                instagramHandle: "kcgrad",
                category: "culture",
                publicStatus: "published",
              },
            ].slice(0, limit),
          }
        : table === "venueIdentities"
          ? {
              withIndex: () => ({ take: async () => [] }),
            }
        : {
              withIndex: () => ({
                collect: async () => [],
                first: async () => null,
                take: async () => [],
              }),
            },
    },
  };

  try {
    await createEvent._handler(ctx, {
      ...firstPrepared.event,
      serviceSecret,
    });
    assert.equal(insertedEvent?.status, "pending");
    assert.equal(insertedEvent?.venue, "KC Grad");
    assert.equal(insertedEvent?.venueInstagramHandle, "kcgrad");
  } finally {
    if (previousCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousCronSecret;
  }
}

async function withoutConsoleInfo(callback) {
  const originalConsoleInfo = console.info;
  console.info = () => {};
  try {
    return await callback();
  } finally {
    console.info = originalConsoleInfo;
  }
}

async function withoutConsoleInfoAndError(callback) {
  const originalConsoleInfo = console.info;
  const originalConsoleError = console.error;
  console.info = () => {};
  console.error = () => {};
  try {
    return await callback();
  } finally {
    console.info = originalConsoleInfo;
    console.error = originalConsoleError;
  }
}

function ingestionQueryResult(reference, candidates = []) {
  return reference === "sourceOccurrences:listCandidatesForNormalizedOccurrence"
    ? {
        candidates,
        complete: true,
        limit: 25,
        venueResolutionStatus: candidates.length > 0 ? "resolved" : "unresolved",
      }
    : candidates;
}

function emptyIngestionQueryResult(reference) {
  return ingestionQueryResult(reference);
}

async function runDistinctOccurrencePersistenceQa() {
  assert.equal(areEventTimesCompatibleForTesting("19.30", "19:30"), true);
  assert.equal(areEventTimesCompatibleForTesting("21h30", "21:30"), true);
  assert.equal(areEventTimesCompatibleForTesting("7:30 pm", "19:30"), true);
  assert.equal(areEventTimesCompatibleForTesting("12 am", "00:00"), true);
  assert.equal(areEventTimesCompatibleForTesting("19.30", "20:30"), false);

  const eventDate = isoDateDaysFromNow(7);
  const eventDateLabel = ddmmForIsoDate(eventDate);
  const sourceCaption = [
    `${eventDateLabel} - Joss Stone 19H`,
    `${eventDateLabel} - Joss Stone 22H`,
  ].join("\n");
  const post = makeInstagramPost({
    postId: "qa-distinct-occurrence-persistence",
    instagramPostUrl: "https://www.instagram.com/p/qa-distinct-occurrence-persistence/",
    caption: sourceCaption,
    postType: "video",
    username: "tickets.rs",
  });
  const extracted = makeExtractedEvent({
    title: "Joss Stone",
    date: eventDateLabel,
    time: "19:00",
    venue: "Ložionica",
    artists: ["Joss Stone"],
    category: "live music",
    description: "Joss Stone concert at Ložionica.",
    source_caption: sourceCaption,
    schedule_entries: [
      {
        date: eventDateLabel,
        time: "19:00",
        title: "Joss Stone",
        artists: ["Joss Stone"],
        description: "Joss Stone concert at Ložionica.",
        source_text: `${eventDateLabel} - Joss Stone 19H`,
      },
    ],
  });
  const summary = createEmptyIngestionSummary(["tickets.rs"]).handles[0];
  const inserted = [];
  const updated = [];
  const client = {
    query: async (reference) => emptyIngestionQueryResult(reference),
    mutation: async (reference, args) => {
      if (reference === "reconciliationIngress:reconcileIngestionPlan") {
        return { authority: "legacy", outcomes: [] };
      }
      if ("id" in args) {
        updated.push(args);
        return { updatedAt: 1000 + updated.length };
      }
      const updatedAt = inserted.length + 1;
      inserted.push({ ...args, updatedAt });
      return {
        eventId: `qa-distinct-occurrence-${inserted.length}`,
        created: true,
        updatedAt,
      };
    },
  };

  await withoutConsoleInfo(() =>
    processIngestionPostWithExtractionForTesting({
      client,
      handle: "tickets.rs",
      post,
      summary,
      canonicalVenueNamesByHandle: { "tickets.rs": "Ložionica" },
      venueNameOverridesByHandle: {},
      configuredVenueNamesByHandle: { "tickets.rs": "Ložionica" },
      serviceSecret: "qa-distinct-occurrence-secret",
      extracted,
    }),
  );

  assert.equal(
    inserted.length,
    2,
    "The real ingestion persistence loop must insert both same-source occurrences when their explicit times differ.",
  );
  assert.equal(updated.length, 0, "A distinct second occurrence must not overwrite the first row.");
  assert.deepEqual(
    inserted.map((event) => ({
      time: event.time,
      splitSourceLine: JSON.parse(event.normalizedFieldsJson).splitSourceLine,
      sourceOccurrenceExpectedCount: JSON.parse(event.normalizedFieldsJson)
        .sourceOccurrenceExpectedCount,
    })),
    sourceCaption.split("\n").map((splitSourceLine, index) => ({
      time: index === 0 ? "19:00" : "22:00",
      splitSourceLine,
      sourceOccurrenceExpectedCount: 2,
    })),
    "Both persisted records must retain their distinct time and exact split-row provenance.",
  );
  assert.equal(summary.insertedEvents, 2);
  assert.equal(summary.skippedDuplicates, 0);
  assert.equal(summary.updated_duplicates_bad_data, 0);
  assert.match(
    inserted[0].sourceOccurrenceKey,
    /^instagram-occurrence-v2:[a-f0-9]{64}$/,
  );
  assert.notEqual(
    inserted[0].sourceOccurrenceKey,
    inserted[1].sourceOccurrenceKey,
    "Distinct source children must receive distinct atomic occurrence keys.",
  );

  const sharedSlotSourceText = `${eventDateLabel} ALICE BOB 21H`;
  const sharedSlotPost = {
    ...post,
    postId: "qa-shared-slot-occurrences",
    instagramPostUrl: "https://www.instagram.com/p/qa-shared-slot-occurrences/",
    caption: sharedSlotSourceText,
  };
  const sharedSlotBaseFields = {
    multiEventSplitDetected: true,
    multiEventSplitCount: 2,
    splitSourceLine: sharedSlotSourceText,
    rowSourceText: sharedSlotSourceText,
  };
  const sharedSlotBound = bindSourceOccurrenceMetadata(
    sharedSlotPost,
    ["ALICE", "BOB"].map((title, index) => ({
      kind: "ok",
      normalizedFields: {
        ...sharedSlotBaseFields,
        splitEventIndex: index + 1,
      },
      event: {
        ...inserted[0],
        title,
        artists: [title],
        time: "21:00",
        status: "approved",
      },
    })),
  );
  assert.equal(sharedSlotBound.length, 2);
  assert.ok(sharedSlotBound.every((prepared) => prepared.kind === "ok"));
  const sharedSlotEvents = sharedSlotBound.map((prepared) => prepared.event);
  assert.notEqual(
    sharedSlotEvents[0].sourceOccurrenceKey,
    sharedSlotEvents[1].sourceOccurrenceKey,
  );
  for (const event of sharedSlotEvents) {
    assert.equal(event.status, "pending");
    assert.equal(
      JSON.parse(event.normalizedFieldsJson).sourceOccurrenceAmbiguousProvenance,
      true,
    );
  }
  const originalSharedSlotMatches = sharedSlotEvents.map((event, index) => ({
    existingEvent: {
      ...event,
      _id: `qa-shared-slot-existing-${index + 1}`,
    },
    matchedBy: "post_id",
    matchedValue: sharedSlotPost.postId,
  }));
  const reversedSharedSlotResults = bindSourceOccurrenceMetadata(sharedSlotPost, [
    {
      kind: "ok",
      event: {
        ...sharedSlotEvents[1],
        sourceOccurrenceKey: undefined,
        normalizedFieldsJson: JSON.stringify(sharedSlotBaseFields),
      },
      normalizedFields: { ...sharedSlotBaseFields },
    },
    {
      kind: "ok",
      event: {
        ...sharedSlotEvents[0],
        sourceOccurrenceKey: undefined,
        normalizedFieldsJson: JSON.stringify(sharedSlotBaseFields),
      },
      normalizedFields: { ...sharedSlotBaseFields },
    },
  ]);
  const reversedBob = reversedSharedSlotResults[0];
  assert.equal(reversedBob.kind, "ok");
  const reconciledReversedSharedSlotResults =
    reconcileAmbiguousOccurrenceKeysWithExistingEventsForTesting(
      reversedSharedSlotResults,
      [originalSharedSlotMatches[0]],
    );
  assert.equal(reconciledReversedSharedSlotResults[0].kind, "ok");
  assert.equal(reconciledReversedSharedSlotResults[1].kind, "ok");
  assert.equal(
    reconciledReversedSharedSlotResults[0].event.sourceOccurrenceKey,
    sharedSlotEvents[1].sourceOccurrenceKey,
    "An unmatched reordered sibling must receive the free ordinal key.",
  );
  assert.equal(
    reconciledReversedSharedSlotResults[1].event.sourceOccurrenceKey,
    sharedSlotEvents[0].sourceOccurrenceKey,
    "A semantic sibling must retain its persisted ordinal key after reordering.",
  );
  assert.deepEqual(
    new Set(
      JSON.parse(reconciledReversedSharedSlotResults[0].event.normalizedFieldsJson)
        .sourceOccurrenceExpectedKeys,
    ),
    new Set(sharedSlotEvents.map((event) => event.sourceOccurrenceKey)),
  );
  assert.equal(
    findBestExistingMatchForPreparedEventForTesting(
      originalSharedSlotMatches,
      reversedBob.event,
      reversedBob.normalizedFields,
    )?.existingEvent._id,
    "qa-shared-slot-existing-2",
    "Ambiguous siblings must match by stable semantic identity before ordinal keys when extraction order changes.",
  );
  assert.equal(
    findBestExistingMatchForPreparedEventForTesting(
      [originalSharedSlotMatches[0]],
      reversedBob.event,
      reversedBob.normalizedFields,
    ),
    null,
  );
  assert.equal(
    hasIncompleteAmbiguousCollisionContextForTesting(
      [originalSharedSlotMatches[0]],
      reversedBob.event,
      reversedBob.normalizedFields,
    ),
    true,
    "A reordered partial retry whose ordinal collides with another sibling must defer.",
  );
  const originalBobFields = JSON.parse(sharedSlotEvents[1].normalizedFieldsJson);
  assert.equal(
    hasIncompleteAmbiguousCollisionContextForTesting(
      [originalSharedSlotMatches[0]],
      sharedSlotEvents[1],
      originalBobFields,
    ),
    false,
    "A missing sibling with a free stable ordinal must remain insertable.",
  );

  const occupiedCollisionBaseFields = {
    ...sharedSlotBaseFields,
    multiEventSplitCount: 3,
    normalizedDate: sharedSlotEvents[0].date,
    time: "21:00",
    normalizedVenue: sharedSlotEvents[0].venue,
  };
  const makeOccupiedCollisionPrepared = (title, artists, index) => ({
    kind: "ok",
    event: {
      ...sharedSlotEvents[0],
      title,
      artists,
      sourceOccurrenceKey: undefined,
    },
    normalizedFields: {
      ...occupiedCollisionBaseFields,
      title,
      artists,
      splitEventIndex: index + 1,
    },
  });
  const occupiedExistingResults = bindSourceOccurrenceMetadata(
    sharedSlotPost,
    [
      ["Unrelated stale child", []],
      ["Chillout Zone", []],
      ["INFECTED", []],
    ].map(([title, artists], index) =>
      makeOccupiedCollisionPrepared(title, artists, index),
    ),
  );
  const occupiedExistingMatches = occupiedExistingResults.map((prepared, index) => ({
    existingEvent: {
      ...prepared.event,
      _id: `qa-occupied-collision-${index + 1}`,
    },
    matchedBy: "post_id",
    matchedValue: sharedSlotPost.postId,
  }));
  const occupiedRetryResults = bindSourceOccurrenceMetadata(
    sharedSlotPost,
    [
      ["Chillout Zone", []],
      ["INFECTED", []],
      ["Bodies Hit The Floor", ["DJ Hellspawn", "DJ Kedlavi", "DJ Sirivs"]],
    ].map(([title, artists], index) =>
      makeOccupiedCollisionPrepared(title, artists, index),
    ),
  );
  const occupiedRetryKeys = occupiedRetryResults.map(
    (prepared) => prepared.event.sourceOccurrenceKey,
  );
  const reconciledOccupiedRetry =
    reconcileAmbiguousOccurrenceKeysWithExistingEventsForTesting(
      occupiedRetryResults,
      occupiedExistingMatches,
    );
  assert.deepEqual(
    reconciledOccupiedRetry.map((prepared) => prepared.event.sourceOccurrenceKey),
    occupiedRetryKeys,
    "reconciliation must not partially reassign semantic siblings when the unmatched ordinal is still occupied",
  );
  assert.notEqual(
    reconciledOccupiedRetry[0].event.sourceOccurrenceKey,
    occupiedExistingResults[1].event.sourceOccurrenceKey,
    "a valid Chillout sibling may not force an unmatched Bodies child onto an occupied stale key",
  );

  const processCollisionRows = [
    {
      title: "Bodies Hit The Floor",
      artists: ["DJ Hellspawn", "DJ Kedlavi", "DJ Sirivs"],
    },
    { title: "Chillout Zone", artists: [] },
    { title: "INFECTED", artists: [] },
  ];
  const processCollisionCaption = processCollisionRows
    .map(({ title, artists }) =>
      `${eventDateLabel} - ${title}${artists.length > 0 ? ` - ${artists.join(", ")}` : ""} 21H`,
    )
    .join("\n");
  const processCollisionPost = makeInstagramPost({
    postId: "qa-process-occupied-collision",
    instagramPostUrl: "https://www.instagram.com/p/qa-process-occupied-collision/",
    caption: processCollisionCaption,
    postType: "video",
    username: "vrtoglavicaklub",
  });
  const processCollisionExtraction = makeExtractedEvent({
    title: processCollisionRows[0].title,
    date: eventDateLabel,
    time: "21:00",
    venue: "Vrtoglavica",
    artists: processCollisionRows[0].artists,
    category: "nightlife",
    confidence: 0.9,
    source_caption: processCollisionCaption,
    schedule_entries: processCollisionRows.map(({ title, artists }) => ({
      date: eventDateLabel,
      time: "21:00",
      title,
      artists,
      description: `${title} at Vrtoglavica.`,
      source_text: `${eventDateLabel} - ${title}${artists.length > 0 ? ` - ${artists.join(", ")}` : ""} 21H`,
    })),
  });
  const processCollisionPrepared = bindSourceOccurrenceMetadata(
    processCollisionPost,
    prepareEventsForInsert(
      processCollisionPost,
      processCollisionExtraction,
      null,
      { vrtoglavicaklub: "Vrtoglavica" },
      {},
      { vrtoglavicaklub: "Vrtoglavica" },
      { sourceRolesByHandle: { vrtoglavicaklub: "venue" } },
    ),
  ).filter((prepared) => prepared.kind === "ok");
  assert.equal(processCollisionPrepared.length, 3);
  assert.ok(
    processCollisionPrepared.every(
      (prepared) =>
        prepared.normalizedFields.sourceOccurrenceAmbiguousProvenance === true,
    ),
  );
  const [processBodies, processChillout, processInfected] =
    processCollisionPrepared;
  const processBodiesKey = processBodies.event.sourceOccurrenceKey;
  const processChilloutKey = processChillout.event.sourceOccurrenceKey;
  const processInfectedKey = processInfected.event.sourceOccurrenceKey;
  const processWrongBodies = {
    ...processChillout.event,
    _id: "qa-process-wrong-bodies",
    sourceOccurrenceKey: processBodiesKey,
    normalizedFieldsJson: JSON.stringify({
      ...JSON.parse(processChillout.event.normalizedFieldsJson),
      sourceOccurrenceKey: processBodiesKey,
    }),
    updatedAt: 1,
  };
  const processExistingChillout = {
    ...processChillout.event,
    _id: "qa-process-chillout",
    updatedAt: 2,
  };
  const processExistingInfected = {
    ...processInfected.event,
    _id: "qa-process-infected",
    updatedAt: 3,
  };
  const processCollisionSourceIdentity =
    "instagram-source-identity-v1:qa-process-occupied-collision";
  const processCollisionFingerprint = JSON.parse(
    processBodies.event.normalizedFieldsJson,
  ).sourceOccurrenceSourceFingerprint;
  const processCollisionReceipt = {
    sourceIdentity: processCollisionSourceIdentity,
    sourceFingerprint: processCollisionFingerprint,
    expectedKeys: processCollisionPrepared.map(
      (prepared) => prepared.event.sourceOccurrenceKey,
    ),
    expectedOccurrences: processCollisionPrepared.map((prepared) => ({
      key: prepared.event.sourceOccurrenceKey,
      date: prepared.event.date,
      ...(prepared.event.time ? { time: prepared.event.time } : {}),
      venue: prepared.event.venue,
      title: prepared.event.title,
      artists: prepared.event.artists,
    })),
    satisfiedKeys: [processChilloutKey, processInfectedKey],
    satisfiedOccurrences: [
      { key: processChilloutKey, eventId: processExistingChillout._id },
      { key: processInfectedKey, eventId: processExistingInfected._id },
    ],
    deferredChildCount: 0,
    deferredChildKeys: [],
  };
  const processCollisionMutations = [];
  const processCollisionSummary = createEmptyIngestionSummary([
    "vrtoglavicaklub",
  ]).handles[0];
  await withoutConsoleInfoAndError(() =>
    processIngestionPostWithExtractionForTesting({
      client: {
        query: async (reference) =>
          reference === "events:getInstagramSourceOccurrenceReceipt"
            ? processCollisionReceipt
            : reference ===
                "sourceOccurrences:listCandidatesForNormalizedOccurrence"
              ? {
                  candidates: [
                    processExistingChillout,
                    processExistingInfected,
                    processWrongBodies,
                  ],
                  complete: true,
                  limit: 25,
                  venueResolutionStatus: "resolved",
                }
              : [
                  processExistingChillout,
                  processExistingInfected,
                  processWrongBodies,
                ],
        mutation: async (reference, args) => {
          processCollisionMutations.push({ reference, args });
          return { recorded: true };
        },
      },
      handle: "vrtoglavicaklub",
      post: processCollisionPost,
      summary: processCollisionSummary,
      canonicalVenueNamesByHandle: { vrtoglavicaklub: "Vrtoglavica" },
      venueNameOverridesByHandle: {},
      configuredVenueNamesByHandle: { vrtoglavicaklub: "Vrtoglavica" },
      sourceRolesByHandle: { vrtoglavicaklub: "venue" },
      serviceSecret: "qa-process-occupied-collision-secret",
      extracted: processCollisionExtraction,
    }),
  );
  assert.ok(
    processCollisionSummary.errors.some((error) =>
      error.includes("occupied by a different semantic representative"),
    ),
    "the full persistence loop must expose the occupied Bodies key as an explicit repair conflict",
  );
  assert.equal(
    processCollisionMutations.some(
      ({ args }) =>
        args.satisfiedKey === processBodiesKey ||
        args.sourceOccurrenceKey === processBodiesKey,
    ),
    false,
    "the conflicting Bodies child must perform zero record, update, or create mutations",
  );

  const partialSharedSlotFields = JSON.parse(sharedSlotEvents[1].normalizedFieldsJson);
  delete partialSharedSlotFields.sourceOccurrenceAmbiguousProvenance;
  delete partialSharedSlotFields.sourceOccurrenceCollisionOrdinal;
  delete partialSharedSlotFields.rowSourceText;
  delete partialSharedSlotFields.splitSourceLine;
  assert.equal(
    hasIncompleteAmbiguousCollisionContextForTesting(
      [
        {
          existingEvent: {
            ...sharedSlotEvents[0],
            _id: "qa-shared-slot-existing",
          },
          matchedBy: "post_id",
          matchedValue: sharedSlotPost.postId,
        },
      ],
      sharedSlotEvents[1],
      partialSharedSlotFields,
    ),
    true,
    "A partial retry that loses collision-group context must defer instead of inserting a third ambiguous child.",
  );

  const mutableLineFieldsA = {
    ...sharedSlotBaseFields,
    normalizedDate: sharedSlotEvents[0].date,
    normalizedTime: sharedSlotEvents[0].time,
    rowSourceText: "ALICE 21H",
  };
  const mutableLineFieldsB = {
    ...mutableLineFieldsA,
    title: "ALICE — revised extractor title",
    venue: "Repaired Venue Name",
    artists: ["Alice", "Guest"],
    rowSourceText: "ALICE — updated formatting — 21:00",
  };
  assert.equal(
    buildSourceOccurrenceKeyForTesting(
      sharedSlotPost,
      sharedSlotEvents[0].date,
      sharedSlotEvents[0].time,
      mutableLineFieldsA,
    ),
    buildSourceOccurrenceKeyForTesting(
      sharedSlotPost,
      sharedSlotEvents[0].date,
      sharedSlotEvents[0].time,
      mutableLineFieldsB,
    ),
    "Mutable source-line text must not change a v2 occurrence key.",
  );
  assert.equal(
    buildSourceOccurrenceChildTrackingKeyForTesting(
      sharedSlotPost,
      {
        kind: "skip",
        reason: "missing_venue",
        normalizedFields: mutableLineFieldsA,
      },
      0,
    ),
    buildSourceOccurrenceChildTrackingKeyForTesting(
      sharedSlotPost,
      {
        kind: "skip",
        reason: "missing_venue",
        normalizedFields: mutableLineFieldsB,
      },
      0,
    ),
    "Mutable extractor title, venue, artists, and source-line text must not strand a structurally identified deferred child.",
  );
  const pastOnlyBound = bindSourceOccurrenceMetadata(sharedSlotPost, [
    {
      kind: "skip",
      reason: "past_event",
      normalizedFields: {
        normalizedDate: "2026-01-01",
      },
    },
  ]);
  assert.match(
    pastOnlyBound[0].normalizedFields.sourceOccurrenceKey,
    /^instagram-occurrence-v2:/,
    "A past-only extraction must retain its key so the receipt can retire it safely.",
  );

  const singleOccurrenceResult = bindSourceOccurrenceMetadata(sharedSlotPost, [
    {
      kind: "ok",
      event: {
        ...sharedSlotEvents[0],
        sourceOccurrenceKey: undefined,
        normalizedFieldsJson: "{}",
      },
      normalizedFields: {
        normalizedDate: sharedSlotEvents[0].date,
      },
    },
  ])[0];
  assert.equal(singleOccurrenceResult.kind, "ok");
  const singleOccurrenceMatch = {
    existingEvent: {
      ...singleOccurrenceResult.event,
      _id: "qa-single-occurrence-existing",
    },
    matchedBy: "post_id",
    matchedValue: sharedSlotPost.postId,
  };
  assert.equal(
    hasIncompleteSourceOccurrenceSetForTesting([singleOccurrenceMatch], sharedSlotPost),
    false,
  );
  const legacySingleFields = JSON.parse(singleOccurrenceResult.event.normalizedFieldsJson);
  delete legacySingleFields.sourceOccurrenceSourceFingerprint;
  assert.equal(
    hasIncompleteSourceOccurrenceSetForTesting(
      [
        {
          ...singleOccurrenceMatch,
          existingEvent: {
            ...singleOccurrenceMatch.existingEvent,
            normalizedFieldsJson: JSON.stringify(legacySingleFields),
          },
        },
      ],
      sharedSlotPost,
    ),
    true,
    "A legacy single-event row must be re-extracted so a changed source can add children.",
  );
  assert.equal(
    hasIncompleteSourceOccurrenceSetForTesting(
      [
        {
          ...singleOccurrenceMatch,
          existingEvent: {
            ...singleOccurrenceMatch.existingEvent,
            normalizedFieldsJson: JSON.stringify({
              ...JSON.parse(singleOccurrenceResult.event.normalizedFieldsJson),
              sourceOccurrenceSourceFingerprint: "instagram-source-v1:stale",
            }),
          },
        },
      ],
      sharedSlotPost,
    ),
    true,
    "A changed source fingerprint must re-extract even when the old source had one event.",
  );
  const mixedLegacyFields = {
    sourceOccurrenceSourceFingerprint: JSON.parse(
      sharedSlotEvents[0].normalizedFieldsJson,
    ).sourceOccurrenceSourceFingerprint,
    multiEventSplitApplied: true,
    multiEventSplitCount: 2,
  };
  assert.equal(
    hasIncompleteSourceOccurrenceSetForTesting(
      [
        originalSharedSlotMatches[0],
        {
          existingEvent: {
            ...sharedSlotEvents[1],
            _id: "qa-mixed-legacy-existing",
            sourceOccurrenceKey: undefined,
            normalizedFieldsJson: JSON.stringify(mixedLegacyFields),
          },
          matchedBy: "post_id",
          matchedValue: sharedSlotPost.postId,
        },
      ],
      sharedSlotPost,
    ),
    true,
    "Mixed exact-v2 and legacy metadata must re-extract rather than fall back to counts.",
  );

  const previousCronSecret = process.env.CRON_SECRET;
  const atomicServiceSecret = "qa-atomic-source-occurrence-secret";
  process.env.CRON_SECRET = atomicServiceSecret;
  const atomicEvents = [];
  const atomicReceipts = [];
  const atomicSourceLinks = [];
  const atomicSourceOccurrences = [];
  const atomicScrapedPosts = [];
  const atomicTopologyEpochs = [{
    _id: "qa-atomic-source-occurrence-topology-epoch",
    key: "source-occurrence-topology-v1",
    currentEpoch: 0,
    verifiedEpoch: 0,
    createdAt: 1,
    updatedAt: 1,
  }];
  const atomicAuditLogs = [];
  const createAtomicSourceFixture = ({
    altText = null,
    caption = "",
    externalId,
    handle = "qa-atomic-handle",
    locationName = null,
  }) => {
    const owner = `qa-atomic-owner-${externalId}`;
    const row = {
      _id: `qa-atomic-scraped-post-${atomicScrapedPosts.length + 1}`,
      altText,
      caption,
      createdAt: Date.now(),
      handle,
      imageUrls: [],
      instagramPostUrl: `https://www.instagram.com/p/${externalId}/`,
      locationName,
      postId: externalId,
      processingAttempts: 1,
      processingLeaseExpiresAt: Date.now() + 60_000,
      processingLeaseOwner: owner,
      processingStatus: "processing",
      sourceRevision: 1,
      updatedAt: Date.now(),
      username: handle,
    };
    atomicScrapedPosts.push(row);
    const snapshot = () => ({
      processingFence: {
        handle: row.handle,
        scrapedPostId: row._id,
        postId: row.postId,
        instagramPostUrl: row.instagramPostUrl,
        owner,
        sourceRevision: row.sourceRevision,
      },
      sourceFingerprint: buildInstagramSourceOccurrenceFingerprint(row),
      sourceIdentity: adaptInstagramScrapedPostToSourceDocument(row).sourceIdentity,
    });
    return {
      advanceEvidence(evidence) {
        Object.assign(row, evidence, {
          processingLeaseExpiresAt: Date.now() + 60_000,
          sourceRevision: row.sourceRevision + 1,
          updatedAt: Date.now(),
        });
        return snapshot();
      },
      row,
      snapshot,
    };
  };
  const initialAtomicSourceFixture = createAtomicSourceFixture({
    altText: post.altText,
    caption: post.caption,
    externalId: "qa-distinct-occurrence-persistence",
    handle: "tickets.rs",
    locationName: post.locationName,
  });
  const initialAtomicSource = initialAtomicSourceFixture.snapshot();
  const atomicProcessingFence = initialAtomicSource.processingFence;
  const atomicScrapedPost = initialAtomicSourceFixture.row;
  const missingAtomicEventIds = new Set();
  const atomicCtx = {
    auth: { getUserIdentity: async () => null },
    db: {
      query: (table) => {
        if (table === "venues") {
          return {
            collect: async () => [
              {
                _id: "qa-atomic-lozionica-venue",
                name: "Ložionica",
                instagramHandle: "tickets.rs",
                category: "live music",
                publicStatus: "published",
              },
            ],
            take: async (limit) => [
              {
                _id: "qa-atomic-lozionica-venue",
                name: "Ložionica",
                instagramHandle: "tickets.rs",
                category: "live music",
                publicStatus: "published",
              },
            ].slice(0, limit),
          };
        }
        if (table === "venueIdentities") {
          return {
            withIndex: () => ({ take: async () => [] }),
          };
        }
        if (table === "eventDomainMigrationState") {
          return {
            withIndex: () => ({ take: async () => [] }),
          };
        }
        if (table === "sourceOccurrenceTopologyEpoch") {
          return {
            withIndex: (_indexName, configure) => {
              let key = null;
              const indexBuilder = {
                eq: (field, value) => {
                  if (field === "key") key = value;
                  return indexBuilder;
                },
              };
              configure(indexBuilder);
              return {
                take: async (limit) =>
                  atomicTopologyEpochs
                    .filter((row) => row.key === key)
                    .slice(0, limit),
              };
            },
          };
        }
        if (table === "scrapedPosts") {
          return {
            withIndex: (_indexName, configure) => {
              let handle = null;
              let postId = null;
              let instagramPostUrl = null;
              const indexBuilder = {
                eq: (field, value) => {
                  if (field === "handle") handle = value;
                  if (field === "postId") postId = value;
                  if (field === "instagramPostUrl") instagramPostUrl = value;
                  return indexBuilder;
                },
              };
              configure(indexBuilder);
              return {
                take: async (limit) =>
                  atomicScrapedPosts
                    .filter(
                      (source) =>
                        (!handle || source.handle === handle) &&
                        ((!postId && !instagramPostUrl) ||
                          postId === source.postId ||
                          instagramPostUrl === source.instagramPostUrl),
                    )
                    .slice(0, limit),
              };
            },
          };
        }
        if (table === "instagramSourceOccurrenceReceipts") {
          return {
            withIndex: (_indexName, configure) => {
              let sourceIdentity = null;
              const indexBuilder = {
                eq: (field, value) => {
                  if (field === "sourceIdentity") sourceIdentity = value;
                  return indexBuilder;
                },
              };
              configure(indexBuilder);
              return {
                unique: async () =>
                  atomicReceipts.find(
                    (receipt) => receipt.sourceIdentity === sourceIdentity,
                  ) ?? null,
              };
            },
          };
        }
        if (table === "instagramEventSources") {
          return {
            withIndex: (_indexName, configure) => {
              const filters = {};
              const indexBuilder = {
                eq: (field, value) => {
                  filters[field] = value;
                  return indexBuilder;
                },
              };
              configure(indexBuilder);
              const matchingLinks = () =>
                atomicSourceLinks.filter((link) =>
                  Object.entries(filters).every(([field, value]) => link[field] === value),
                );
              return {
                take: async (limit) => matchingLinks().slice(0, limit),
                unique: async () => matchingLinks()[0] ?? null,
              };
            },
          };
        }
        if (table === "sourceOccurrences") {
          return {
            withIndex: (_indexName, configure) => {
              const filters = {};
              const indexBuilder = {
                eq: (field, value) => {
                  filters[field] = value;
                  return indexBuilder;
                },
              };
              configure(indexBuilder);
              const matchingOccurrences = () =>
                atomicSourceOccurrences.filter((occurrence) =>
                  Object.entries(filters).every(
                    ([field, value]) => occurrence[field] === value,
                  ),
                );
              return {
                take: async (limit) => matchingOccurrences().slice(0, limit),
                unique: async () => matchingOccurrences()[0] ?? null,
              };
            },
          };
        }
        return {
          withIndex: (_indexName, configure) => {
            let sourceOccurrenceKey = null;
            const indexBuilder = {
              eq: (field, value) => {
                if (field === "sourceOccurrenceKey") sourceOccurrenceKey = value;
                return indexBuilder;
              },
            };
            configure(indexBuilder);
            return {
              unique: async () =>
                atomicEvents.find(
                  (event) => event.sourceOccurrenceKey === sourceOccurrenceKey,
                ) ?? null,
            };
          },
        };
      },
      get: async (id) =>
        missingAtomicEventIds.has(id)
          ? null
          : atomicEvents.find((event) => event._id === id) ??
            atomicScrapedPosts.find((source) => source._id === id) ??
            null,
      delete: async (id) => {
        for (const rows of [atomicSourceLinks, atomicSourceOccurrences]) {
          const index = rows.findIndex((row) => row._id === id);
          if (index >= 0) {
            rows.splice(index, 1);
            return;
          }
        }
        throw new Error(`Missing QA row ${id}`);
      },
      patch: async (id, patch) => {
        const record =
          atomicEvents.find((candidate) => candidate._id === id) ??
          atomicReceipts.find((candidate) => candidate._id === id) ??
          atomicSourceLinks.find((candidate) => candidate._id === id) ??
          atomicSourceOccurrences.find((candidate) => candidate._id === id) ??
          atomicTopologyEpochs.find((candidate) => candidate._id === id) ??
          atomicScrapedPosts.find((candidate) => candidate._id === id) ??
          null;
        assert.ok(record);
        Object.assign(record, patch);
      },
      insert: async (table, value) => {
        if (table === "events") {
          const event = {
            _id: `qa-atomic-event-${atomicEvents.length + 1}`,
            ...value,
          };
          atomicEvents.push(event);
          return event._id;
        }
        if (table === "instagramSourceOccurrenceReceipts") {
          const receipt = {
            _id: `qa-atomic-receipt-${atomicReceipts.length + 1}`,
            ...value,
          };
          atomicReceipts.push(receipt);
          return receipt._id;
        }
        if (table === "instagramEventSources") {
          const sourceLink = {
            _id: `qa-atomic-source-link-${atomicSourceLinks.length + 1}`,
            ...value,
          };
          atomicSourceLinks.push(sourceLink);
          return sourceLink._id;
        }
        if (table === "sourceOccurrences") {
          const sourceOccurrence = {
            _id: `qa-atomic-source-occurrence-${atomicSourceOccurrences.length + 1}`,
            ...value,
          };
          atomicSourceOccurrences.push(sourceOccurrence);
          return sourceOccurrence._id;
        }
        if (table === "sourceOccurrenceTopologyEpoch") {
          const topologyEpoch = {
            _id: `qa-atomic-topology-epoch-${atomicTopologyEpochs.length + 1}`,
            ...value,
          };
          atomicTopologyEpochs.push(topologyEpoch);
          return topologyEpoch._id;
        }
        atomicAuditLogs.push(value);
        return `qa-atomic-audit-${atomicAuditLogs.length}`;
      },
    },
  };
  const {
    serviceSecret: _capturedServiceSecret,
    returnCreateDisposition: _capturedDisposition,
    processingFence: _capturedProcessingFence,
    ...atomicEventArgs
  } = inserted[0];
  assert.equal(
    atomicEventArgs.sourceOccurrencePlan.sourceIdentity,
    initialAtomicSource.sourceIdentity,
  );
  assert.equal(
    atomicEventArgs.sourceOccurrencePlan.sourceFingerprint,
    initialAtomicSource.sourceFingerprint,
  );
  try {
    const firstAtomicCreate = await createEvent._handler(atomicCtx, {
      ...atomicEventArgs,
      returnCreateDisposition: true,
      processingFence: atomicProcessingFence,
      serviceSecret: atomicServiceSecret,
    });
    const racedAtomicCreate = await createEvent._handler(atomicCtx, {
      ...atomicEventArgs,
      title: "Joss Stone — concurrently normalized title",
      time: "19h",
      returnCreateDisposition: true,
      processingFence: atomicProcessingFence,
      serviceSecret: atomicServiceSecret,
    });
    assert.deepEqual(firstAtomicCreate, {
      eventId: "qa-atomic-event-1",
      created: true,
      updatedAt: atomicEvents[0].updatedAt,
    });
    assert.deepEqual(racedAtomicCreate, {
      eventId: "qa-atomic-event-1",
      created: false,
      updatedAt: atomicEvents[0].updatedAt,
    });
    await assert.rejects(
      createEvent._handler(atomicCtx, {
        ...atomicEventArgs,
        returnCreateDisposition: true,
        serviceSecret: atomicServiceSecret,
      }),
      /processing fence/i,
    );
    const activeLeaseExpiry = atomicScrapedPost.processingLeaseExpiresAt;
    atomicScrapedPost.processingLeaseExpiresAt = Date.now() - 1;
    await assert.rejects(
      createEvent._handler(atomicCtx, {
        ...atomicEventArgs,
        processingFence: atomicProcessingFence,
        returnCreateDisposition: true,
        serviceSecret: atomicServiceSecret,
      }),
      /processing fence is stale/i,
    );
    atomicScrapedPost.processingLeaseExpiresAt = activeLeaseExpiry;
    assert.equal(
      atomicEvents.length,
      1,
      "The indexed source-occurrence check and insert must share one mutation boundary.",
    );
    assert.equal(atomicAuditLogs.length, 1);
    assert.equal(atomicReceipts.length, 1);
    assert.equal(atomicSourceLinks.length, 1);
    assert.equal(atomicSourceLinks[0].eventId, "qa-atomic-event-1");
    assert.equal(
      atomicSourceLinks[0].sourceIdentity,
      atomicEventArgs.sourceOccurrencePlan.sourceIdentity,
    );
    assert.equal(
      atomicSourceLinks[0].sourceOccurrenceKey,
      atomicEventArgs.sourceOccurrenceKey,
    );
    assert.deepEqual(atomicReceipts[0].satisfiedKeys, [atomicEventArgs.sourceOccurrenceKey]);
    const representedReceipt = await getInstagramSourceOccurrenceReceipt._handler(atomicCtx, {
      sourceIdentity: atomicReceipts[0].sourceIdentity,
      processingFence: atomicProcessingFence,
      serviceSecret: atomicServiceSecret,
    });
    assert.deepEqual(representedReceipt.satisfiedKeys, [atomicEventArgs.sourceOccurrenceKey]);
    const originalRepresentativeFields = {
      title: atomicEvents[0].title,
      time: atomicEvents[0].time,
      venue: atomicEvents[0].venue,
      artists: atomicEvents[0].artists,
      status: atomicEvents[0].status,
    };
    Object.assign(atomicEvents[0], {
      title: "Moderator-corrected public title",
      time: "21:30",
      venue: "Moderator-corrected venue",
      artists: ["Moderator-corrected artist"],
      status: "approved",
    });
    const moderatedRepresentativeReceipt = await getInstagramSourceOccurrenceReceipt._handler(
      atomicCtx,
      {
        sourceIdentity: atomicReceipts[0].sourceIdentity,
        processingFence: atomicProcessingFence,
        serviceSecret: atomicServiceSecret,
      },
    );
    assert.deepEqual(
      moderatedRepresentativeReceipt.satisfiedKeys,
      [atomicEventArgs.sourceOccurrenceKey],
      "A same-source occurrence binding must survive moderator edits to mutable public fields.",
    );
    Object.assign(atomicEvents[0], originalRepresentativeFields);
    missingAtomicEventIds.add(atomicEvents[0]._id);
    const staleRepresentativeReceipt = await getInstagramSourceOccurrenceReceipt._handler(
      atomicCtx,
      {
        sourceIdentity: atomicReceipts[0].sourceIdentity,
        processingFence: atomicProcessingFence,
      serviceSecret: atomicServiceSecret,
      },
    );
    assert.deepEqual(
      staleRepresentativeReceipt.satisfiedKeys,
      [],
      "A receipt must not remain complete after the event representing its satisfied child is removed.",
    );
    missingAtomicEventIds.delete(atomicEvents[0]._id);

    const deferredSource = createAtomicSourceFixture({
      caption: "QA deferred receipt source evidence",
      externalId: "QADEFERREDRECEIPT",
    }).snapshot();
    const deferredSourceIdentity = deferredSource.sourceIdentity;
    const deferredFingerprint = deferredSource.sourceFingerprint;
    const deferredFirstKey = `instagram-occurrence-v2:${"a".repeat(64)}`;
    const deferredSecondKey = `instagram-occurrence-v2:${"b".repeat(64)}`;
    const deferredFirstChildKey = "instagram-source-child-v1:qa-deferred-first";
    const deferredSecondChildKey = "instagram-source-child-v1:qa-deferred-second";
    await recordInstagramSourceOccurrenceSatisfaction._handler(atomicCtx, {
      plan: {
        sourceIdentity: deferredSourceIdentity,
        sourceFingerprint: deferredFingerprint,
        expectedKeys: [deferredFirstKey],
        deferredChildCount: 1,
        deferredChildKeys: [deferredSecondChildKey],
        observedChildKeys: [deferredFirstChildKey, deferredSecondChildKey],
      },
      satisfiedKey: deferredFirstKey,
      representativeEventId: atomicEvents[0]._id,
      processingFence: deferredSource.processingFence,
      serviceSecret: atomicServiceSecret,
    });
    assert.equal(atomicReceipts[1].deferredChildCount, 1);
    assert.deepEqual(atomicReceipts[1].expectedKeys, [deferredFirstKey]);
    assert.deepEqual(atomicReceipts[1].satisfiedKeys, [deferredFirstKey]);
    await recordInstagramSourceOccurrenceSatisfaction._handler(atomicCtx, {
      plan: {
        sourceIdentity: deferredSourceIdentity,
        sourceFingerprint: deferredFingerprint,
        expectedKeys: [deferredFirstKey],
        deferredChildCount: 0,
        deferredChildKeys: [],
        observedChildKeys: [deferredFirstChildKey],
      },
      satisfiedKey: deferredFirstKey,
      representativeEventId: atomicEvents[0]._id,
      processingFence: deferredSource.processingFence,
      serviceSecret: atomicServiceSecret,
    });
    assert.equal(
      atomicReceipts[1].deferredChildCount,
      1,
      "A same-fingerprint retry that omits a deferred child must not erase the guard.",
    );
    const deferredSecondRepresentativeEventId = await atomicCtx.db.insert("events", {
      ...atomicEventArgs,
      sourceOccurrenceKey: deferredSecondKey,
    });
    await recordInstagramSourceOccurrenceSatisfaction._handler(atomicCtx, {
      plan: {
        sourceIdentity: deferredSourceIdentity,
        sourceFingerprint: deferredFingerprint,
        expectedKeys: [deferredFirstKey, deferredSecondKey],
        deferredChildCount: 0,
        deferredChildKeys: [],
        observedChildKeys: [deferredFirstChildKey, deferredSecondChildKey],
      },
      satisfiedKey: deferredSecondKey,
      representativeEventId: deferredSecondRepresentativeEventId,
      processingFence: deferredSource.processingFence,
      serviceSecret: atomicServiceSecret,
    });
    assert.equal(atomicReceipts[1].deferredChildCount, 0);
    assert.deepEqual(atomicReceipts[1].expectedKeys, [deferredFirstKey, deferredSecondKey]);
    assert.deepEqual(atomicReceipts[1].satisfiedKeys, [deferredFirstKey, deferredSecondKey]);
    await assert.rejects(
      recordInstagramSourceOccurrenceSatisfaction._handler(atomicCtx, {
        plan: {
          sourceIdentity: deferredSourceIdentity,
          sourceFingerprint: deferredFingerprint,
          expectedKeys: [deferredFirstKey, deferredSecondKey, `instagram-occurrence-v2:${"c".repeat(64)}`],
          deferredChildCount: 0,
          deferredChildKeys: [],
          observedChildKeys: [
            deferredFirstChildKey,
            deferredSecondChildKey,
            "instagram-source-child-v1:qa-deferred-third",
          ],
        },
        satisfiedKey: `instagram-occurrence-v2:${"c".repeat(64)}`,
        representativeEventId: deferredSecondRepresentativeEventId,
        processingFence: deferredSource.processingFence,
      serviceSecret: atomicServiceSecret,
      }),
      /distinct representative events/i,
    );
    await recordInstagramSourceOccurrenceSatisfaction._handler(atomicCtx, {
      plan: {
        sourceIdentity: deferredSourceIdentity,
        sourceFingerprint: deferredFingerprint,
        expectedKeys: [deferredSecondKey],
        deferredChildCount: 0,
        deferredChildKeys: [],
        observedChildKeys: [deferredSecondChildKey],
        confirmedPastKeys: [deferredFirstKey],
      },
      satisfiedKey: deferredSecondKey,
      representativeEventId: deferredSecondRepresentativeEventId,
      processingFence: deferredSource.processingFence,
      serviceSecret: atomicServiceSecret,
    });
    assert.deepEqual(
      atomicReceipts[1].expectedKeys,
      [deferredSecondKey],
      "Safely confirmed-past keys must retire from the authoritative receipt.",
    );
    assert.deepEqual(atomicReceipts[1].satisfiedKeys, [deferredSecondKey]);
    await reconcileInstagramSourceOccurrenceReceipt._handler(atomicCtx, {
      plan: {
        sourceIdentity: deferredSourceIdentity,
        sourceFingerprint: deferredFingerprint,
        expectedKeys: [],
        expectedOccurrences: [],
        deferredChildCount: 0,
        deferredChildKeys: [],
        observedChildKeys: [deferredSecondChildKey],
        confirmedPastKeys: [deferredSecondKey],
      },
      processingFence: deferredSource.processingFence,
      serviceSecret: atomicServiceSecret,
    });
    assert.deepEqual(atomicReceipts[1].expectedKeys, []);
    assert.deepEqual(atomicReceipts[1].satisfiedKeys, []);
    assert.deepEqual(atomicReceipts[1].satisfiedOccurrences, []);

    const deferredOnlySource = createAtomicSourceFixture({
      caption: "QA deferred receipt source evidence",
      externalId: "QADEFERREDONLY",
    }).snapshot();
    const deferredOnlySourceIdentity = deferredOnlySource.sourceIdentity;
    const deferredOnlyChildKey =
      "instagram-source-child-v1:qa-deferred-only-child";
    await reconcileInstagramSourceOccurrenceReceipt._handler(atomicCtx, {
      plan: {
        sourceIdentity: deferredOnlySourceIdentity,
        sourceFingerprint: deferredOnlySource.sourceFingerprint,
        expectedKeys: [],
        expectedOccurrences: [],
        deferredChildCount: 1,
        deferredChildKeys: [deferredOnlyChildKey],
        observedChildKeys: [deferredOnlyChildKey],
      },
      processingFence: deferredOnlySource.processingFence,
      serviceSecret: atomicServiceSecret,
    });
    const deferredOnlyReceipt = atomicReceipts.find(
      (receipt) => receipt.sourceIdentity === deferredOnlySourceIdentity,
    );
    assert.deepEqual(deferredOnlyReceipt.expectedKeys, []);
    assert.deepEqual(deferredOnlyReceipt.deferredChildKeys, [deferredOnlyChildKey]);
    assert.equal(deferredOnlyReceipt.deferredChildCount, 1);

    const staleSourceFixture = createAtomicSourceFixture({
      caption: "QA stale generation one",
      externalId: "QASTALEWORKER",
    });
    const staleSourceGenerationOne = staleSourceFixture.snapshot();
    const staleSourceIdentity = staleSourceGenerationOne.sourceIdentity;
    const staleKey = `instagram-occurrence-v2:${"d".repeat(64)}`;
    const staleExpectedOccurrences = [
      {
        key: staleKey,
        date: atomicEvents[0].date,
        ...(atomicEvents[0].time ? { time: atomicEvents[0].time } : {}),
        venue: atomicEvents[0].venue,
        title: atomicEvents[0].title,
        artists: atomicEvents[0].artists,
      },
    ];
    await recordInstagramSourceOccurrenceSatisfaction._handler(atomicCtx, {
      plan: {
        sourceIdentity: staleSourceIdentity,
        sourceFingerprint: staleSourceGenerationOne.sourceFingerprint,
        expectedKeys: [staleKey],
        expectedOccurrences: staleExpectedOccurrences,
        deferredChildCount: 0,
        deferredChildKeys: [],
        observedChildKeys: ["instagram-source-child-v1:qa-stale"],
      },
      satisfiedKey: staleKey,
      representativeEventId: atomicEvents[0]._id,
      processingFence: staleSourceGenerationOne.processingFence,
      serviceSecret: atomicServiceSecret,
    });
    const staleSourceGenerationTwo = staleSourceFixture.advanceEvidence({
      caption: "QA stale generation two",
    });
    assert.notEqual(
      staleSourceGenerationTwo.sourceFingerprint,
      staleSourceGenerationOne.sourceFingerprint,
    );
    await recordInstagramSourceOccurrenceSatisfaction._handler(atomicCtx, {
      plan: {
        sourceIdentity: staleSourceIdentity,
        sourceFingerprint: staleSourceGenerationTwo.sourceFingerprint,
        previousSourceFingerprint: staleSourceGenerationOne.sourceFingerprint,
        expectedKeys: [staleKey],
        expectedOccurrences: staleExpectedOccurrences,
        deferredChildCount: 0,
        deferredChildKeys: [],
        observedChildKeys: ["instagram-source-child-v1:qa-stale"],
      },
      satisfiedKey: staleKey,
      representativeEventId: atomicEvents[0]._id,
      processingFence: staleSourceGenerationTwo.processingFence,
      serviceSecret: atomicServiceSecret,
    });
    const staleSourceRollback = staleSourceFixture.advanceEvidence({
      caption: "QA stale generation one",
    });
    assert.equal(
      staleSourceRollback.sourceFingerprint,
      staleSourceGenerationOne.sourceFingerprint,
    );
    await assert.rejects(
      recordInstagramSourceOccurrenceSatisfaction._handler(atomicCtx, {
        plan: {
          sourceIdentity: staleSourceIdentity,
          sourceFingerprint: staleSourceRollback.sourceFingerprint,
          previousSourceFingerprint: staleSourceGenerationOne.sourceFingerprint,
          expectedKeys: [staleKey],
          expectedOccurrences: staleExpectedOccurrences,
          deferredChildCount: 0,
          deferredChildKeys: [],
          observedChildKeys: ["instagram-source-child-v1:qa-stale"],
        },
        satisfiedKey: staleKey,
        representativeEventId: atomicEvents[0]._id,
        processingFence: staleSourceRollback.processingFence,
      serviceSecret: atomicServiceSecret,
      }),
      /receipt plan is stale/i,
    );
    assert.equal(
      atomicReceipts.find((receipt) => receipt.sourceIdentity === staleSourceIdentity)
        .sourceFingerprint,
      staleSourceGenerationTwo.sourceFingerprint,
    );
    const descriptionBeforeStaleAtomicUpdate = atomicEvents[0].description;
    await assert.rejects(
      updateEventAndRecordInstagramSourceOccurrenceSatisfaction._handler(atomicCtx, {
        id: atomicEvents[0]._id,
        patch: { description: "stale-f1-write" },
        expectedStatus: atomicEvents[0].status,
        plan: {
          sourceIdentity: staleSourceIdentity,
          sourceFingerprint: staleSourceRollback.sourceFingerprint,
          previousSourceFingerprint: staleSourceGenerationOne.sourceFingerprint,
          expectedKeys: [staleKey],
          expectedOccurrences: staleExpectedOccurrences,
          deferredChildCount: 0,
          deferredChildKeys: [],
          observedChildKeys: ["instagram-source-child-v1:qa-stale"],
        },
        satisfiedKey: staleKey,
        processingFence: staleSourceRollback.processingFence,
      serviceSecret: atomicServiceSecret,
      }),
      /receipt plan is stale/i,
    );
    assert.equal(
      atomicEvents[0].description,
      descriptionBeforeStaleAtomicUpdate,
      "A stale receipt generation must reject before any public event repair commits.",
    );

    const retainedGenerationSourceFixture = createAtomicSourceFixture({
      caption: "QA retained generation one",
      externalId: "QAGENERATIONRETENTION",
    });
    const retainedGenerationOne = retainedGenerationSourceFixture.snapshot();
    const retainedGenerationSourceIdentity = retainedGenerationOne.sourceIdentity;
    const retainedGenerationKey = `instagram-occurrence-v2:${"2".repeat(64)}`;
    const omittedGenerationSiblingKey = `instagram-occurrence-v2:${"3".repeat(64)}`;
    await recordInstagramSourceOccurrenceSatisfaction._handler(atomicCtx, {
      plan: {
        sourceIdentity: retainedGenerationSourceIdentity,
        sourceFingerprint: retainedGenerationOne.sourceFingerprint,
        expectedKeys: [retainedGenerationKey, omittedGenerationSiblingKey],
        deferredChildCount: 0,
        deferredChildKeys: [],
        observedChildKeys: [
          "instagram-source-child-v1:qa-retention-a",
          "instagram-source-child-v1:qa-retention-b",
        ],
      },
      satisfiedKey: retainedGenerationKey,
      representativeEventId: atomicEvents[0]._id,
      processingFence: retainedGenerationOne.processingFence,
      serviceSecret: atomicServiceSecret,
    });
    const retainedGenerationTwo =
      retainedGenerationSourceFixture.advanceEvidence({
        caption: "QA retained generation two",
      });
    await recordInstagramSourceOccurrenceSatisfaction._handler(atomicCtx, {
      plan: {
        sourceIdentity: retainedGenerationSourceIdentity,
        sourceFingerprint: retainedGenerationTwo.sourceFingerprint,
        previousSourceFingerprint: retainedGenerationOne.sourceFingerprint,
        expectedKeys: [retainedGenerationKey],
        deferredChildCount: 0,
        deferredChildKeys: [],
        observedChildKeys: ["instagram-source-child-v1:qa-retention-a"],
      },
      satisfiedKey: retainedGenerationKey,
      representativeEventId: atomicEvents[0]._id,
      processingFence: retainedGenerationTwo.processingFence,
      serviceSecret: atomicServiceSecret,
    });
    const retainedGenerationReceipt = atomicReceipts.find(
      (receipt) => receipt.sourceIdentity === retainedGenerationSourceIdentity,
    );
    assert.deepEqual(
      new Set(retainedGenerationReceipt.expectedKeys),
      new Set([retainedGenerationKey, omittedGenerationSiblingKey]),
      "A changed source fingerprint must not erase an unresolved prior-generation child merely because the latest extraction omitted it.",
    );

    const migratedSourceFixture = createAtomicSourceFixture({
      caption: "QA key migration generation one",
      externalId: "QAKEYMIGRATION",
    });
    const migratedGenerationOne = migratedSourceFixture.snapshot();
    const migratedSourceIdentity = migratedGenerationOne.sourceIdentity;
    const migratedOldKey = `instagram-occurrence-v2:${"e".repeat(64)}`;
    const migratedNewKey = `instagram-occurrence-v2:${"f".repeat(64)}`;
    const migratedSiblingKey = `instagram-occurrence-v2:${"1".repeat(64)}`;
    await recordInstagramSourceOccurrenceSatisfaction._handler(atomicCtx, {
      plan: {
        sourceIdentity: migratedSourceIdentity,
        sourceFingerprint: migratedGenerationOne.sourceFingerprint,
        expectedKeys: [migratedOldKey],
        deferredChildCount: 0,
        deferredChildKeys: [],
        observedChildKeys: ["instagram-source-child-v1:qa-migration-a"],
      },
      satisfiedKey: migratedOldKey,
      representativeEventId: atomicEvents[0]._id,
      processingFence: migratedGenerationOne.processingFence,
      serviceSecret: atomicServiceSecret,
    });
    const migratedGenerationTwo = migratedSourceFixture.advanceEvidence({
      caption: "QA key migration generation two",
    });
    await updateEventAndRecordInstagramSourceOccurrenceSatisfaction._handler(atomicCtx, {
      id: atomicEvents[0]._id,
      patch: { description: "migrated-f2-a" },
      expectedStatus: atomicEvents[0].status,
      plan: {
        sourceIdentity: migratedSourceIdentity,
        sourceFingerprint: migratedGenerationTwo.sourceFingerprint,
        previousSourceFingerprint: migratedGenerationOne.sourceFingerprint,
        expectedKeys: [migratedNewKey, migratedSiblingKey],
        expectedOccurrences: [migratedNewKey, migratedSiblingKey].map((key) => ({
          key,
          date: atomicEvents[0].date,
          ...(atomicEvents[0].time ? { time: atomicEvents[0].time } : {}),
          venue: atomicEvents[0].venue,
          title: atomicEvents[0].title,
          artists: atomicEvents[0].artists,
        })),
        deferredChildCount: 0,
        deferredChildKeys: [],
        observedChildKeys: [
          "instagram-source-child-v1:qa-migration-a",
          "instagram-source-child-v1:qa-migration-b",
        ],
      },
      satisfiedKey: migratedNewKey,
      supersededKey: migratedOldKey,
      processingFence: migratedGenerationTwo.processingFence,
      serviceSecret: atomicServiceSecret,
    });
    const migratedReceipt = atomicReceipts.find(
      (receipt) => receipt.sourceIdentity === migratedSourceIdentity,
    );
    assert.deepEqual(
      new Set(migratedReceipt.expectedKeys),
      new Set([migratedNewKey, migratedSiblingKey]),
    );
    assert.deepEqual(migratedReceipt.satisfiedKeys, [migratedNewKey]);
    assert.deepEqual(migratedReceipt.satisfiedOccurrences, [
      { key: migratedNewKey, eventId: atomicEvents[0]._id },
    ]);
    assert.equal(atomicEvents[0].description, "migrated-f2-a");
    const migratedSiblingEventId = await atomicCtx.db.insert("events", {
      ...atomicEventArgs,
      sourceOccurrenceKey: migratedSiblingKey,
      description: "migrated-f2-b",
    });
    await recordInstagramSourceOccurrenceSatisfaction._handler(atomicCtx, {
      plan: {
        sourceIdentity: migratedSourceIdentity,
        sourceFingerprint: migratedGenerationTwo.sourceFingerprint,
        previousSourceFingerprint: migratedGenerationOne.sourceFingerprint,
        expectedKeys: [migratedNewKey, migratedSiblingKey],
        deferredChildCount: 0,
        deferredChildKeys: [],
        observedChildKeys: [
          "instagram-source-child-v1:qa-migration-a",
          "instagram-source-child-v1:qa-migration-b",
        ],
      },
      satisfiedKey: migratedSiblingKey,
      representativeEventId: migratedSiblingEventId,
      processingFence: migratedGenerationTwo.processingFence,
      serviceSecret: atomicServiceSecret,
    });
    assert.deepEqual(
      new Set(migratedReceipt.satisfiedKeys),
      new Set([migratedNewKey, migratedSiblingKey]),
    );
    await recordInstagramSourceOccurrenceSatisfaction._handler(atomicCtx, {
      plan: {
        sourceIdentity: migratedSourceIdentity,
        sourceFingerprint: migratedGenerationTwo.sourceFingerprint,
        previousSourceFingerprint: migratedGenerationOne.sourceFingerprint,
        expectedKeys: [migratedNewKey, migratedSiblingKey],
        deferredChildCount: 0,
        deferredChildKeys: [],
        observedChildKeys: [
          "instagram-source-child-v1:qa-migration-a",
          "instagram-source-child-v1:qa-migration-b",
        ],
      },
      satisfiedKey: migratedNewKey,
      representativeEventId: atomicEvents[0]._id,
      processingFence: migratedGenerationTwo.processingFence,
      serviceSecret: atomicServiceSecret,
    });
    assert.deepEqual(
      new Set(migratedReceipt.satisfiedKeys),
      new Set([migratedNewKey, migratedSiblingKey]),
    );
    assert.equal(atomicEvents[0].title, atomicEventArgs.title);

    const titleBeforeMetadataReduction = atomicEvents[0].title;
    const timeBeforeMetadataReduction = atomicEvents[0].time;
    const atomicOccurrenceMetadata = JSON.parse(atomicEvents[0].normalizedFieldsJson);
    const atomicExpectedKeys = atomicOccurrenceMetadata.sourceOccurrenceExpectedKeys;
    atomicEvents[0].status = "approved";
    const reducedMetadata = await updateSourceOccurrenceExpectedCount._handler(atomicCtx, {
      id: atomicEvents[0]._id,
      sourceOccurrenceKey: atomicEvents[0].sourceOccurrenceKey,
      expectedCurrentCount: 2,
      expectedCurrentKeys: atomicExpectedKeys,
      expectedCurrentDeferredChildCount: 0,
      expectedCurrentSourceFingerprint:
        atomicOccurrenceMetadata.sourceOccurrenceSourceFingerprint,
      nextExpectedCount: 1,
      nextExpectedKeys: [atomicEvents[0].sourceOccurrenceKey],
      nextDeferredChildCount: 0,
      nextSourceFingerprint: atomicOccurrenceMetadata.sourceOccurrenceSourceFingerprint,
      confirmedPastKeys: atomicExpectedKeys.filter(
        (key) => key !== atomicEvents[0].sourceOccurrenceKey,
      ),
      processingFence: atomicProcessingFence,
      serviceSecret: atomicServiceSecret,
    });
    assert.deepEqual(reducedMetadata, { updated: true });
    assert.equal(atomicEvents[0].title, titleBeforeMetadataReduction);
    assert.equal(atomicEvents[0].time, timeBeforeMetadataReduction);
    assert.equal(
      JSON.parse(atomicEvents[0].normalizedFieldsJson).sourceOccurrenceExpectedCount,
      1,
      "Operational completeness metadata must be reducible without changing approved public fields.",
    );

    const processingResultArgs = {
      handle: atomicProcessingFence.handle,
      postId: atomicProcessingFence.postId,
      instagramPostUrl: atomicProcessingFence.instagramPostUrl,
      status: "completed",
      outcome: "receipt_complete",
      owner: atomicProcessingFence.owner,
      serviceSecret: atomicServiceSecret,
    };
    await assert.rejects(
      recordProcessingResult._handler(atomicCtx, {
        ...processingResultArgs,
        sourceRevision: atomicProcessingFence.sourceRevision + 1,
      }),
      /stale processing fence/i,
    );
    const validLeaseExpiry = atomicScrapedPost.processingLeaseExpiresAt;
    atomicScrapedPost.processingLeaseExpiresAt = Date.now() - 1;
    await assert.rejects(
      recordProcessingResult._handler(atomicCtx, {
        ...processingResultArgs,
        sourceRevision: atomicProcessingFence.sourceRevision,
      }),
      /stale processing fence/i,
    );
    atomicScrapedPost.processingLeaseExpiresAt = validLeaseExpiry;
    await recordProcessingResult._handler(atomicCtx, {
      ...processingResultArgs,
      sourceRevision: atomicProcessingFence.sourceRevision,
    });
    assert.equal(atomicScrapedPost.processingStatus, "completed");
    assert.equal(atomicScrapedPost.blocksPaidFetch, false);
    assert.equal(atomicScrapedPost.processingLeaseOwner, undefined);
    assert.equal(atomicAuditLogs.length, 3);
  } finally {
    if (previousCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousCronSecret;
  }

  const atomicRaceSummary = createEmptyIngestionSummary(["tickets.rs"]).handles[0];
  const atomicRaceCreates = [];
  await withoutConsoleInfo(() =>
    processIngestionPostWithExtractionForTesting({
      client: {
        query: async (reference) => emptyIngestionQueryResult(reference),
        mutation: async (reference, args) => {
          if (reference === "reconciliationIngress:reconcileIngestionPlan") {
            return { authority: "legacy", outcomes: [] };
          }
          assert.equal("id" in args, false);
          atomicRaceCreates.push(args);
          return args.time === "19:00"
            ? { eventId: "qa-raced-existing-19", created: false, updatedAt: 100 }
            : { eventId: "qa-created-22", created: true, updatedAt: 200 };
        },
      },
      handle: "tickets.rs",
      post,
      summary: atomicRaceSummary,
      canonicalVenueNamesByHandle: { "tickets.rs": "Ložionica" },
      venueNameOverridesByHandle: {},
      configuredVenueNamesByHandle: { "tickets.rs": "Ložionica" },
      serviceSecret: "qa-distinct-occurrence-secret",
      extracted,
    }),
  );
  assert.equal(atomicRaceCreates.length, 2);
  assert.equal(atomicRaceSummary.insertedEvents, 1);
  assert.equal(atomicRaceSummary.skippedDuplicates, 1);
  assert.equal(atomicRaceSummary.updated_duplicates_bad_data, 0);

  const existingFirstOccurrence = {
    ...inserted[0],
    _id: "qa-existing-first-occurrence",
    title: "Joss Stone — moderated title",
    time: "7 pm",
    normalizedFieldsJson: JSON.stringify({
      ...JSON.parse(inserted[0].normalizedFieldsJson),
      splitSource: "model_schedule",
    }),
  };
  const retrySummary = createEmptyIngestionSummary(["tickets.rs"]).handles[0];
  const retryInserted = [];
  const retryUpdated = [];
  const retryReceipts = [];
  const retryClient = {
    query: async (reference) =>
      ingestionQueryResult(reference, [existingFirstOccurrence]),
    mutation: async (reference, args) => {
      if (reference === "reconciliationIngress:reconcileIngestionPlan") {
        return { authority: "legacy", outcomes: [] };
      }
      if ("representativeEventId" in args) {
        retryReceipts.push(args);
        return { recorded: true };
      }
      if ("id" in args) {
        retryUpdated.push(args);
        return { updatedAt: existingFirstOccurrence.updatedAt + retryUpdated.length };
      }
      retryInserted.push(args);
      return {
        eventId: `qa-recovered-occurrence-${retryInserted.length}`,
        created: true,
        updatedAt: 1000 + retryInserted.length,
      };
    },
  };

  await withoutConsoleInfo(() =>
    processIngestionPostWithExtractionForTesting({
      client: retryClient,
      handle: "tickets.rs",
      post,
      summary: retrySummary,
      canonicalVenueNamesByHandle: { "tickets.rs": "Ložionica" },
      venueNameOverridesByHandle: {},
      configuredVenueNamesByHandle: { "tickets.rs": "Ložionica" },
      serviceSecret: "qa-distinct-occurrence-secret",
      extracted,
    }),
  );

  assert.deepEqual(
    retryInserted.map((event) => event.time),
    ["22:00"],
    "Retrying a partially persisted multi-event post must recover the missing occurrence.",
  );
  assert.equal(retryUpdated.length, 0);
  assert.equal(retrySummary.insertedEvents, 1);
  assert.equal(retrySummary.skippedDuplicates, 1);

  const legacyFirstNormalizedFields = JSON.parse(inserted[0].normalizedFieldsJson);
  delete legacyFirstNormalizedFields.sourceOccurrenceExpectedCount;
  delete legacyFirstNormalizedFields.sourceOccurrenceExpectedKeys;
  delete legacyFirstNormalizedFields.sourceOccurrenceKey;
  legacyFirstNormalizedFields.dateRangeExpandedCount = 1;
  const legacyFirstOccurrence = {
    ...inserted[0],
    _id: "qa-legacy-first-occurrence",
    sourceOccurrenceKey: undefined,
    normalizedFieldsJson: JSON.stringify(legacyFirstNormalizedFields),
  };
  const legacyRetryCreates = [];
  await withoutConsoleInfo(() =>
    processIngestionPostWithExtractionForTesting({
      client: {
        query: async (reference) =>
          ingestionQueryResult(reference, [legacyFirstOccurrence]),
        mutation: async (reference, args) => {
          if (reference === "reconciliationIngress:reconcileIngestionPlan") {
            return { authority: "legacy", outcomes: [] };
          }
          if ("representativeEventId" in args) {
            return { recorded: true };
          }
          legacyRetryCreates.push(args);
          return {
            eventId: "qa-legacy-recovered-second-occurrence",
            created: true,
            updatedAt: 1000,
          };
        },
      },
      handle: "tickets.rs",
      post,
      summary: createEmptyIngestionSummary(["tickets.rs"]).handles[0],
      canonicalVenueNamesByHandle: { "tickets.rs": "Ložionica" },
      venueNameOverridesByHandle: {},
      configuredVenueNamesByHandle: { "tickets.rs": "Ložionica" },
      serviceSecret: "qa-distinct-occurrence-secret",
      extracted,
    }),
  );
  assert.deepEqual(
    legacyRetryCreates.map((event) => event.time),
    ["22:00"],
    "Legacy multi-event counts must not be masked by a non-range count of one.",
  );

  const completeExistingOccurrences = inserted.map((event, index) => ({
    ...event,
    _id: `qa-complete-occurrence-${index + 1}`,
  }));
  const completeSummary = createEmptyIngestionSummary(["tickets.rs"]).handles[0];
  const completeMutations = [];
  await withoutConsoleInfo(() =>
    processIngestionPostWithExtractionForTesting({
      client: {
        query: async (reference) =>
          ingestionQueryResult(reference, completeExistingOccurrences),
        mutation: async (reference, args) => {
          if (reference === "reconciliationIngress:reconcileIngestionPlan") {
            return { authority: "legacy", outcomes: [] };
          }
          completeMutations.push(args);
          return "qa-unexpected-complete-mutation";
        },
      },
      handle: "tickets.rs",
      post,
      summary: completeSummary,
      canonicalVenueNamesByHandle: { "tickets.rs": "Ložionica" },
      venueNameOverridesByHandle: {},
      configuredVenueNamesByHandle: { "tickets.rs": "Ložionica" },
      serviceSecret: "qa-distinct-occurrence-secret",
      extracted,
    }),
  );
  assert.equal(completeMutations.length, 0);
  assert.equal(
    completeSummary.skippedDuplicates,
    1,
    "A complete deterministic child set should retain the cheap source-post precheck skip.",
  );

  const pastDateLabel = ddmmForIsoDate(isoDateDaysFromNow(-3));
  const eligibleDateLabel = ddmmForIsoDate(isoDateDaysFromNow(8));
  const mixedCaption = [
    `${pastDateLabel} - Historical Set 18H`,
    `${eligibleDateLabel} - Upcoming Set 20H`,
  ].join("\n");
  const mixedPost = makeInstagramPost({
    postId: "qa-mixed-eligibility-persistence",
    instagramPostUrl: "https://www.instagram.com/p/qa-mixed-eligibility-persistence/",
    caption: mixedCaption,
    postType: "video",
    username: "tickets.rs",
  });
  const mixedExtracted = makeExtractedEvent({
    title: "Upcoming Set",
    date: eligibleDateLabel,
    time: "20:00",
    venue: "Ložionica",
    artists: ["Upcoming Set"],
    source_caption: mixedCaption,
  });
  const mixedSummary = createEmptyIngestionSummary(["tickets.rs"]).handles[0];
  const mixedInserted = [];
  await withoutConsoleInfo(() =>
    processIngestionPostWithExtractionForTesting({
      client: {
        query: async (reference) => emptyIngestionQueryResult(reference),
        mutation: async (reference, args) => {
          if (reference === "reconciliationIngress:reconcileIngestionPlan") {
            return { authority: "legacy", outcomes: [] };
          }
          mixedInserted.push({ ...args, updatedAt: 1000 });
          return {
            eventId: "qa-mixed-eligible-occurrence",
            created: true,
            updatedAt: 1000,
          };
        },
      },
      handle: "tickets.rs",
      post: mixedPost,
      summary: mixedSummary,
      canonicalVenueNamesByHandle: { "tickets.rs": "Ložionica" },
      venueNameOverridesByHandle: {},
      configuredVenueNamesByHandle: { "tickets.rs": "Ložionica" },
      serviceSecret: "qa-distinct-occurrence-secret",
      extracted: mixedExtracted,
    }),
  );
  assert.equal(mixedInserted.length, 1);
  assert.equal(
    JSON.parse(mixedInserted[0].normalizedFieldsJson).sourceOccurrenceExpectedCount,
    1,
    "Expected child count must describe persistable occurrences, not intentionally skipped rows.",
  );
  assert.equal(mixedSummary.skipped_past_event, 1);

  const mixedPastOccurrenceKey = buildSourceOccurrenceKeyForTesting(
    mixedPost,
    isoDateDaysFromNow(-3),
    "18:00",
    {
      multiEventSplitDetected: true,
      multiEventSplitCount: 2,
      splitEventIndex: 1,
      splitSourceLine: mixedCaption.split("\n")[0],
      rowSourceText: mixedCaption.split("\n")[0],
    },
  );
  const mixedCurrentOccurrenceKey = mixedInserted[0].sourceOccurrenceKey;
  const staleMixedExisting = {
    ...mixedInserted[0],
    _id: "qa-mixed-existing",
    normalizedFieldsJson: JSON.stringify({
      ...JSON.parse(mixedInserted[0].normalizedFieldsJson),
      sourceOccurrenceExpectedCount: 2,
      sourceOccurrenceExpectedKeys: [
        mixedPastOccurrenceKey,
        mixedCurrentOccurrenceKey,
      ],
    }),
  };
  const staleReductionSummary = createEmptyIngestionSummary(["tickets.rs"]).handles[0];
  const staleReductionMutations = [];
  await withoutConsoleInfo(() =>
    processIngestionPostWithExtractionForTesting({
      client: {
        query: async (reference) =>
          ingestionQueryResult(reference, [staleMixedExisting]),
        mutation: async (reference, args) => {
          if (reference === "reconciliationIngress:reconcileIngestionPlan") {
            return { authority: "legacy", outcomes: [] };
          }
          if ("representativeEventId" in args) {
            return { recorded: true };
          }
          assert.equal(args.id, staleMixedExisting._id);
          assert.equal(args.expectedCurrentCount, 2);
          assert.deepEqual(args.expectedCurrentKeys, [
            mixedPastOccurrenceKey,
            mixedCurrentOccurrenceKey,
          ]);
          assert.equal(args.nextExpectedCount, 1);
          assert.deepEqual(args.nextExpectedKeys, [mixedCurrentOccurrenceKey]);
          assert.equal(args.sourceOccurrenceKey, staleMixedExisting.sourceOccurrenceKey);
          staleReductionMutations.push(args);
          staleMixedExisting.normalizedFieldsJson = JSON.stringify({
            ...JSON.parse(staleMixedExisting.normalizedFieldsJson),
            sourceOccurrenceExpectedCount: args.nextExpectedCount,
            sourceOccurrenceExpectedKeys: args.nextExpectedKeys,
          });
          return { updated: true };
        },
      },
      handle: "tickets.rs",
      post: mixedPost,
      summary: staleReductionSummary,
      canonicalVenueNamesByHandle: { "tickets.rs": "Ložionica" },
      venueNameOverridesByHandle: {},
      configuredVenueNamesByHandle: { "tickets.rs": "Ložionica" },
      serviceSecret: "qa-distinct-occurrence-secret",
      extracted: mixedExtracted,
    }),
  );
  assert.equal(staleReductionMutations.length, 1);
  assert.equal(staleReductionSummary.insertedEvents, 0);
  assert.equal(staleReductionSummary.skippedDuplicates, 1);
  assert.equal(staleReductionSummary.skipped_past_event, 1);
  assert.equal(
    JSON.parse(staleMixedExisting.normalizedFieldsJson).sourceOccurrenceExpectedCount,
    1,
    "A retry must persist a reduced eligible-child count on the preserved sibling.",
  );

  const guardedMissingDate = isoDateDaysFromNow(9);
  const guardedMissingDateLabel = ddmmForIsoDate(guardedMissingDate);
  const guardedMissingLine = `${guardedMissingDateLabel} - Recovered Set 18H`;
  const guardedCurrentLine = mixedCaption.split("\n")[1];
  const guardedMissingOccurrenceKey = buildSourceOccurrenceKeyForTesting(
    mixedPost,
    guardedMissingDate,
    "18:00",
    {
      multiEventSplitDetected: true,
      multiEventSplitCount: 2,
      splitEventIndex: 1,
      splitSourceLine: guardedMissingLine,
      rowSourceText: guardedMissingLine,
    },
  );
  const guardedExisting = {
    ...mixedInserted[0],
    _id: "qa-transient-past-guard-existing",
    normalizedFieldsJson: JSON.stringify({
      ...JSON.parse(mixedInserted[0].normalizedFieldsJson),
      sourceOccurrenceExpectedCount: 2,
      sourceOccurrenceExpectedKeys: [
        guardedMissingOccurrenceKey,
        mixedCurrentOccurrenceKey,
      ],
    }),
  };
  const guardedTransientMutations = [];
  await withoutConsoleInfo(() =>
    processIngestionPostWithExtractionForTesting({
      client: {
        query: async (reference) =>
          ingestionQueryResult(reference, [guardedExisting]),
        mutation: async (reference, args) => {
          if (reference === "reconciliationIngress:reconcileIngestionPlan") {
            return { authority: "legacy", outcomes: [] };
          }
          if ("representativeEventId" in args) {
            return { recorded: true };
          }
          guardedTransientMutations.push(args);
          return "qa-unexpected-transient-reduction";
        },
      },
      handle: "tickets.rs",
      post: mixedPost,
      summary: createEmptyIngestionSummary(["tickets.rs"]).handles[0],
      canonicalVenueNamesByHandle: { "tickets.rs": "Ložionica" },
      venueNameOverridesByHandle: {},
      configuredVenueNamesByHandle: { "tickets.rs": "Ložionica" },
      serviceSecret: "qa-distinct-occurrence-secret",
      extracted: mixedExtracted,
    }),
  );
  assert.equal(
    guardedTransientMutations.length,
    0,
    "A transient past row with a different occurrence key must not shrink completeness.",
  );
  assert.equal(
    JSON.parse(guardedExisting.normalizedFieldsJson).sourceOccurrenceExpectedCount,
    2,
  );

  const guardedCaption = [guardedMissingLine, guardedCurrentLine].join("\n");
  const guardedPost = {
    ...mixedPost,
    caption: guardedCaption,
  };
  const guardedExtracted = makeExtractedEvent({
    title: "Upcoming Set",
    date: eligibleDateLabel,
    time: "20:00",
    venue: "Ložionica",
    artists: ["Upcoming Set"],
    source_caption: guardedCaption,
  });
  const guardedRecoveryCreates = [];
  await withoutConsoleInfo(() =>
    processIngestionPostWithExtractionForTesting({
      client: {
        query: async (reference) =>
          ingestionQueryResult(reference, [guardedExisting]),
        mutation: async (reference, args) => {
          if (reference === "reconciliationIngress:reconcileIngestionPlan") {
            return { authority: "legacy", outcomes: [] };
          }
          if ("representativeEventId" in args) {
            return { recorded: true };
          }
          if ("id" in args) {
            return { updated: true };
          }
          guardedRecoveryCreates.push(args);
          return {
            eventId: "qa-transient-guard-recovered-child",
            created: true,
            updatedAt: 2000,
          };
        },
      },
      handle: "tickets.rs",
      post: guardedPost,
      summary: createEmptyIngestionSummary(["tickets.rs"]).handles[0],
      canonicalVenueNamesByHandle: { "tickets.rs": "Ložionica" },
      venueNameOverridesByHandle: {},
      configuredVenueNamesByHandle: { "tickets.rs": "Ložionica" },
      serviceSecret: "qa-distinct-occurrence-secret",
      extracted: guardedExtracted,
    }),
  );
  assert.deepEqual(
    guardedRecoveryCreates.map((event) => event.date),
    [guardedMissingDate],
    "A later accurate extraction must still recover the child protected from transient shrinkage.",
  );

  const mixedRetrySummary = createEmptyIngestionSummary(["tickets.rs"]).handles[0];
  const mixedRetryMutations = [];
  await withoutConsoleInfo(() =>
    processIngestionPostWithExtractionForTesting({
      client: {
        query: async (reference) =>
          ingestionQueryResult(reference, [staleMixedExisting]),
        mutation: async (reference, args) => {
          if (reference === "reconciliationIngress:reconcileIngestionPlan") {
            return { authority: "legacy", outcomes: [] };
          }
          mixedRetryMutations.push(args);
          return "qa-unexpected-mixed-retry-mutation";
        },
      },
      handle: "tickets.rs",
      post: mixedPost,
      summary: mixedRetrySummary,
      canonicalVenueNamesByHandle: { "tickets.rs": "Ložionica" },
      venueNameOverridesByHandle: {},
      configuredVenueNamesByHandle: { "tickets.rs": "Ložionica" },
      serviceSecret: "qa-distinct-occurrence-secret",
      extracted: mixedExtracted,
    }),
  );
  assert.equal(mixedRetryMutations.length, 0);
  assert.equal(mixedRetrySummary.skippedDuplicates, 1);
  assert.equal(
    mixedRetrySummary.skipped_past_event,
    0,
    "A reduced complete eligible child set must skip before re-extracting past rows.",
  );

  const rangeDates = futureSameMonthIsoDateRange(2, 9);
  const rangeStart = datePartsForIsoDate(rangeDates[0]);
  const rangeEnd = datePartsForIsoDate(rangeDates[1]);
  const rangeCaption = [
    "Bioskop Akademije 28",
    "BROKEN ENGLISH",
    `Svake večeri od ${rangeStart.day}. do ${rangeEnd.day}. ${rangeStart.serbianMonthGenitive} u 19h`,
  ].join("\n");
  const rangePost = makeInstagramPost({
    postId: "qa-date-range-partial-persistence",
    instagramPostUrl: "https://www.instagram.com/p/qa-date-range-partial-persistence/",
    caption: rangeCaption,
    postType: "video",
    username: "akademija28",
  });
  const rangeExtracted = makeExtractedEvent({
    title: "BROKEN ENGLISH",
    date: "",
    time: "19:00",
    venue: "Akademija 28",
    artists: [],
    category: "arts & culture",
    confidence: 0.9,
    source_caption: rangeCaption,
    field_confirmation: makeFieldConfirmation(0.9),
  });
  const rangeInitialSummary = createEmptyIngestionSummary(["akademija28"]).handles[0];
  const rangeInitialCreates = [];
  await withoutConsoleInfoAndError(() =>
    processIngestionPostWithExtractionForTesting({
      client: {
        query: async (reference) => emptyIngestionQueryResult(reference),
        mutation: async (reference, args) => {
          if (reference === "reconciliationIngress:reconcileIngestionPlan") {
            return { authority: "legacy", outcomes: [] };
          }
          if (rangeInitialCreates.length > 0) {
            throw new Error("qa simulated second date insert failure");
          }
          rangeInitialCreates.push({ ...args, updatedAt: 1000 });
          return { eventId: "qa-range-first-date", created: true, updatedAt: 1000 };
        },
      },
      handle: "akademija28",
      post: rangePost,
      summary: rangeInitialSummary,
      canonicalVenueNamesByHandle: { akademija28: "Akademija 28" },
      venueNameOverridesByHandle: {},
      configuredVenueNamesByHandle: { akademija28: "Akademija 28" },
      serviceSecret: "qa-date-range-secret",
      extracted: rangeExtracted,
    }),
  );
  assert.equal(rangeInitialCreates.length, 1);
  assert.equal(rangeInitialSummary.insertedEvents, 1);
  assert.ok(
    rangeInitialSummary.errors.some((message) =>
      message.includes("qa simulated second date insert failure"),
    ),
    "The initial range pass must attempt and fail the second child before retry recovery.",
  );
  assert.equal(rangeInitialCreates[0].date, rangeDates[0]);
  assert.equal(
    buildSourceOccurrenceKeyForTesting(
      rangePost,
      rangeInitialCreates[0].date,
      "TBD",
      JSON.parse(rangeInitialCreates[0].normalizedFieldsJson),
    ),
    rangeInitialCreates[0].sourceOccurrenceKey,
    "Date-range child identity must remain stable when its time presentation changes.",
  );
  assert.equal(
    JSON.parse(rangeInitialCreates[0].normalizedFieldsJson).sourceOccurrenceExpectedCount,
    2,
    "Expanded date ranges must participate in source-child completeness tracking.",
  );

  const rangeFirstExisting = {
    ...rangeInitialCreates[0],
    _id: "qa-range-first-existing",
    time: "TBD",
    timeStatus: "tbd",
    normalizedFieldsJson: JSON.stringify({
      ...JSON.parse(rangeInitialCreates[0].normalizedFieldsJson),
      time: "TBD",
      timeStatus: "tbd",
    }),
  };
  const rangeRetrySummary = createEmptyIngestionSummary(["akademija28"]).handles[0];
  const rangeRetryCreates = [];
  await withoutConsoleInfo(() =>
    processIngestionPostWithExtractionForTesting({
      client: {
        query: async (reference) =>
          ingestionQueryResult(reference, [rangeFirstExisting]),
        mutation: async (reference, args) => {
          if (reference === "reconciliationIngress:reconcileIngestionPlan") {
            return { authority: "legacy", outcomes: [] };
          }
          if ("representativeEventId" in args) {
            return { recorded: true };
          }
          assert.equal("id" in args, false);
          rangeRetryCreates.push({ ...args, updatedAt: 2000 });
          return {
            eventId: "qa-range-recovered-second-date",
            created: true,
            updatedAt: 2000,
          };
        },
      },
      handle: "akademija28",
      post: rangePost,
      summary: rangeRetrySummary,
      canonicalVenueNamesByHandle: { akademija28: "Akademija 28" },
      venueNameOverridesByHandle: {},
      configuredVenueNamesByHandle: { akademija28: "Akademija 28" },
      serviceSecret: "qa-date-range-secret",
      extracted: rangeExtracted,
    }),
  );
  assert.deepEqual(rangeRetryCreates.map((event) => event.date), [rangeDates[1]]);
  assert.equal(rangeRetrySummary.insertedEvents, 1);
  assert.equal(rangeRetrySummary.skippedDuplicates, 1);

  const rangeCompleteEvents = [
    rangeFirstExisting,
    { ...rangeRetryCreates[0], _id: "qa-range-second-existing" },
  ];
  const rangeCompleteSummary = createEmptyIngestionSummary(["akademija28"]).handles[0];
  const rangeCompleteMutations = [];
  await withoutConsoleInfo(() =>
    processIngestionPostWithExtractionForTesting({
      client: {
        query: async (reference) =>
          ingestionQueryResult(reference, rangeCompleteEvents),
        mutation: async (reference, args) => {
          if (reference === "reconciliationIngress:reconcileIngestionPlan") {
            return { authority: "legacy", outcomes: [] };
          }
          rangeCompleteMutations.push(args);
          return "qa-unexpected-range-complete-mutation";
        },
      },
      handle: "akademija28",
      post: rangePost,
      summary: rangeCompleteSummary,
      canonicalVenueNamesByHandle: { akademija28: "Akademija 28" },
      venueNameOverridesByHandle: {},
      configuredVenueNamesByHandle: { akademija28: "Akademija 28" },
      serviceSecret: "qa-date-range-secret",
      extracted: rangeExtracted,
    }),
  );
  assert.equal(rangeCompleteMutations.length, 0);
  assert.equal(rangeCompleteSummary.skippedDuplicates, 1);

  const semanticSummary = createEmptyIngestionSummary(["tickets.rs"]).handles[0];
  const semanticInserted = [];
  const semanticUpdated = [];
  const semanticReceipts = [];
  const semanticExisting = {
    ...inserted[0],
    _id: "qa-other-source-same-time",
    instagramPostId: "qa-other-source-post",
    instagramPostUrl: "https://www.instagram.com/p/qa-other-source-post/",
  };
  await withoutConsoleInfo(() =>
    processIngestionPostWithExtractionForTesting({
      client: {
        query: async (reference, args) =>
          reference === "sourceOccurrences:listCandidatesForNormalizedOccurrence"
            ? ingestionQueryResult(reference, [semanticExisting])
            : "date" in args
              ? [semanticExisting]
              : [],
        mutation: async (reference, args) => {
          if (reference === "reconciliationIngress:reconcileIngestionPlan") {
            return { authority: "legacy", outcomes: [] };
          }
          if ("representativeEventId" in args) {
            semanticReceipts.push(args);
            return { recorded: true };
          }
          if ("id" in args) {
            semanticUpdated.push(args);
            return { updatedAt: semanticExisting.updatedAt + semanticUpdated.length };
          }
          const updatedAt = 2000 + semanticInserted.length;
          semanticInserted.push({ ...args, updatedAt });
          return {
            eventId: `qa-semantic-occurrence-${semanticInserted.length}`,
            created: true,
            updatedAt,
          };
        },
      },
      handle: "tickets.rs",
      post,
      summary: semanticSummary,
      canonicalVenueNamesByHandle: { "tickets.rs": "Ložionica" },
      venueNameOverridesByHandle: {},
      configuredVenueNamesByHandle: { "tickets.rs": "Ložionica" },
      serviceSecret: "qa-distinct-occurrence-secret",
      extracted,
    }),
  );
  assert.deepEqual(
    semanticInserted.map((event) => event.time),
    ["22:00"],
    "A same-title/date event from another source must not absorb a distinct explicit time.",
  );
  assert.equal(semanticUpdated.length, 0);
  assert.equal(semanticSummary.skippedDuplicates, 1);
  assert.equal(semanticSummary.insertedEvents, 1);
  assert.equal(semanticReceipts.length, 1);
  const completedSemanticPlan = semanticReceipts[0].plan;
  assert.deepEqual(
    [...completedSemanticPlan.expectedKeys].sort(),
    [
      semanticReceipts[0].satisfiedKey,
      semanticInserted[0].sourceOccurrenceKey,
    ].sort(),
  );
  const semanticReplaySummary = createEmptyIngestionSummary(["tickets.rs"]).handles[0];
  const semanticReplayMutations = [];
  const semanticReplayMediaActions = [];
  const semanticReplayPost = {
    ...post,
    imageUrl: "https://instagram.example/qa-replay.jpg",
    imageUrls: ["https://instagram.example/qa-replay.jpg"],
  };
  await withoutConsoleInfo(() =>
    processIngestionPostWithExtractionForTesting({
      client: {
        query: async (reference, args) =>
          "sourceIdentity" in args
            ? {
                ...completedSemanticPlan,
                satisfiedKeys: completedSemanticPlan.expectedKeys,
                satisfiedOccurrences: completedSemanticPlan.expectedKeys.map(
                  (key, index) => ({ key, eventId: `qa-semantic-representative-${index}` }),
                ),
              }
            : ingestionQueryResult(reference, [
                {
                  ...semanticExisting,
                  imageStorageId: undefined,
                  normalizedFieldsJson: JSON.stringify({
                    ...JSON.parse(semanticExisting.normalizedFieldsJson),
                    normalizedIsValid: true,
                    sourceGroundingVerified: true,
                  }),
                },
              ]),
        mutation: async (reference, args) => {
          if (reference === "reconciliationIngress:reconcileIngestionPlan") {
            return { authority: "legacy", outcomes: [] };
          }
          semanticReplayMutations.push(args);
          return "qa-unexpected-semantic-replay-mutation";
        },
        action: async (_reference, args) => {
          semanticReplayMediaActions.push(args);
          return { persisted: true };
        },
      },
      handle: "tickets.rs",
      post: semanticReplayPost,
      summary: semanticReplaySummary,
      canonicalVenueNamesByHandle: { "tickets.rs": "Ložionica" },
      venueNameOverridesByHandle: {},
      configuredVenueNamesByHandle: { "tickets.rs": "Ložionica" },
      serviceSecret: "qa-distinct-occurrence-secret",
      extracted,
    }),
  );
  assert.equal(semanticReplayMutations.length, 0);
  assert.equal(
    semanticReplayMediaActions.length,
    1,
    "A complete source receipt must still retry missing durable media.",
  );
  assert.equal(semanticReplaySummary.persistedImages, 1);
  assert.equal(semanticReplaySummary.skippedDuplicates, 1);
  assert.equal(semanticReplaySummary.insertedEvents, 0);

  const previousReprocessExisting = process.env.INGESTION_REPROCESS_EXISTING_SOURCE_POSTS;
  const forcedReplayMutations = [];
  process.env.INGESTION_REPROCESS_EXISTING_SOURCE_POSTS = "true";
  try {
    await withoutConsoleInfo(() =>
      processIngestionPostWithExtractionForTesting({
        client: {
          query: async (reference, args) =>
            "sourceIdentity" in args
              ? {
                  ...completedSemanticPlan,
                  satisfiedKeys: completedSemanticPlan.expectedKeys,
                  satisfiedOccurrences: completedSemanticPlan.expectedKeys.map(
                    (key, index) => ({
                      key,
                      eventId: index === 0 ? semanticExisting._id : `qa-force-event-${index}`,
                    })),
                }
              : ingestionQueryResult(reference, [semanticExisting]),
          mutation: async (reference, args) => {
            if (reference === "reconciliationIngress:reconcileIngestionPlan") {
              return { authority: "legacy", outcomes: [] };
            }
            forcedReplayMutations.push(args);
            return "id" in args
              ? { updatedAt: semanticExisting.updatedAt + forcedReplayMutations.length }
              : { eventId: "qa-force-replay-created", created: true, updatedAt: 3000 };
          },
        },
        handle: "tickets.rs",
        post,
        summary: createEmptyIngestionSummary(["tickets.rs"]).handles[0],
        canonicalVenueNamesByHandle: { "tickets.rs": "Ložionica" },
        venueNameOverridesByHandle: {},
        configuredVenueNamesByHandle: { "tickets.rs": "Ložionica" },
        serviceSecret: "qa-distinct-occurrence-secret",
        extracted,
      }),
    );
  } finally {
    if (previousReprocessExisting === undefined) {
      delete process.env.INGESTION_REPROCESS_EXISTING_SOURCE_POSTS;
    } else {
      process.env.INGESTION_REPROCESS_EXISTING_SOURCE_POSTS = previousReprocessExisting;
    }
  }
  assert.ok(
    forcedReplayMutations.length > 0,
    "The explicit reprocess override must bypass an otherwise complete receipt.",
  );

  const failedRepairFields = {
    ...JSON.parse(semanticExisting.normalizedFieldsJson),
    confidence: 0.1,
  };
  const failedRepairExisting = {
    ...semanticExisting,
    normalizedFieldsJson: JSON.stringify(failedRepairFields),
  };
  const failedRepairReceipts = [];
  const failedRepairSummary = createEmptyIngestionSummary(["tickets.rs"]).handles[0];
  await withoutConsoleInfo(() =>
    processIngestionPostWithExtractionForTesting({
      client: {
        query: async (reference, args) =>
          "sourceIdentity" in args
            ? null
            : "date" in args
              ? ingestionQueryResult(reference, [failedRepairExisting])
              : [],
        mutation: async (reference, args) => {
          if (reference === "reconciliationIngress:reconcileIngestionPlan") {
            return { authority: "legacy", outcomes: [] };
          }
          if ("representativeEventId" in args) {
            failedRepairReceipts.push(args);
            return { recorded: true };
          }
          if ("id" in args) {
            throw new Error("qa-required-duplicate-repair-failed");
          }
          return { eventId: "qa-failed-repair-other-child", created: true, updatedAt: 4000 };
        },
      },
      handle: "tickets.rs",
      post,
      summary: failedRepairSummary,
      canonicalVenueNamesByHandle: { "tickets.rs": "Ložionica" },
      venueNameOverridesByHandle: {},
      configuredVenueNamesByHandle: { "tickets.rs": "Ložionica" },
      serviceSecret: "qa-distinct-occurrence-secret",
      extracted,
    }),
  );
  assert.equal(failedRepairSummary.duplicate_update_failed, 1);
  assert.equal(
    failedRepairReceipts.length,
    0,
    "A child whose required duplicate repair failed must not be marked satisfied in the source receipt.",
  );
}

async function runApprovedMergeBoundaryQa() {
  const previousAdminUserIds = process.env.ADMIN_CLERK_USER_IDS;
  const adminUserId = "qa-merge-admin";
  process.env.ADMIN_CLERK_USER_IDS = adminUserId;
  const cleanReceiptTopologyAuditState = {
    _id: "qa-merge-receipt-topology-audit",
    key: "source-occurrence-receipt-topology-v1",
    phase: "receipt_topology_audit",
    isDone: true,
    scannedCount: 0,
    updatedCount: 0,
    mismatchCount: 0,
    unchangedCount: 0,
    errorCount: 0,
    skippedCount: 0,
    quarantinedLineageMarkerCount: 0,
    topologyEpoch: 0,
    completedAt: 1,
  };
  const cleanSourceOccurrenceTopologyEpoch = {
    _id: "qa-merge-source-occurrence-topology-epoch",
    key: "source-occurrence-topology-v1",
    currentEpoch: 0,
    verifiedEpoch: 0,
  };
  const primary = {
    _id: "qa-primary",
    title: "Primary Event",
    date: "2026-08-01",
    time: TBD_EVENT_TIME,
    venue: "Venue One",
    venueId: "venue-one",
    artists: [],
    eventType: "nightlife",
    canonicalSourceUrl: "https://www.instagram.com/p/QaMergePrimary/",
    instagramPostUrl: "https://www.instagram.com/p/QaMergePrimary/",
    status: "approved",
  };
  const duplicate = {
    ...primary,
    _id: "qa-duplicate",
    canonicalSourceUrl: "https://www.instagram.com/p/QaMergeDuplicate/",
    instagramPostUrl: "https://www.instagram.com/p/QaMergeDuplicate/",
    title: "Primary Event duplicate",
  };
  const conflict = {
    ...primary,
    _id: "qa-conflict",
    canonicalSourceUrl: "https://www.instagram.com/p/QaMergeConflict/",
    instagramPostUrl: "https://www.instagram.com/p/QaMergeConflict/",
    title: "Other Event",
    venue: "Venue Two",
    venueId: "venue-two",
  };
  let patched = false;
  const ctx = {
    auth: { getUserIdentity: async () => ({ subject: adminUserId }) },
    db: {
      get: async (id) =>
        id === primary._id
          ? primary
          : id === duplicate._id
            ? duplicate
            : id === conflict._id
              ? conflict
              : null,
      patch: async () => {
        patched = true;
      },
      query: (table) =>
        table === "venues"
        ? {
            collect: async () => [
                {
                  _id: "venue-one",
                  name: "Venue One",
                  instagramHandle: "venue_one",
                  category: "nightlife",
                  publicStatus: "published",
                },
                {
                  _id: "venue-two",
                  name: "Venue Two",
                  instagramHandle: "venue_two",
                  category: "nightlife",
                publicStatus: "published",
              },
            ],
            take: async (limit) => [
              {
                _id: "venue-one",
                name: "Venue One",
                instagramHandle: "venue_one",
                category: "nightlife",
                publicStatus: "published",
              },
              {
                _id: "venue-two",
                name: "Venue Two",
                instagramHandle: "venue_two",
                category: "nightlife",
                publicStatus: "published",
              },
            ].slice(0, limit),
          }
        : table === "venueIdentities"
          ? {
              withIndex: () => ({ take: async () => [] }),
            }
        : table === "eventDomainMigrationState"
          ? {
              withIndex: (_indexName, configure) => {
                let key = null;
                const indexBuilder = {
                  eq: (field, value) => {
                    if (field === "key") key = value;
                    return indexBuilder;
                  },
                };
                configure(indexBuilder);
                return {
                  take: async (limit) =>
                    key === cleanReceiptTopologyAuditState.key
                      ? [cleanReceiptTopologyAuditState].slice(0, limit)
                      : [],
                };
              },
            }
        : table === "sourceOccurrenceTopologyEpoch"
          ? {
              withIndex: (_indexName, configure) => {
                let key = null;
                const indexBuilder = {
                  eq: (field, value) => {
                    if (field === "key") key = value;
                    return indexBuilder;
                  },
                };
                configure(indexBuilder);
                return {
                  take: async (limit) =>
                    key === cleanSourceOccurrenceTopologyEpoch.key
                      ? [cleanSourceOccurrenceTopologyEpoch].slice(0, limit)
                      : [],
                };
              },
            }
        : {
              withIndex: () => ({
                collect: async () => [primary, duplicate, conflict],
                take: async (limit) => [primary, duplicate, conflict].slice(0, limit),
              }),
            },
    },
  };
  try {
    await assert.rejects(
      () =>
        mergeApprovedEvents._handler(ctx, {
          primaryId: primary._id,
          duplicateIds: [duplicate._id],
          patch: { title: "Closed for vacation" },
        }),
      /title is not suitable/,
      "Approved-event merge must not replace the primary with a non-event title.",
    );
    assert.equal(patched, false);
    await assert.rejects(
      () =>
        mergeApprovedEvents._handler(ctx, {
          primaryId: primary._id,
          duplicateIds: [duplicate._id],
          patch: { venue: "Venue Two" },
        }),
      /same-day occurrence is ambiguous/,
      "Approved-event merge must not move the primary onto another approved venue/date.",
    );
    assert.equal(patched, false);
  } finally {
    if (previousAdminUserIds === undefined) delete process.env.ADMIN_CLERK_USER_IDS;
    else process.env.ADMIN_CLERK_USER_IDS = previousAdminUserIds;
  }
}

async function runTransactionalSourceGroundingReprocessQa() {
  const previousCronSecret = process.env.CRON_SECRET;
  const previousAdminUserIds = process.env.ADMIN_CLERK_USER_IDS;
  const serviceSecret = "qa-source-grounding-reprocess-secret";
  const adminUserId = "qa-source-grounding-reprocess-admin";
  process.env.CRON_SECRET = serviceSecret;
  process.env.ADMIN_CLERK_USER_IDS = adminUserId;

  const makeEvent = ({ id, date, day, venue, handle, postId, updatedAt }) => {
    const title = `Grounded Batch Event ${id.toUpperCase()}`;
    const artist = `Grounded Batch Artist ${id.toUpperCase()}`;
    const caption = `${title} ${day}. jul @ ${venue} uz ${artist}`;
    const instagramPostUrl = `https://www.instagram.com/p/${postId}/`;
    const event = {
      _id: id,
      title,
      date,
      time: TBD_EVENT_TIME,
      venue,
      venueInstagramHandle: handle,
      artists: [artist],
      imageUrl: `https://example.com/${id}.jpg`,
      sourceCaption: caption,
      sourcePostedAt: "2026-07-01T12:00:00.000Z",
      instagramPostId: postId,
      instagramPostUrl,
      eventType: "nightlife",
      status: "pending",
      normalizedFieldsJson: JSON.stringify({
        sourceGroundingVerified: false,
        moderationPendingReasons: ["caption_source_event_mismatch"],
      }),
      createdAt: updatedAt - 100,
      updatedAt,
    };
    const nextNormalizedFieldsJson = JSON.stringify({
      title,
      time: TBD_EVENT_TIME,
      artists: [artist],
      postAltText: null,
      sourceGroundingSourceKind: "caption",
      sourceGroundingSourceCaption: caption,
      sourceGroundingInstagramPostId: postId,
      sourceGroundingInstagramPostUrl: instagramPostUrl,
      sourceGroundingInstagramHandle: handle,
      sourceGroundingVersion: 4,
      sourceGroundingEvidence: "instagram_caption",
      approvalTitleSensible: true,
      approvalCaptionSourceCoherent: true,
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
      normalizedDate: date,
      normalizedVenue: venue,
      normalizedIsValid: true,
      titleUsedFallback: false,
      dateSuspiciousYear: false,
      dateConfidence: "high",
      missingImage: false,
      moderationAllowMissingImage: false,
    });
    return {
      event,
      nextNormalizedFieldsJson,
      sourcePost: {
        handle,
        username: handle,
        postId,
        instagramPostUrl,
        caption,
        postedAt: "2026-07-01T12:00:00.000Z",
      },
    };
  };

  const qaA = makeEvent({
    id: "qa-batch-a",
    date: "2026-07-30",
    day: 30,
    venue: "Grounded Batch Venue A",
    handle: "qa_batch_venue_a",
    postId: "qa-batch-post-a",
    updatedAt: 1000,
  });
  const qaB = makeEvent({
    id: "qa-batch-b",
    date: "2026-07-31",
    day: 31,
    venue: "Grounded Batch Venue B",
    handle: "qa_batch_venue_b",
    postId: "qa-batch-post-b",
    updatedAt: 2000,
  });
  const replayWindowResults = prepareEventsForInsert(
    {
      postId: "qa-replay-window-post",
      caption:
        "Grounded Replay Window Event 20. jul @ Grounded Replay Window Venue uz Grounded Replay Artist",
      altText: null,
      imageUrl: "https://example.com/qa-replay-window.jpg",
      imageUrls: ["https://example.com/qa-replay-window.jpg"],
      postType: "image",
      locationName: null,
      instagramPostUrl: "https://www.instagram.com/p/qa-replay-window-post/",
      postedAt: "2026-07-20T08:00:00.000Z",
      username: "qa_replay_window",
    },
    makeExtractedEvent({
      title: "Grounded Replay Window Event",
      date: "2026-07-20",
      time: "",
      venue: "Grounded Replay Window Venue",
      artists: ["Grounded Replay Artist"],
      description: "Grounded Replay Window Event",
      category: "nightlife",
      price: "",
      currency: "",
      confidence: 0.95,
      source_caption:
        "Grounded Replay Window Event 20. jul @ Grounded Replay Window Venue uz Grounded Replay Artist",
      schedule_entries: [],
    }),
    "https://example.com/qa-replay-window.jpg",
    {},
    {},
    {},
    { eventDateFilterNow: new Date("2026-07-20T12:00:00.000Z") },
  );
  assert.ok(
    replayWindowResults.some(
      (result) => result.kind === "ok" && result.event.date === "2026-07-20",
    ),
    "Backlog preparation must support an explicit original date-window clock.",
  );
  const clone = (value) => JSON.parse(JSON.stringify(value));

  const createHarness = (records = [qaA, qaB]) => {
    let committedEvents = new Map(records.map(({ event }) => [event._id, clone(event)]));
    let committedAuditRows = [];
    const sourcePosts = records.map(({ sourcePost }) => clone(sourcePost));
    const snapshot = () => ({
      events: [...committedEvents.values()].map(clone),
      audits: committedAuditRows.map(clone),
    });

    const run = async (args) => {
      const stagedEvents = new Map(
        [...committedEvents.entries()].map(([id, event]) => [id, clone(event)]),
      );
      const stagedAuditRows = committedAuditRows.map(clone);
      const makeQuery = (table) => {
        const filters = {};
        const q = {
          eq(field, value) {
            filters[field] = value;
            return q;
          },
        };
        const readRows = () => {
          const rows = table === "events" ? [...stagedEvents.values()] : sourcePosts;
          return rows.filter((row) =>
            Object.entries(filters).every(([field, value]) => row[field] === value),
          );
        };
        return {
          withIndex(_indexName, build) {
            build(q);
            return {
              collect: async () => readRows().map(clone),
              first: async () => clone(readRows()[0] ?? null),
              take: async (limit) => readRows().slice(0, limit).map(clone),
            };
          },
        };
      };
      const ctx = {
        auth: { getUserIdentity: async () => ({ subject: adminUserId }) },
        db: {
          get: async (id) => clone(stagedEvents.get(id) ?? null),
          patch: async (id, patch) => {
            stagedEvents.set(id, { ...stagedEvents.get(id), ...clone(patch) });
          },
          insert: async (table, value) => {
            assert.equal(table, "eventAuditLog");
            stagedAuditRows.push({ _id: `audit-${stagedAuditRows.length + 1}`, ...clone(value) });
            return `audit-${stagedAuditRows.length}`;
          },
          query: makeQuery,
        },
      };
      const result = await reprocessPendingSourceGroundingBatch._handler(ctx, args);
      committedEvents = stagedEvents;
      committedAuditRows = stagedAuditRows;
      return result;
    };
    return { run, snapshot };
  };

  const itemFor = ({ event, nextNormalizedFieldsJson }) => ({
    id: event._id,
    expectedUpdatedAt: event.updatedAt,
    expectedNormalizedFieldsJson: event.normalizedFieldsJson,
    nextNormalizedFieldsJson,
  });
  const argsFor = (records) => ({ serviceSecret, items: records.map(itemFor) });

  try {
    const success = createHarness();
    const before = success.snapshot();
    const result = await success.run(argsFor([qaA, qaB]));
    assert.deepEqual(result.eventIds, [qaA.event._id, qaB.event._id]);
    assert.equal(result.updatedCount, 2);
    const after = success.snapshot();
    assert.equal(after.audits.length, 2);
    for (const source of [qaA, qaB]) {
      const previous = before.events.find((event) => event._id === source.event._id);
      const current = after.events.find((event) => event._id === source.event._id);
      const changedKeys = Object.keys(current).filter(
        (key) => JSON.stringify(current[key]) !== JSON.stringify(previous[key]),
      );
      assert.deepEqual(changedKeys.sort(), [
        "normalizedFieldsJson",
        "occurrenceArtistFingerprint",
        "occurrenceDateKey",
        "occurrenceEventType",
        "occurrenceSignatureHash",
        "occurrenceSignatureVersion",
        "occurrenceTimeIdentity",
        "occurrenceTitleFamily",
        "occurrenceVenueIdentity",
        "publicationEvaluatedAt",
        "publicationPolicyVersion",
        "publicationReason",
        "publicationState",
        "status",
        "updatedAt",
      ]);
      assert.equal(current.status, "approved");
      assert.equal(current.normalizedFieldsJson, source.nextNormalizedFieldsJson);
    }
    for (const audit of after.audits) {
      assert.equal(audit.action, "source_grounding_reprocessed");
      assert.deepEqual(Object.keys(JSON.parse(audit.patchJson)).sort(), [
        "normalizedFieldsJson",
        "status",
      ]);
    }
    const successfulSnapshot = success.snapshot();
    await assert.rejects(() => success.run(argsFor([qaA, qaB])), /expected pending|status changed/iu);
    assert.deepEqual(success.snapshot(), successfulSnapshot);

    const duplicate = createHarness();
    const duplicateBefore = duplicate.snapshot();
    await assert.rejects(
      () => duplicate.run({ serviceSecret, items: [itemFor(qaA), itemFor(qaA)] }),
      /duplicate/iu,
    );
    assert.deepEqual(duplicate.snapshot(), duplicateBefore);

    const stale = createHarness();
    const staleBefore = stale.snapshot();
    await assert.rejects(
      () =>
        stale.run({
          serviceSecret,
          items: [itemFor(qaA), { ...itemFor(qaB), expectedUpdatedAt: qaB.event.updatedAt - 1 }],
        }),
      /changed during reprocessing|updatedAt/iu,
    );
    assert.deepEqual(stale.snapshot(), staleBefore);

    const heldB = {
      ...qaB,
      event: {
        ...qaB.event,
        normalizedFieldsJson: JSON.stringify({
          sourceGroundingVerified: false,
          moderationPendingReasons: [
            "caption_source_event_mismatch",
            "manual_safety_hold",
          ],
        }),
      },
    };
    const unrelatedHold = createHarness([qaA, heldB]);
    const unrelatedHoldBefore = unrelatedHold.snapshot();
    await assert.rejects(
      () => unrelatedHold.run(argsFor([qaA, heldB])),
      /unrelated moderation holds block source-grounding reprocessing/iu,
    );
    assert.deepEqual(unrelatedHold.snapshot(), unrelatedHoldBefore);

    const invalid = createHarness();
    const invalidBefore = invalid.snapshot();
    await assert.rejects(
      () =>
        invalid.run({
          serviceSecret,
          items: [
            itemFor(qaA),
            {
              ...itemFor(qaB),
              nextNormalizedFieldsJson: JSON.stringify({ sourceGroundingVerified: true }),
            },
          ],
        }),
      /complete source-grounded evidence|cannot approve/iu,
    );
    assert.deepEqual(invalid.snapshot(), invalidBefore);

    const conflictB = makeEvent({
      id: "qa-batch-b",
      date: "2026-07-30",
      day: 30,
      venue: "Grounded Batch Venue A",
      handle: "qa_batch_venue_b",
      postId: "qa-batch-post-b",
      updatedAt: 2000,
    });
    const conflict = createHarness([qaA, conflictB]);
    const conflictBefore = conflict.snapshot();
    await assert.rejects(
      () => conflict.run(argsFor([qaA, conflictB])),
      /(?:canonical occurrence|same-day occurrence is ambiguous)/iu,
    );
    assert.deepEqual(conflict.snapshot(), conflictBefore);

    const adminFallback = createHarness();
    const adminBefore = adminFallback.snapshot();
    await assert.rejects(
      () => adminFallback.run({ ...argsFor([qaA]), serviceSecret: "wrong-secret" }),
      /service authentication required/iu,
    );
    assert.deepEqual(adminFallback.snapshot(), adminBefore);
  } finally {
    if (previousCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousCronSecret;
    if (previousAdminUserIds === undefined) delete process.env.ADMIN_CLERK_USER_IDS;
    else process.env.ADMIN_CLERK_USER_IDS = previousAdminUserIds;
  }
}

function runTrustedSourceAnnouncementModerationQa() {
  const sourceCaption = "Koncert Open Air Festival 31.12.2099 at QA Trusted Venue";
  const postId = "qa-trusted-source-post";
  const postUrl = `https://www.instagram.com/p/${postId}/`;
  const fields = {
    title: "Open Air Festival",
    normalizedDate: "2099-12-31",
    normalizedVenue: "QA Trusted Venue",
    trustedVenueSource: true,
    normalizedIsValid: true,
    titleUsedFallback: false,
    dateSuspiciousYear: false,
    dateConfidence: "high",
    moderationConfidenceScore: 0.72,
    moderationAutoApproved: true,
    moderationAutoApproveRule: "trusted_source_event_announcement",
    moderationPendingReasons: [],
    // These strict-source holds are intentionally acceptable for an operator-
    // configured venue source. A non-event hold is not.
    moderationSignals: ["unverified_core_event_source"],
    sourceGroundingInstagramHandle: "qa_trusted_venue",
    sourceGroundingTitleVerified: true,
    sourceGroundingDateVerified: true,
    sourceGroundingIdentityContextVerified: true,
    sourceGroundingSourceCaption: sourceCaption,
    sourceGroundingInstagramPostId: postId,
    sourceGroundingInstagramPostUrl: postUrl,
  };
  const event = {
    title: "Open Air Festival",
    date: "2099-12-31",
    venue: "QA Trusted Venue",
    venueInstagramHandle: "@qa_trusted_venue",
    sourceCaption,
    instagramPostId: postId,
    instagramPostUrl: postUrl,
  };

  assert.equal(
    hasTrustedSourceEventAnnouncementAutoApproval(JSON.stringify(fields), event),
    true,
    "A configured venue source may publish a supported future announcement despite strict coherence holds.",
  );
  assert.doesNotThrow(() =>
    assertServiceCreateEventPolicy("approved", JSON.stringify(fields), event),
  );

  assert.equal(
    hasTrustedSourceEventAnnouncementAutoApproval(
      JSON.stringify({ ...fields, trustedVenueSource: false }),
      event,
    ),
    false,
    "Unknown/promoter sources must not use the trusted-source relaxation.",
  );
  assert.equal(
    hasTrustedSourceEventAnnouncementAutoApproval(
      JSON.stringify({ ...fields, normalizedDate: "2020-07-31" }),
      { ...event, date: "2020-07-31" },
    ),
    false,
    "Past dates remain blocked even for a trusted venue source.",
  );
  assert.equal(
    hasTrustedSourceEventAnnouncementAutoApproval(
      JSON.stringify({ ...fields, moderationSignals: ["non_event_closure_notice"] }),
      event,
    ),
    false,
    "A known venue does not turn a non-event notice into an event.",
  );
  assert.equal(
    hasTrustedSourceEventAnnouncementAutoApproval(
      JSON.stringify({ ...fields, sourceGroundingTitleVerified: false }),
      event,
    ),
    false,
    "The venue mapping cannot replace title evidence from the post.",
  );
  assert.equal(
    hasTrustedSourceEventAnnouncementAutoApproval(
      JSON.stringify({ ...fields, dateSuspiciousYear: true }),
      event,
    ),
    false,
    "Suspicious dates remain blocked.",
  );

  const futureDateValue = new Date();
  futureDateValue.setUTCDate(futureDateValue.getUTCDate() + 7);
  const futureDate = futureDateValue.toISOString().slice(0, 10);
  const futureDateParts = datePartsForIsoDate(futureDate);
  const post = makeInstagramPost({
    username: "qa_trusted_venue",
    postedAt: new Date().toISOString(),
    caption: `Koncert Trusted Poster Night ${futureDateParts.day} ${futureDateParts.monthAbbr} ${futureDate.slice(0, 4)}`,
  });
  const extracted = makeExtractedEvent({
    title: "Trusted Poster Night",
    date: futureDate,
    venue: "QA Trusted Venue",
    confidence: 0.9,
    artists: [],
    time: "",
    date_evidence: {
      exact_text: `${futureDateParts.day} ${futureDateParts.monthAbbr} ${futureDate.slice(0, 4)}`,
      source: "caption",
      is_relative: false,
      resolved_date: futureDate,
    },
    time_evidence: {
      status: "not_stated",
      exact_text: "",
      source: "unknown",
    },
  });
  const [unknownRoleResult] = prepareEventsForInsert(
    post,
    extracted,
    null,
    { qa_trusted_venue: "QA Trusted Venue" },
    {},
    { qa_trusted_venue: "QA Trusted Venue" },
    { sourceRolesByHandle: { qa_trusted_venue: "unknown" }, eventDateFilterNow: new Date() },
  );
  assert.equal(unknownRoleResult.kind, "ok", JSON.stringify(unknownRoleResult));
  assert.equal(
    unknownRoleResult.normalizedFields.trustedVenueSource,
    true,
    "An exact configured canonical mapping works during unknown-role migration.",
  );
  assert.equal(unknownRoleResult.event.status, "approved", JSON.stringify(unknownRoleResult));

  const [promoterResult] = prepareEventsForInsert(
    post,
    extracted,
    null,
    { qa_trusted_venue: "QA Trusted Venue" },
    {},
    { qa_trusted_venue: "QA Trusted Venue" },
    { sourceRolesByHandle: { qa_trusted_venue: "promoter" }, eventDateFilterNow: new Date() },
  );
  assert.equal(promoterResult.kind, "ok");
  assert.equal(promoterResult.normalizedFields.trustedVenueSource, false);

  const [genericSaveTheDate] = prepareEventsForInsert(
    makeInstagramPost({
      username: "qa_trusted_venue",
      postedAt: new Date().toISOString(),
      caption: `Save the date: ${futureDateParts.day} ${futureDateParts.monthAbbr}.`,
    }),
    extracted,
    null,
    { qa_trusted_venue: "QA Trusted Venue" },
    {},
    { qa_trusted_venue: "QA Trusted Venue" },
    { sourceRolesByHandle: { qa_trusted_venue: "unknown" }, eventDateFilterNow: new Date() },
  );
  assert.equal(genericSaveTheDate.kind, "ok");
  assert.equal(
    genericSaveTheDate.event.status,
    "pending",
    "A generic Save-the-date post cannot use venue context to invent an event title.",
  );
}

function runVenueAccountCanonicalLocationQa() {
  const eventDate = isoDateDaysFromNow(9);
  const canonicalVenueNamesByHandle = {
    "lavariete.belgrade": "La Variete",
    kcgrad: "KC Grad",
  };
  const canonicalVenueLocationsByHandle = {
    "lavariete.belgrade": "Francuska 6",
    kcgrad: "Braće Krsmanović 4",
  };
  const makePrepared = ({ rawVenue, sourceRole }) => {
    const caption = `QA La Variete Night ${eventDate} 21:00. Vidimo se u ${rawVenue}.`;
    const postId = `qa-la-variete-${sourceRole}-${rawVenue}`;
    const postUrl = `https://www.instagram.com/p/${encodeURIComponent(postId)}/`;
    const post = makeInstagramPost({
      caption,
      imageUrl: "https://images.example.com/la-variete-night.jpg",
      imageUrls: ["https://images.example.com/la-variete-night.jpg"],
      instagramPostUrl: postUrl,
      postId,
      postType: "image",
      username: "lavariete.belgrade",
    });
    const locationEvidence = {
      confidence: 0.95,
      found_in: ["caption"],
      evidence: rawVenue,
      evidence_snippets: [{ source: "caption", text: rawVenue }],
      notes: "Exact caption location evidence.",
    };
    const extracted = makeExtractedEvent({
      extraction_contract_version: "event_evidence_v2",
      title: "QA La Variete Night",
      date: eventDate,
      time: "21:00",
      venue: rawVenue,
      artists: [],
      source_caption: caption,
      source_url: postUrl,
      date_evidence: {
        exact_text: eventDate,
        source: "caption",
        is_relative: false,
        resolved_date: eventDate,
      },
      time_evidence: {
        status: "start_time_stated",
        exact_text: "21:00",
        source: "caption",
      },
      field_confirmation: {
        ...makeFieldConfirmation(0.95),
        title: {
          confidence: 0.95,
          found_in: ["caption"],
          evidence: "QA La Variete Night",
          evidence_snippets: [
            { source: "caption", text: "QA La Variete Night" },
          ],
          notes: "Exact caption title.",
        },
        location: locationEvidence,
        location_name: locationEvidence,
      },
    });
    const [prepared] = prepareEventsForInsert(
      post,
      extracted,
      "https://images.example.com/la-variete-night.jpg",
      canonicalVenueNamesByHandle,
      {},
      canonicalVenueNamesByHandle,
      {
        canonicalVenueLocationsByHandle,
        eventDateFilterNow: new Date(QA_NOW_ISO),
        sourceRolesByHandle: { "lavariete.belgrade": sourceRole },
      },
    );
    assert.equal(prepared.kind, "ok", JSON.stringify(prepared));
    return prepared;
  };

  const canonicalAddress = makePrepared({
    rawVenue: "Francuska 6",
    sourceRole: "venue",
  });
  assert.equal(canonicalAddress.event.venue, "La Variete");
  assert.equal(canonicalAddress.normalizedFields.normalizedVenue, "La Variete");
  assert.equal(canonicalAddress.normalizedFields.venueSource, "handle_map");
  assert.equal(canonicalAddress.normalizedFields.rawVenue, "Francuska 6");
  assert.equal(canonicalAddress.normalizedFields.canonicalVenueLocation, "Francuska 6");
  assert.equal(canonicalAddress.normalizedFields.rawVenueMatchesCanonicalLocation, true);
  assert.equal(canonicalAddress.normalizedFields.trustedVenueSource, true);
  assert.equal(canonicalAddress.event.status, "approved", JSON.stringify(canonicalAddress));

  const promoterAddress = makePrepared({
    rawVenue: "Francuska 6",
    sourceRole: "promoter",
  });
  assert.equal(promoterAddress.event.venue, "Francuska 6");
  assert.equal(promoterAddress.normalizedFields.normalizedVenue, "Francuska 6");
  assert.equal(promoterAddress.normalizedFields.trustedVenueSource, false);

  const namedOffsiteVenue = makePrepared({
    rawVenue: "KC Grad",
    sourceRole: "venue",
  });
  assert.equal(namedOffsiteVenue.event.venue, "KC Grad");
  assert.equal(namedOffsiteVenue.normalizedFields.normalizedVenue, "KC Grad");
  assert.equal(namedOffsiteVenue.normalizedFields.venueSource, "model");
  assert.equal(namedOffsiteVenue.normalizedFields.rawVenueMatchesCanonicalLocation, false);
  assert.equal(namedOffsiteVenue.normalizedFields.trustedVenueSource, false);

  const makeStructuredPrepared = ({ rawVenue, sourceRole, useSharedVenue = false }) => {
    const title = "QA La Variete Schedule";
    const sourceLine = `${title} ${eventDate} 21:00 ${rawVenue}`;
    const postId = `qa-la-variete-schedule-${sourceRole}-${useSharedVenue ? "shared" : "row"}-${rawVenue}`;
    const postUrl = `https://www.instagram.com/p/${encodeURIComponent(postId)}/`;
    const post = makeInstagramPost({
      caption: sourceLine,
      imageUrl: "https://images.example.com/la-variete-schedule.jpg",
      imageUrls: ["https://images.example.com/la-variete-schedule.jpg"],
      instagramPostUrl: postUrl,
      postId,
      postType: "image",
      username: "lavariete.belgrade",
    });
    const extracted = makeExtractedEvent({
      extraction_contract_version: "event_evidence_v2",
      title: "",
      date: "",
      time: "",
      venue: "",
      artists: [],
      description: "",
      source_caption: sourceLine,
      source_url: postUrl,
      date_evidence: {
        exact_text: "",
        source: "unknown",
        is_relative: false,
        resolved_date: "",
      },
      time_evidence: {
        status: "not_stated",
        exact_text: "",
        source: "unknown",
      },
      shared_schedule_context: {
        venue: {
          applies_to_all: useSharedVenue,
          value: useSharedVenue ? rawVenue : "",
          evidence: useSharedVenue ? rawVenue : "",
          source: useSharedVenue ? "caption" : "unknown",
        },
        time: {
          applies_to_all: false,
          value: "",
          evidence: "",
          source: "unknown",
        },
      },
      schedule_entries: [
        {
          date: eventDate,
          time: "21:00",
          venue: useSharedVenue ? "" : rawVenue,
          title,
          artists: [],
          description: `${title} at ${rawVenue}.`,
          source_text: sourceLine,
          date_evidence: {
            exact_text: eventDate,
            source: "caption",
            is_relative: false,
            resolved_date: eventDate,
          },
          time_evidence: {
            status: "start_time_stated",
            exact_text: "21:00",
            source: "caption",
          },
        },
      ],
    });
    const [prepared] = prepareEventsForInsert(
      post,
      extracted,
      "https://images.example.com/la-variete-schedule.jpg",
      canonicalVenueNamesByHandle,
      {},
      canonicalVenueNamesByHandle,
      {
        canonicalVenueLocationsByHandle,
        eventDateFilterNow: new Date(QA_NOW_ISO),
        sourceRolesByHandle: { "lavariete.belgrade": sourceRole },
      },
    );
    assert.equal(prepared.kind, "ok", JSON.stringify(prepared));
    return prepared;
  };

  for (const useSharedVenue of [false, true]) {
    const scheduleAddress = makeStructuredPrepared({
      rawVenue: "Francuska 6",
      sourceRole: "venue",
      useSharedVenue,
    });
    assert.equal(scheduleAddress.event.venue, "La Variete");
    assert.equal(scheduleAddress.normalizedFields.rawVenue, "Francuska 6");
    assert.equal(
      scheduleAddress.normalizedFields.rawVenueMatchesCanonicalLocation,
      true,
    );
    assert.equal(scheduleAddress.normalizedFields.venueSource, "handle_map");
    assert.equal(scheduleAddress.normalizedFields.trustedVenueSource, true);
    assert.equal(scheduleAddress.event.status, "approved", JSON.stringify(scheduleAddress));
  }

  const schedulePromoterAddress = makeStructuredPrepared({
    rawVenue: "Francuska 6",
    sourceRole: "promoter",
  });
  assert.equal(schedulePromoterAddress.event.venue, "Francuska 6");
  assert.equal(schedulePromoterAddress.normalizedFields.rawVenue, "Francuska 6");
  assert.equal(schedulePromoterAddress.normalizedFields.trustedVenueSource, false);
  assert.equal(schedulePromoterAddress.normalizedFields.venueSource, "model");

  for (const useSharedVenue of [false, true]) {
    const scheduleUnknownAddress = makeStructuredPrepared({
      rawVenue: "Francuska 6",
      sourceRole: "unknown",
      useSharedVenue,
    });
    assert.equal(scheduleUnknownAddress.event.venue, "Francuska 6");
    assert.equal(scheduleUnknownAddress.normalizedFields.rawVenue, "Francuska 6");
    assert.equal(
      scheduleUnknownAddress.normalizedFields.rawVenueMatchesCanonicalLocation,
      true,
    );
    assert.equal(scheduleUnknownAddress.normalizedFields.venueSource, "model");
    assert.equal(scheduleUnknownAddress.normalizedFields.trustedVenueSource, false);
  }

  const scheduleNamedOffsiteVenue = makeStructuredPrepared({
    rawVenue: "KC Grad",
    sourceRole: "venue",
  });
  assert.equal(scheduleNamedOffsiteVenue.event.venue, "KC Grad");
  assert.equal(scheduleNamedOffsiteVenue.normalizedFields.rawVenue, "KC Grad");
  assert.equal(
    scheduleNamedOffsiteVenue.normalizedFields.rawVenueMatchesCanonicalLocation,
    false,
  );
  assert.equal(scheduleNamedOffsiteVenue.normalizedFields.venueSource, "model");
  assert.equal(scheduleNamedOffsiteVenue.normalizedFields.trustedVenueSource, false);
}

runPromptQa();
runVenueQa();
runArtistAndDescriptionQa();
runConfidenceQa();
runTrustedSourceAnnouncementModerationQa();
runVenueAccountCanonicalLocationQa();
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
await runHardMappedVenueAuthorityMutationBoundaryQa();
await runDistinctOccurrencePersistenceQa();
await runApprovedMergeBoundaryQa();
await runTransactionalSourceGroundingReprocessQa();

console.log("QA passed: extraction prompt, venue standardization, artists, description, video moderation, source-grounded auto-approval, fail-closed review gating, service mutation payload binding, transactional source-grounding reprocessing, atomic duplicate status preconditions, caption date ranges, Serbian relative dates, description start times, schedule consistency, and ticket prices.");
