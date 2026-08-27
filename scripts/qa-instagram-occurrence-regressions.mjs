import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  eventRepresentsExpectedOccurrenceForTesting,
  getInstagramSourceOccurrenceReceipt,
} from "../convex/events.ts";
import {
  containsNamedWeekday,
  findNamedWeekday,
  findNamedWeekdays,
} from "../lib/events/event-validation.ts";
import {
  bindSourceOccurrenceMetadata,
  buildSourceOccurrenceKeyForTesting,
  createEmptyIngestionSummary,
  findBestExistingMatchForPreparedEventForTesting,
  persistInstagramMediaCandidates,
  prepareEventsForInsert,
  processIngestionPostWithExtractionForTesting,
} from "../lib/pipeline/run-instagram-ingestion.ts";
import { RemoteMediaHttpError } from "../lib/ai/prepare-image-for-openai.ts";

const NOW = new Date("2026-07-28T18:00:00Z");
const IMAGE_URL = "https://example.com/poster.jpg";

async function withoutConsoleNoise(callback) {
  const original = {
    error: console.error,
    info: console.info,
    log: console.log,
    warn: console.warn,
  };
  console.error = () => {};
  console.info = () => {};
  console.log = () => {};
  console.warn = () => {};
  try {
    return await callback();
  } finally {
    console.error = original.error;
    console.info = original.info;
    console.log = original.log;
    console.warn = original.warn;
  }
}

function makePost(overrides = {}) {
  return {
    caption: "",
    altText: null,
    locationName: null,
    username: "venue",
    handle: "venue",
    postId: "qa-post",
    instagramPostUrl: "https://www.instagram.com/p/qa-post/",
    postedAt: "2026-07-28T12:00:00.000Z",
    imageUrl: IMAGE_URL,
    imageUrls: [IMAGE_URL],
    postType: "image",
    ...overrides,
  };
}

function makeExtraction(overrides = {}) {
  return {
    extraction_contract_version: "legacy_qa_fixture_v1",
    is_event: true,
    non_event_reason: "",
    title: "",
    date: "",
    time: "",
    venue: "Venue",
    city: "Belgrade",
    country: "Serbia",
    price: "",
    currency: "RSD",
    artists: [],
    category: "learning",
    description: "",
    confidence: 0.95,
    reasoning_notes: "",
    source_caption: "",
    source_url: "https://www.instagram.com/p/qa-post/",
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
    source_conflicts: [],
    shared_schedule_context: {
      venue: { applies_to_all: false, value: "", evidence: "", source: "unknown" },
      time: { applies_to_all: false, value: "", evidence: "", source: "unknown" },
    },
    schedule_entries: [],
    field_confirmation: Object.fromEntries(
      ["title", "location", "location_name", "price", "start_time", "short_description", "artists"].map(
        (key) => [
          key,
          {
            confidence: 0.95,
            found_in: ["poster"],
            evidence: key,
            evidence_snippets: [{ source: "poster", text: key }],
            notes: "",
          },
        ],
      ),
    ),
    ...overrides,
  };
}

// Every configured source handle has an exact canonical venue mapping, even
// when its source role has not been classified yet. That trusted context must
// reach both AI extraction and venue normalization; it must never fall back to
// a venue belonging to a different handle.
const unknownRoleSourcePost = makePost({
  username: "unknown.source",
  handle: "unknown.source",
  postId: "unknown-role-source-post",
  instagramPostUrl: "https://www.instagram.com/p/unknown-role-source-post/",
});
const unknownRoleSourceResults = prepareEventsForInsert(
  unknownRoleSourcePost,
  makeExtraction({
    title: "Grounded event",
    date: "30.07.2026",
    venue: "Other Venue",
  }),
  IMAGE_URL,
  {
    "unknown.source": "Configured Venue",
    "other.source": "Other Venue",
  },
  {},
  { "unknown.source": "Configured Venue" },
  {
    eventDateFilterNow: NOW,
    sourceRolesByHandle: { "unknown.source": "unknown" },
  },
);
const unknownRoleSourceEvent = unknownRoleSourceResults.find(
  (result) => result.kind === "ok",
);
assert.ok(
  unknownRoleSourceEvent && unknownRoleSourceEvent.kind === "ok",
  "an exact configured handle must ground an unknown-role source",
);
if (unknownRoleSourceEvent?.kind === "ok") {
  assert.equal(
    unknownRoleSourceEvent.event.venue,
    "Configured Venue",
    "an unknown-role source must use only its own exact canonical venue, never another handle's model venue",
  );
}

// A venue account's exact canonical mapping is shared context for every row
// in one structured schedule. The same mapping is account identity only for a
// promoter, so it must not leak into otherwise venue-less schedule rows.
const canonicalMultiRowCaption = [
  "Opening week schedule",
  "10.09.2026 — ALPHA",
  "11.09.2026 — BETA",
].join("\n");
const canonicalMultiRowPost = makePost({
  caption: canonicalMultiRowCaption,
  username: "multirow.source",
  handle: "multirow.source",
  postId: "canonical-multi-row-post",
  instagramPostUrl: "https://www.instagram.com/p/canonical-multi-row-post/",
});
const canonicalMultiRowExtraction = makeExtraction({
  extraction_contract_version: "event_evidence_v2",
  venue: "",
  category: "live music",
  source_caption: canonicalMultiRowCaption,
  schedule_entries: [
    {
      date: "10.09.2026",
      time: "",
      venue: "",
      title: "ALPHA",
      artists: ["ALPHA"],
      description: "Opening-week concert with ALPHA.",
      source_text: "10.09.2026 — ALPHA",
      date_evidence: {
        exact_text: "10.09.2026",
        source: "poster",
        is_relative: false,
        resolved_date: "2026-09-10",
      },
      time_evidence: {
        status: "not_stated",
        exact_text: "",
        source: "unknown",
      },
    },
    {
      date: "11.09.2026",
      time: "",
      venue: "",
      title: "BETA",
      artists: ["BETA"],
      description: "Opening-week concert with BETA.",
      source_text: "11.09.2026 — BETA",
      date_evidence: {
        exact_text: "11.09.2026",
        source: "poster",
        is_relative: false,
        resolved_date: "2026-09-11",
      },
      time_evidence: {
        status: "not_stated",
        exact_text: "",
        source: "unknown",
      },
    },
  ],
});
assert.ok(
  canonicalMultiRowExtraction.schedule_entries.every((entry) => !entry.venue),
  "the fixture must not repeat the canonical venue in its schedule rows",
);

const canonicalMultiRowMappings = {
  "multirow.source": "Canonical Multirow Venue",
};
const venueRoleMultiRowResults = prepareEventsForInsert(
  canonicalMultiRowPost,
  canonicalMultiRowExtraction,
  IMAGE_URL,
  canonicalMultiRowMappings,
  {},
  canonicalMultiRowMappings,
  {
    eventDateFilterNow: NOW,
    sourceRolesByHandle: { "multirow.source": "venue" },
  },
).filter((result) => result.kind === "ok");
assert.deepEqual(
  venueRoleMultiRowResults.map((result) => [
    result.event.title,
    result.event.date,
    result.event.venue,
  ]),
  [
    ["ALPHA", "2026-09-10", "Canonical Multirow Venue"],
    ["BETA", "2026-09-11", "Canonical Multirow Venue"],
  ],
  "a venue-role source must assign its exact canonical venue to every structured schedule row",
);

const promoterRoleMultiRowResults = prepareEventsForInsert(
  canonicalMultiRowPost,
  canonicalMultiRowExtraction,
  IMAGE_URL,
  canonicalMultiRowMappings,
  {},
  canonicalMultiRowMappings,
  {
    eventDateFilterNow: NOW,
    sourceRolesByHandle: { "multirow.source": "promoter" },
  },
).filter((result) => result.kind === "ok");
assert.deepEqual(
  promoterRoleMultiRowResults.map((result) => [
    result.event.title,
    result.event.date,
    result.event.venue,
  ]),
  [
    ["ALPHA", "2026-09-10", ""],
    ["BETA", "2026-09-11", ""],
  ],
  "an otherwise identical promoter post must not inherit the promoter account as its venue",
);

const mixedDownloadSummary = createEmptyIngestionSummary(["venue"]).handles[0];
let mixedDownloadAttempts = 0;
await withoutConsoleNoise(() =>
  processIngestionPostWithExtractionForTesting({
    client: { query: async () => [], mutation: async () => ({}) },
    handle: "venue",
    post: makePost({
      imageUrl: "https://example.com/expired.jpg",
      imageUrls: [
        "https://example.com/expired.jpg",
        "https://example.com/current.jpg",
      ],
    }),
    summary: mixedDownloadSummary,
    canonicalVenueNamesByHandle: { venue: "Venue" },
    venueNameOverridesByHandle: {},
    configuredVenueNamesByHandle: { venue: "Venue" },
    serviceSecret: "qa-secret",
    extracted: makeExtraction(),
    eventDateFilterNow: NOW,
    dependencies: {
      downloadImage: async (url) => {
        mixedDownloadAttempts += 1;
        if (url.includes("expired")) throw new RemoteMediaHttpError(403, "Forbidden");
        return { imageBuffer: Buffer.from("current"), contentType: "image/jpeg", sourceUrl: url };
      },
      normalizeToJpeg: async (imageBuffer) => ({
        imageBuffer,
        mimeType: "image/jpeg",
        wasConverted: false,
      }),
    },
  }),
);
assert.equal(mixedDownloadAttempts, 2);
assert.equal(mixedDownloadSummary.failedDownloads, 0);
assert.equal(mixedDownloadSummary.permanentMediaDownloadFailures, 0);
assert.equal(mixedDownloadSummary.errors.length, 0);

const mixedPersistenceSummary = createEmptyIngestionSummary(["venue"]).handles[0];
let mixedPersistenceAttempts = 0;
const mixedPersistenceSucceeded = await withoutConsoleNoise(() =>
  persistInstagramMediaCandidates({
    client: {
      action: async () => {
        mixedPersistenceAttempts += 1;
        if (mixedPersistenceAttempts === 1) {
          throw new Error("REMOTE_MEDIA_HTTP_STATUS=403; Remote image fetch failed.");
        }
        return {};
      },
    },
    handle: "venue",
    post: makePost(),
    processingFence: { handle: "venue", postId: "qa-post", owner: "qa", sourceRevision: 1 },
    serviceSecret: "qa-secret",
    summary: mixedPersistenceSummary,
    upstreamUrls: ["https://example.com/expired.jpg", "https://example.com/current.jpg"],
  }),
);
assert.equal(mixedPersistenceSucceeded, true);
assert.equal(mixedPersistenceAttempts, 2);
assert.equal(mixedPersistenceSummary.persistedImages, 1);
assert.equal(mixedPersistenceSummary.failedImagePersistence, 0);
assert.equal(mixedPersistenceSummary.permanentImagePersistenceFailures, 0);
assert.equal(mixedPersistenceSummary.errors.length, 0);

assert.equal(findNamedWeekday("ПОНЕДЕЛЬНИК : 14:00"), 1);
assert.equal(findNamedWeekday("СРЕДА: 19:00"), 3);
assert.equal(findNamedWeekday("ПОНЕДЕЉАК 14:00"), 1);
assert.equal(containsNamedWeekday("ПОНЕДЕЛЬНИК 14:00 / СРЕДА 19:00", 3), true);
assert.deepEqual(findNamedWeekdays("Monday and Wednesday at 14:00"), [1, 3]);

const fromCaption = [
  "🔥 FRØM THURSDAY at @20_44.nightclub",
  "Every Thursday we are gathering and dancing in the garden! Last Thursday was fire, and for this one we prepared nothing less!",
  "📅 Date: July 30",
  "⏰ Time: 21:00 to 03:00",
  "📍 Garden of Club 20/44",
].join("\n");
const fromPost = makePost({
  caption: fromCaption,
  username: "from_sound",
  handle: "20_44.nightclub",
  postId: "3950723823108129557",
  postedAt: "2026-07-27T20:10:01.000Z",
  postType: "sidecar",
});
const fromResults = prepareEventsForInsert(
  fromPost,
  makeExtraction({
    venue: "frǾm",
    category: "nightlife",
    description: "Thursday garden party at 20/44.",
    source_caption: fromCaption,
    schedule_entries: [
      {
        date: "30.07.2026",
        time: "21:00-03:00",
        title: "FRØM THURSDAYS",
        artists: ["Boogie Groove", "Anton Melnik", "Zgonja", "NIKO"],
        description: "Thursday garden party at 20/44 club.",
        source_text:
          "30 JULY GARDEN /// 21:00-03:00 20|44 FRØM THURSDAYS BOOGIE GROOVE ANTON MELNIK ZGONJA NIKO",
      },
    ],
  }),
  IMAGE_URL,
  { from_sound: "frǾm" },
  {},
  { from_sound: "frǾm" },
  { eventDateFilterNow: NOW, sourceRolesByHandle: { from_sound: "promoter" } },
);
assert.equal(fromResults.length, 1, "single-date structured FRØM child must replace helpers");
const boundFromResults = bindSourceOccurrenceMetadata(fromPost, fromResults);
assert.equal(boundFromResults[0]?.normalizedFields.multiEventSplitDetected, false);
assert.equal(boundFromResults[0]?.normalizedFields.multiEventSplitCount, 1);
const fromOccurrenceKey = boundFromResults[0]?.normalizedFields.sourceOccurrenceKey;
assert.equal(
  typeof fromOccurrenceKey,
  "string",
  "the repaired single child still needs a durable occurrence identity",
);
assert.equal(
  fromOccurrenceKey,
  buildSourceOccurrenceKeyForTesting(fromPost, "2026-07-30", "21:00-03:00", {
    multiEventSplitDetected: false,
    multiEventSplitCount: 1,
  }),
  "a single structured row must retain the legacy single-event occurrence namespace",
);

const paraPost = makePost({
  caption: "Male izmene i nova imena u klubu.",
  username: "para_klub",
  handle: "para_klub",
  postId: "3968476210920527048",
  instagramPostUrl: "https://www.instagram.com/p/DcS3BaDgZTI/",
  postedAt: "2026-08-21T08:02:52.000Z",
});
const paraDateEvidence = {
  exact_text: "August 23rd 2026",
  source: "poster",
  is_relative: false,
  resolved_date: "2026-08-23",
};
const paraSlot = (time, title, artists) => ({
  date: "23.08.2026",
  time,
  venue: "Para klub Beograd",
  title,
  artists,
  description: `${title} DJ set.`,
  source_text: `${time.replace("-", " - ")} - ${title}`,
  date_evidence: paraDateEvidence,
  time_evidence: {
    status: "start_time_stated",
    exact_text: time.replace("-", " - "),
    source: "poster",
  },
});
const paraResults = prepareEventsForInsert(
  paraPost,
  makeExtraction({
    extraction_contract_version: "event_evidence_v2",
    title: "",
    date: "",
    time: "",
    venue: "Para klub Beograd",
    artists: [],
    category: "nightlife",
    description: "Three DJ sets featuring Anshi b2b Cvayn, Madji and Vagabond.",
    source_caption: paraPost.caption,
    source_url: paraPost.instagramPostUrl,
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
        applies_to_all: true,
        value: "Para klub Beograd",
        evidence: "para (logo/header) on poster",
        source: "poster",
      },
      time: {
        applies_to_all: true,
        value: "14:00 - 22:00",
        evidence: "August 23rd 2026 14:00 - 22:00",
        source: "poster",
      },
    },
    schedule_entries: [
      paraSlot("14:00-17:00", "Anshi b2b Cvayn", ["Anshi", "Cvayn"]),
      paraSlot("17:00-19:30", "Madji", ["Madji"]),
      paraSlot("19:30-22:00", "Vagabond", ["Vagabond"]),
    ],
  }),
  IMAGE_URL,
  { para_klub: "Para klub Beograd" },
  {},
  { para_klub: "Para klub Beograd" },
  { eventDateFilterNow: NOW, sourceRolesByHandle: { para_klub: "venue" } },
);
const boundParaResults = bindSourceOccurrenceMetadata(paraPost, paraResults);
assert.equal(boundParaResults.length, 1, "one Para timetable must persist as one occurrence");
const boundPara = boundParaResults[0];
assert.equal(boundPara?.kind, "ok");
if (boundPara?.kind === "ok") {
  assert.equal(boundPara.normalizedFields.lineupScheduleCoalesced, true);
  assert.equal(boundPara.normalizedFields.sourceOccurrenceExpectedCount, 1);
  assert.deepEqual(boundPara.normalizedFields.sourceOccurrenceExpectedKeys, [
    "instagram-occurrence-v2:eaf3d009c0b0a02ba0a17b16a94b7cac7dd32b487045cfecbe8adc031c67083d",
  ]);
  assert.equal(
    boundPara.event.sourceOccurrenceKey,
    "instagram-occurrence-v2:eaf3d009c0b0a02ba0a17b16a94b7cac7dd32b487045cfecbe8adc031c67083d",
    "the aggregate must retain the live first-slot occurrence identity",
  );
}
assert.equal(fromResults[0]?.kind, "ok");
if (fromResults[0]?.kind === "ok") {
  assert.deepEqual(
    {
      title: fromResults[0].event.title,
      date: fromResults[0].event.date,
      time: fromResults[0].event.time,
      venue: fromResults[0].event.venue,
      splitSource: fromResults[0].normalizedFields.splitSource,
    },
    {
      title: "FRØM THURSDAYS",
      date: "2026-07-30",
      time: "21:00-03:00",
      venue: "Klub 20/44",
      splitSource: "poster_schedule",
    },
  );
}

const fromPrepared = fromResults[0];
assert.equal(fromPrepared?.kind, "ok");
if (fromPrepared?.kind === "ok") {
  const malformedExistingRows = [
    {
      _id: "rejected-helper",
      title: "📅 Date",
      date: "2026-07-30",
      time: "TBD",
      venue: "frǾm",
      artists: ["📅 Date"],
      status: "rejected",
      normalizedFieldsJson: JSON.stringify({
        multiEventSplitDetected: true,
        multiEventSplitCount: 2,
        splitSourceLine: "📅 Date: July 30",
      }),
    },
    {
      _id: "rejected-narrative",
      title: "Every we are gathering and dancing in the garden",
      date: "2026-07-30",
      time: "TBD",
      venue: "frǾm",
      artists: ["Every we are gathering"],
      status: "rejected",
      normalizedFieldsJson: JSON.stringify({
        multiEventSplitDetected: true,
        multiEventSplitCount: 2,
        splitSourceLine: "Every Thursday we are gathering and dancing in the garden!",
      }),
    },
  ].map((existingEvent) => ({ existingEvent, matchedBy: "post_id" }));
  assert.equal(
    findBestExistingMatchForPreparedEventForTesting(
      malformedExistingRows,
      fromPrepared.event,
      fromPrepared.normalizedFields,
    ),
    null,
    "the genuine FRØM child must not repurpose either rejected malformed row",
  );
}

// A collision ordinal is not semantic provenance. This is the production
// shape that previously allowed a Chillout extraction snapshot to satisfy the
// Bodies Hit The Floor child merely because both carried the same key.
const occupiedBodiesKey = `instagram-occurrence-v2:${"b".repeat(64)}`;
const bodiesExpectedOccurrence = {
  key: occupiedBodiesKey,
  date: "2026-09-26",
  time: "TBD",
  venue: "Vrtoglavica",
  title: "Bodies Hit The Floor",
  artists: ["DJ Hellspawn", "DJ Kedlavi", "DJ Sirivs"],
};
const sharedVrtoglavicaContext = [
  "Bodies Hit The Floor — DJ Hellspawn, DJ Kedlavi, DJ Sirivs",
  "Chillout Zone",
  "INFECTED",
].join("\n");
const wrongBodiesRepresentative = {
  _id: "qa-vrtoglavica-wrong-bodies-representative",
  title: "Chillout Zone",
  date: "2026-09-26",
  time: "TBD",
  venue: "Vrtoglavica",
  artists: [],
  eventType: "music",
  sourceCaption: sharedVrtoglavicaContext,
  instagramPostId: "qa-vrtoglavica-post",
  instagramPostUrl: "https://www.instagram.com/p/qa-vrtoglavica-post/",
  sourceOccurrenceKey: occupiedBodiesKey,
  status: "approved",
  updatedAt: 1,
  normalizedFieldsJson: JSON.stringify({
    sourceOccurrenceKey: occupiedBodiesKey,
    sourceOccurrenceSourceFingerprint: "instagram-source-v2:old-vrtoglavica",
    sourceOccurrenceAmbiguousProvenance: true,
    title: "Chillout Zone",
    normalizedDate: "2026-09-26",
    time: "TBD",
    normalizedVenue: "Vrtoglavica",
    artists: [],
    sourceCaptionFromModel: sharedVrtoglavicaContext,
  }),
};
assert.equal(
  eventRepresentsExpectedOccurrenceForTesting(
    wrongBodiesRepresentative,
    bodiesExpectedOccurrence,
  ),
  false,
  "a same-key representative with a different immutable extraction snapshot must fail closed",
);
assert.equal(
  eventRepresentsExpectedOccurrenceForTesting(
    {
      ...wrongBodiesRepresentative,
      normalizedFieldsJson: JSON.stringify({
        sourceOccurrenceKey: occupiedBodiesKey,
        sourceOccurrenceSourceFingerprint: "instagram-source-v2:single-old",
        title: "Chillout Zone",
        normalizedDate: "2026-09-26",
        time: "TBD",
        normalizedVenue: "Vrtoglavica",
        artists: [],
      }),
    },
    bodiesExpectedOccurrence,
  ),
  false,
  "a non-ambiguous same key still cannot replace semantic representative evidence",
);
assert.equal(
  eventRepresentsExpectedOccurrenceForTesting(
    {
      ...wrongBodiesRepresentative,
      title: "Moderator-corrected public title",
      time: "21:30",
      venue: "Moderator-corrected venue",
      artists: ["Moderator-corrected artist"],
      normalizedFieldsJson: JSON.stringify({
        sourceOccurrenceKey: occupiedBodiesKey,
        sourceOccurrenceSourceFingerprint: "instagram-source-v2:bodies",
        sourceOccurrenceAmbiguousProvenance: true,
        title: bodiesExpectedOccurrence.title,
        normalizedDate: bodiesExpectedOccurrence.date,
        time: bodiesExpectedOccurrence.time,
        normalizedVenue: bodiesExpectedOccurrence.venue,
        artists: bodiesExpectedOccurrence.artists,
      }),
    },
    bodiesExpectedOccurrence,
  ),
  true,
  "moderator edits must remain represented when the immutable extraction snapshot still matches",
);
assert.equal(
  findBestExistingMatchForPreparedEventForTesting(
    [
      {
        existingEvent: wrongBodiesRepresentative,
        matchedBy: "same_date_semantic",
        matchedValue: bodiesExpectedOccurrence.date,
      },
    ],
    {
      title: bodiesExpectedOccurrence.title,
      date: bodiesExpectedOccurrence.date,
      time: bodiesExpectedOccurrence.time,
      timeSource: "unknown",
      timeConfidence: 0,
      timeStatus: "unknown",
      venue: bodiesExpectedOccurrence.venue,
      artists: bodiesExpectedOccurrence.artists,
      eventType: "music",
      sourceCaption: sharedVrtoglavicaContext,
      instagramPostId: "qa-next-vrtoglavica-post",
      instagramPostUrl: "https://www.instagram.com/p/qa-next-vrtoglavica-post/",
      sourceOccurrenceKey: occupiedBodiesKey,
      status: "pending",
    },
    {
      sourceOccurrenceKey: occupiedBodiesKey,
      title: bodiesExpectedOccurrence.title,
      normalizedDate: bodiesExpectedOccurrence.date,
      time: bodiesExpectedOccurrence.time,
      normalizedVenue: bodiesExpectedOccurrence.venue,
      artists: bodiesExpectedOccurrence.artists,
      sourceCaptionFromModel: sharedVrtoglavicaContext,
    },
  ),
  null,
  "a fuzzy duplicate candidate that Convex cannot accept must never be selected for occurrence satisfaction",
);

const commonCaption = [
  "Разговорный клуб итальянского языка в COMMON",
  "Понедельник — 14:00",
  "Среда — 19:00",
  "Ponedeljak — 14:00",
  "Sreda — 19:00",
].join("\n");
const commonPost = makePost({
  caption: commonCaption,
  username: "common.belgrade",
  handle: "common.belgrade",
  postId: "3951307652074938678",
  postedAt: "2026-07-28T15:30:10.000Z",
});
const commonExtraction = makeExtraction({
  venue: "COMMON",
  category: "learning",
  artists: ["Alberto"],
  description:
    "Weekly Italian conversation club starting from 03.08.26, every Monday at 14:00 and Wednesday at 19:00.",
  source_caption: commonCaption,
  schedule_entries: [
    {
      date: "03.08.2026",
      time: "14:00",
      title: "Итальянский разговорный клуб",
      artists: ["Alberto"],
      description: "Weekly Italian language conversation club",
      source_text: "ЕЖЕНЕДЕЛЬНО С 03.08.26\nПОНЕДЕЛЬНИК : 14:00",
    },
    {
      date: "03.08.2026",
      time: "19:00",
      title: "Итальянский разговорный клуб",
      artists: ["Alberto"],
      description: "Weekly Italian language conversation club",
      source_text: "СРЕДА: 19:00",
    },
  ],
});
const commonResults = prepareEventsForInsert(
  commonPost,
  commonExtraction,
  IMAGE_URL,
  { "common.belgrade": "COMMON | Белград | Мероприятия" },
  {},
  { "common.belgrade": "COMMON | Белград | Мероприятия" },
  { eventDateFilterNow: NOW, sourceRolesByHandle: { "common.belgrade": "venue" } },
);
const commonOk = commonResults.filter((result) => result.kind === "ok");
const commonDeferred = commonResults.filter(
  (result) => result.kind === "skip" && result.reason === "far_future",
);
assert.equal(commonResults.length, 26, "weekly plan should preserve every bounded occurrence");
assert.equal(commonOk.length, 25);
assert.equal(commonDeferred.length, 1, "bounded far-future child must remain deferred");
const boundCommonResults = bindSourceOccurrenceMetadata(commonPost, commonResults);
assert.ok(
  boundCommonResults.every(
    (result) => result.normalizedFields.sourceOccurrencePlanUnverified === true,
  ),
  "model-only recurrence plans must remain explicitly unverified",
);
const firstBoundCommon = boundCommonResults.find((result) => result.kind === "ok");
assert.ok(firstBoundCommon && firstBoundCommon.kind === "ok");
if (firstBoundCommon?.kind === "ok") {
  const expectedOccurrence = {
    key: firstBoundCommon.normalizedFields.sourceOccurrenceKey,
    date: firstBoundCommon.event.date,
    time: firstBoundCommon.event.time,
    venue: firstBoundCommon.event.venue,
    title: firstBoundCommon.event.title,
    artists: firstBoundCommon.event.artists,
  };
  assert.equal(
    eventRepresentsExpectedOccurrenceForTesting(
      firstBoundCommon.event,
      expectedOccurrence,
    ),
    false,
    "an unapproved model-only recurrence must not satisfy its source receipt",
  );
  assert.equal(
    eventRepresentsExpectedOccurrenceForTesting(
      firstBoundCommon.event,
      expectedOccurrence,
      { allowUnverifiedPending: true },
    ),
    true,
    "atomic persistence may bind the pending candidate while receipt reads remain incomplete",
  );
  assert.equal(
    eventRepresentsExpectedOccurrenceForTesting(
      { ...firstBoundCommon.event, status: "approved" },
      expectedOccurrence,
    ),
    true,
    "human approval may make the reviewed recurrence authoritative",
  );
  const groundedNormalizedFields = {
    ...firstBoundCommon.normalizedFields,
    sourceOccurrencePlanUnverified: false,
  };
  assert.equal(
    eventRepresentsExpectedOccurrenceForTesting(
      {
        ...firstBoundCommon.event,
        normalizedFieldsJson: JSON.stringify(groundedNormalizedFields),
      },
      expectedOccurrence,
    ),
    true,
    "a source-grounded pending occurrence remains a valid persisted representative",
  );
}

const persistenceSummary = createEmptyIngestionSummary(["common.belgrade"]).handles[0];
const persistedCommonEvents = [];
const persistenceUpdates = [];
await withoutConsoleNoise(() =>
  processIngestionPostWithExtractionForTesting({
    client: {
      query: async () => [],
      mutation: async (_reference, args) => {
        if ("representativeEventId" in args) return { recorded: true };
        if ("id" in args) {
          persistenceUpdates.push(args);
          return args.id;
        }
        persistedCommonEvents.push(args);
        return {
          eventId: `qa-common-occurrence-${persistedCommonEvents.length}`,
          created: true,
          updatedAt: persistedCommonEvents.length,
        };
      },
    },
    handle: "common.belgrade",
    post: { ...commonPost, postType: "video" },
    summary: persistenceSummary,
    canonicalVenueNamesByHandle: { "common.belgrade": "COMMON | Белград | Мероприятия" },
    venueNameOverridesByHandle: {},
    configuredVenueNamesByHandle: { "common.belgrade": "COMMON | Белград | Мероприятия" },
    serviceSecret: "qa",
    eventDateFilterNow: NOW,
    extracted: commonExtraction,
  }),
);
assert.equal(
  persistedCommonEvents.length,
  25,
  "the real persistence loop must create every currently eligible recurring child",
);
assert.equal(persistenceUpdates.length, 0, "a later recurring child must not overwrite a sibling");
assert.equal(
  new Set(persistedCommonEvents.map((event) => event.sourceOccurrenceKey)).size,
  25,
  "every persisted recurring child needs a distinct occurrence key",
);
assert.ok(
  persistedCommonEvents.every(
    (event) => JSON.parse(event.normalizedFieldsJson).sourceOccurrencePlanUnverified === true,
  ),
  "the persistence loop must preserve the fail-closed model-only recurrence marker",
);
assert.equal(persistenceSummary.insertedEvents, 25);

const commonOccurrenceKeys = boundCommonResults.map(
  (result) => result.normalizedFields.sourceOccurrenceKey,
);
assert.equal(new Set(commonOccurrenceKeys).size, 26, "every recurrence needs a unique key");
assert.ok(commonOccurrenceKeys.every((key) => typeof key === "string" && key.length > 0));
assert.ok(
  boundCommonResults
    .filter((result) => result.kind === "ok")
    .every(
      (result) => result.normalizedFields.sourceOccurrenceDeferredChildCount === 1,
    ),
  "the exact receipt plan must retain the one deferred child",
);
assert.deepEqual(
  commonOk.slice(0, 4).map((result) =>
    result.kind === "ok" ? [result.event.date, result.event.time] : null,
  ),
  [
    ["2026-08-03", "14:00"],
    ["2026-08-05", "19:00"],
    ["2026-08-10", "14:00"],
    ["2026-08-12", "19:00"],
  ],
);
assert.ok(
  commonResults.every(
    (result) =>
      (result.kind === "ok" ? result.event.date : result.normalizedFields.normalizedDate) !==
      "2026-07-29",
  ),
  "a recurring schedule must not invent a pre-start Wednesday",
);
assert.equal(
  commonDeferred[0]?.normalizedFields.normalizedDate,
  "2026-10-28",
);

const modelDriftExtraction = {
  ...commonExtraction,
  schedule_entries: commonExtraction.schedule_entries.map((entry, index) => ({
    ...entry,
    date: "10.08.2026",
    source_text:
      index === 0
        ? "ЕЖЕНЕДЕЛЬНО С 10.08.26\nПОНЕДЕЛЬНИК : 14:00"
        : entry.source_text,
  })),
};
const modelDriftResults = prepareEventsForInsert(
  commonPost,
  modelDriftExtraction,
  IMAGE_URL,
  { "common.belgrade": "COMMON | Белград | Мероприятия" },
  {},
  { "common.belgrade": "COMMON | Белград | Мероприятия" },
  { eventDateFilterNow: NOW, sourceRolesByHandle: { "common.belgrade": "venue" } },
);
assert.equal(
  modelDriftResults.find((result) => result.kind === "ok")?.event.date,
  "2026-08-10",
  "the fixture must prove that changing only model output can change the proposed schedule",
);
assert.ok(
  modelDriftResults.every(
    (result) => result.normalizedFields.sourceOccurrencePlanUnverified === true,
  ),
  "a model-shifted schedule under unchanged source evidence must remain fail-closed",
);

const boundaryExtraction = {
  ...commonExtraction,
  schedule_entries: commonExtraction.schedule_entries.map((entry, index) => ({
    ...entry,
    date: "01.08.2026",
    source_text:
      index === 0
        ? "ЕЖЕНЕДЕЛЬНО С 01.08.26\nПОНЕДЕЛЬНИК : 14:00"
        : entry.source_text,
  })),
};
const boundaryResults = prepareEventsForInsert(
  commonPost,
  boundaryExtraction,
  IMAGE_URL,
  { "common.belgrade": "COMMON | Белград | Мероприятия" },
  {},
  { "common.belgrade": "COMMON | Белград | Мероприятия" },
  { eventDateFilterNow: NOW, sourceRolesByHandle: { "common.belgrade": "venue" } },
);
assert.deepEqual(
  boundaryResults
    .filter((result) => result.kind === "ok")
    .slice(0, 2)
    .map((result) => [result.event.date, result.event.time]),
  [
    ["2026-08-03", "14:00"],
    ["2026-08-05", "19:00"],
  ],
  "a recurrence boundary may precede the first scheduled weekday",
);
assert.ok(
  boundaryResults.every(
    (result) =>
      (result.kind === "ok" ? result.event.date : result.normalizedFields.normalizedDate) !==
      "2026-08-01",
  ),
  "the recurrence boundary itself must not become an event without a matching lane",
);

const groundedCommonPost = {
  ...commonPost,
  caption: `${commonCaption}\nWeekly from 01.08.26: Monday 14:00, Wednesday 19:00`,
};
const groundedCommonResults = prepareEventsForInsert(
  groundedCommonPost,
  boundaryExtraction,
  IMAGE_URL,
  { "common.belgrade": "COMMON | Белград | Мероприятия" },
  {},
  { "common.belgrade": "COMMON | Белград | Мероприятия" },
  { eventDateFilterNow: NOW, sourceRolesByHandle: { "common.belgrade": "venue" } },
);
assert.ok(
  groundedCommonResults.every(
    (result) => result.normalizedFields.sourceOccurrencePlanUnverified === false,
  ),
  "an exact captured recurrence start and coherent weekday/time lanes should ground the plan",
);
assert.deepEqual(
  groundedCommonResults
    .filter((result) => result.kind === "ok")
    .slice(0, 2)
    .map((result) => [result.event.date, result.event.time]),
  [
    ["2026-08-03", "14:00"],
    ["2026-08-05", "19:00"],
  ],
  "a grounded non-lane boundary must start expansion without becoming an event",
);
assert.ok(
  groundedCommonResults.every(
    (result) =>
      (result.kind === "ok" ? result.event.date : result.normalizedFields.normalizedDate) !==
      "2026-08-01",
  ),
  "grounding must not reinterpret the recurrence start boundary as an occurrence",
);

for (const recurrenceMarker of [
  "Weekly: from 01.08.26",
  "Weekly starting on 01.08.26",
  "Weekly; from 01.08.26",
  "Weekly, starting on 01.08.26",
  "Weekly starting 01.08.26",
  "Every week — from 01.08.26",
  "Nedeljno: od 01.08.26",
  "Weekly from: 01.08.26",
  "Weekly starting on: 01.08.26",
  "Nedeljno od: 01.08.26",
  "Weekly:\nfrom 01.08.26",
]) {
  const syntaxPost = {
    ...commonPost,
    caption: `${commonCaption}\n${recurrenceMarker}: Monday 14:00, Wednesday 19:00`,
  };
  const syntaxExtraction = {
    ...boundaryExtraction,
    schedule_entries: boundaryExtraction.schedule_entries.map((entry, index) => ({
      ...entry,
      source_text:
        index === 0
          ? `${recurrenceMarker}\nMONDAY 14:00`
          : "WEDNESDAY 19:00",
    })),
  };
  const syntaxResults = prepareEventsForInsert(
    syntaxPost,
    syntaxExtraction,
    IMAGE_URL,
    { "common.belgrade": "COMMON | Белград | Мероприятия" },
    {},
    { "common.belgrade": "COMMON | Белград | Мероприятия" },
    { eventDateFilterNow: NOW, sourceRolesByHandle: { "common.belgrade": "venue" } },
  );
  assert.equal(syntaxResults.length, 26, `${recurrenceMarker} must preserve the bounded plan`);
  assert.ok(
    syntaxResults.every(
      (result) => result.normalizedFields.sourceOccurrencePlanUnverified === false,
    ),
    `${recurrenceMarker} must use coherent source lanes rather than bypass recurrence checks`,
  );
  assert.ok(
    syntaxResults.every(
      (result) =>
        (result.kind === "ok" ? result.event.date : result.normalizedFields.normalizedDate) !==
        "2026-08-01",
    ),
    `${recurrenceMarker} must not fabricate the recurrence boundary as an event`,
  );

  if (recurrenceMarker.startsWith("Weekly:")) {
    const syntaxPersistenceSummary = createEmptyIngestionSummary(["common.belgrade"]).handles[0];
    const persistedSyntaxEvents = [];
    await withoutConsoleNoise(() =>
      processIngestionPostWithExtractionForTesting({
        client: {
          query: async () => [],
          mutation: async (_reference, args) => {
            if ("representativeEventId" in args) return { recorded: true };
            if ("id" in args) return { updatedAt: 1000 };
            persistedSyntaxEvents.push(args);
            return {
              eventId: `qa-recurring-syntax-${persistedSyntaxEvents.length}`,
              created: true,
              updatedAt: persistedSyntaxEvents.length,
            };
          },
        },
        handle: "common.belgrade",
        post: { ...syntaxPost, postType: "video" },
        summary: syntaxPersistenceSummary,
        canonicalVenueNamesByHandle: {
          "common.belgrade": "COMMON | Белград | Мероприятия",
        },
        venueNameOverridesByHandle: {},
        configuredVenueNamesByHandle: {
          "common.belgrade": "COMMON | Белград | Мероприятия",
        },
        serviceSecret: "qa",
        eventDateFilterNow: NOW,
        extracted: syntaxExtraction,
      }),
    );
    assert.equal(persistedSyntaxEvents.length, 25);
    assert.equal(syntaxPersistenceSummary.insertedEvents, 25);
    assert.ok(
      persistedSyntaxEvents.every((event) => event.date !== "2026-08-01"),
      "real persistence must not insert the colon-form recurrence boundary",
    );
    assert.ok(
      persistedSyntaxEvents.every(
        (event) =>
          event.sourceOccurrencePlan.expectedKeys.length === 25 &&
          event.sourceOccurrencePlan.deferredChildCount === 1 &&
          event.sourceOccurrencePlan.deferredChildKeys.length === 1,
      ),
      "real persistence must retain every current child plus the bounded deferred child",
    );
  }
}

const midweekBoundaryCaption = [
  "Italian conversation club",
  "Weekly",
  "from: 29.07.26",
  "Monday 14:00",
  "Friday 19:00",
].join("\n");
const midweekBoundaryPost = {
  ...commonPost,
  caption: midweekBoundaryCaption,
  postId: "qa-midweek-boundary",
  shortcode: "qa-midweek-boundary",
  instagramPostUrl: "https://www.instagram.com/p/qa-midweek-boundary/",
};
const midweekBoundaryExtraction = makeExtraction({
  venue: "COMMON",
  category: "learning",
  artists: ["Alberto"],
  description: "Weekly Italian conversation club.",
  source_caption: midweekBoundaryCaption,
  schedule_entries: [
    {
      date: "29.07.2026",
      time: "14:00",
      title: "Italian conversation club",
      artists: ["Alberto"],
      description: "Weekly Italian conversation club.",
      source_text: "WEEKLY\nFROM: 29.07.26\nMONDAY 14:00",
    },
    {
      date: "29.07.2026",
      time: "19:00",
      title: "Italian conversation club",
      artists: ["Alberto"],
      description: "Weekly Italian conversation club.",
      source_text: "FRIDAY 19:00",
    },
  ],
});
const midweekBoundaryResults = prepareEventsForInsert(
  midweekBoundaryPost,
  midweekBoundaryExtraction,
  IMAGE_URL,
  { "common.belgrade": "COMMON | Белград | Мероприятия" },
  {},
  { "common.belgrade": "COMMON | Белград | Мероприятия" },
  { eventDateFilterNow: NOW, sourceRolesByHandle: { "common.belgrade": "venue" } },
);
const midweekBoundaryOk = midweekBoundaryResults.filter((result) => result.kind === "ok");
assert.equal(midweekBoundaryResults.length, 26);
assert.equal(midweekBoundaryOk.length, 26);
assert.ok(
  midweekBoundaryOk.every((result) => result.event.date !== "2026-07-29"),
  "a Wednesday recurrence boundary must never become an occurrence",
);
assert.equal(
  midweekBoundaryOk.filter((result) =>
    result.event.date.endsWith("-08-03") ||
    new Date(`${result.event.date}T00:00:00Z`).getUTCDay() === 1,
  ).length,
  13,
  "every Monday lane must survive generated-date normalization",
);
assert.equal(
  midweekBoundaryOk.filter(
    (result) => new Date(`${result.event.date}T00:00:00Z`).getUTCDay() === 5,
  ).length,
  13,
  "every Friday lane must survive generated-date normalization",
);
const midweekPersistenceSummary = createEmptyIngestionSummary(["common.belgrade"]).handles[0];
const persistedMidweekEvents = [];
await withoutConsoleNoise(() =>
  processIngestionPostWithExtractionForTesting({
    client: {
      query: async () => [],
      mutation: async (_reference, args) => {
        if ("representativeEventId" in args) return { recorded: true };
        if ("id" in args) return { updatedAt: 1000 };
        persistedMidweekEvents.push(args);
        return {
          eventId: `qa-midweek-boundary-${persistedMidweekEvents.length}`,
          created: true,
          updatedAt: persistedMidweekEvents.length,
        };
      },
    },
    handle: "common.belgrade",
    post: { ...midweekBoundaryPost, postType: "video" },
    summary: midweekPersistenceSummary,
    canonicalVenueNamesByHandle: {
      "common.belgrade": "COMMON | Белград | Мероприятия",
    },
    venueNameOverridesByHandle: {},
    configuredVenueNamesByHandle: {
      "common.belgrade": "COMMON | Белград | Мероприятия",
    },
    serviceSecret: "qa",
    eventDateFilterNow: NOW,
    extracted: midweekBoundaryExtraction,
  }),
);
assert.equal(midweekPersistenceSummary.insertedEvents, 26);
assert.equal(persistedMidweekEvents.length, 26);
assert.ok(persistedMidweekEvents.every((event) => event.date !== "2026-07-29"));
assert.ok(
  persistedMidweekEvents.every(
    (event) =>
      event.sourceOccurrencePlan.expectedKeys.length === 26 &&
      event.sourceOccurrencePlan.deferredChildCount === 0,
  ),
  "the real persistence plan must retain both complete lanes without a boundary child",
);

for (const suspiciousRecurrenceMarker of [
  "Weekly schedule begins around 01.08.26",
  "Weekly :::: from 01.08.26",
  "Weekly occurs beginning the week of 01.08.26",
]) {
  const suspiciousPost = {
    ...commonPost,
    caption: `${commonCaption}\n${suspiciousRecurrenceMarker}: Monday 14:00, Wednesday 19:00`,
  };
  const suspiciousExtraction = {
    ...boundaryExtraction,
    schedule_entries: boundaryExtraction.schedule_entries.map((entry, index) => ({
      ...entry,
      source_text:
        index === 0
          ? suspiciousRecurrenceMarker.includes("schedule begins")
            ? "WEEKLY FROM 01.08.26\nMONDAY 14:00"
            : `${suspiciousRecurrenceMarker}\nMONDAY 14:00`
          : "WEDNESDAY 19:00",
    })),
  };
  const suspiciousResults = prepareEventsForInsert(
    suspiciousPost,
    suspiciousExtraction,
    IMAGE_URL,
    { "common.belgrade": "COMMON | Белград | Мероприятия" },
    {},
    { "common.belgrade": "COMMON | Белград | Мероприятия" },
    { eventDateFilterNow: NOW, sourceRolesByHandle: { "common.belgrade": "venue" } },
  );
  assert.ok(
    suspiciousResults.every((result) => result.kind !== "ok"),
    `${suspiciousRecurrenceMarker} must fail closed rather than fabricate events`,
  );
  assert.ok(
    suspiciousResults.every(
      (result) => result.normalizedFields.rejectedRecurringModelSchedule === true,
    ),
    `${suspiciousRecurrenceMarker} must remain auditable as a rejected recurrence`,
  );

  if (suspiciousRecurrenceMarker.includes("schedule begins")) {
    const suspiciousSummary = createEmptyIngestionSummary(["common.belgrade"]).handles[0];
    let suspiciousMutationCalls = 0;
    await withoutConsoleNoise(() =>
      processIngestionPostWithExtractionForTesting({
        client: {
          query: async () => [],
          mutation: async () => {
            suspiciousMutationCalls += 1;
            return "unexpected-recurrence-suspicion-mutation";
          },
        },
        handle: "common.belgrade",
        post: { ...suspiciousPost, postType: "video" },
        summary: suspiciousSummary,
        canonicalVenueNamesByHandle: {
          "common.belgrade": "COMMON | Белград | Мероприятия",
        },
        venueNameOverridesByHandle: {},
        configuredVenueNamesByHandle: {
          "common.belgrade": "COMMON | Белград | Мероприятия",
        },
        serviceSecret: "qa",
        eventDateFilterNow: NOW,
        extracted: suspiciousExtraction,
      }),
    );
    assert.equal(suspiciousSummary.insertedEvents, 0);
    assert.equal(suspiciousSummary.failedExtractions, 1);
    assert.equal(suspiciousMutationCalls, 0);
    assert.ok(
      suspiciousSummary.errors.some((error) =>
        error.includes("Recurring schedule rejected because model lanes"),
      ),
      "unrecognized recurrence grammar must stay retryable and never complete an empty receipt",
    );
  }
}

const swappedLaneExtraction = {
  ...boundaryExtraction,
  schedule_entries: boundaryExtraction.schedule_entries.map((entry, index) => ({
    ...entry,
    time: index === 0 ? "19:00" : "14:00",
    source_text:
      index === 0
        ? "ЕЖЕНЕДЕЛЬНО С 01.08.26\nПОНЕДЕЛЬНИК : 19:00"
        : "СРЕДА: 14:00",
  })),
};
const swappedLaneResults = prepareEventsForInsert(
  groundedCommonPost,
  swappedLaneExtraction,
  IMAGE_URL,
  { "common.belgrade": "COMMON | Белград | Мероприятия" },
  {},
  { "common.belgrade": "COMMON | Белград | Мероприятия" },
  { eventDateFilterNow: NOW, sourceRolesByHandle: { "common.belgrade": "venue" } },
);
assert.ok(swappedLaneResults.length > 0, "the model lane-swap fixture must emit review candidates");
assert.ok(
  swappedLaneResults.every(
    (result) => result.normalizedFields.sourceOccurrencePlanUnverified === true,
  ),
  "weekday/time tokens found elsewhere in the caption must not authorize swapped lane pairs",
);
assert.ok(
  swappedLaneResults.every(
    (result) =>
      (result.kind === "ok" ? result.event.date : result.normalizedFields.normalizedDate) !==
      "2026-08-01",
  ),
  "a swapped-lane proposal must not revive the non-event recurrence boundary",
);
const firstSwappedLane = bindSourceOccurrenceMetadata(groundedCommonPost, swappedLaneResults).find(
  (result) => result.kind === "ok",
);
assert.ok(firstSwappedLane && firstSwappedLane.kind === "ok");
if (firstSwappedLane?.kind === "ok") {
  assert.equal(
    eventRepresentsExpectedOccurrenceForTesting(firstSwappedLane.event, {
      key: firstSwappedLane.normalizedFields.sourceOccurrenceKey,
      date: firstSwappedLane.event.date,
      time: firstSwappedLane.event.time,
      venue: firstSwappedLane.event.venue,
      title: firstSwappedLane.event.title,
      artists: firstSwappedLane.event.artists,
    }),
    false,
    "a pending swapped-lane candidate must not satisfy a receipt",
  );
}

const missingLanePost = {
  ...groundedCommonPost,
  caption: `${groundedCommonPost.caption}\nFriday 20:00`,
};
const missingLaneResults = prepareEventsForInsert(
  missingLanePost,
  boundaryExtraction,
  IMAGE_URL,
  { "common.belgrade": "COMMON | Белград | Мероприятия" },
  {},
  { "common.belgrade": "COMMON | Белград | Мероприятия" },
  { eventDateFilterNow: NOW, sourceRolesByHandle: { "common.belgrade": "venue" } },
);
assert.equal(
  missingLaneResults.filter((result) => result.kind === "ok").length,
  0,
  "a model plan that omits a coherent preserved-source lane must be rejected",
);
assert.ok(
  missingLaneResults.every(
    (result) => result.normalizedFields.rejectedRecurringModelSchedule === true,
  ),
  "a source-lane omission must remain auditable instead of disappearing from the receipt plan",
);
const rejectedCoverageSummary = createEmptyIngestionSummary(["common.belgrade"]).handles[0];
let rejectedCoverageMutationCount = 0;
await withoutConsoleNoise(() =>
  processIngestionPostWithExtractionForTesting({
    client: {
      query: async () => [],
      mutation: async () => {
        rejectedCoverageMutationCount += 1;
        return null;
      },
    },
    handle: "common.belgrade",
    post: {
      ...missingLanePost,
      postType: "video",
      imageUrl: null,
      imageUrls: [],
    },
    summary: rejectedCoverageSummary,
    canonicalVenueNamesByHandle: { "common.belgrade": "COMMON | Белград | Мероприятия" },
    venueNameOverridesByHandle: {},
    configuredVenueNamesByHandle: { "common.belgrade": "COMMON | Белград | Мероприятия" },
    serviceSecret: "qa",
    eventDateFilterNow: NOW,
    extracted: boundaryExtraction,
  }),
);
assert.equal(rejectedCoverageSummary.insertedEvents, 0);
assert.equal(rejectedCoverageSummary.failedExtractions, 1);
assert.equal(rejectedCoverageSummary.failed_extraction, 1);
assert.equal(
  rejectedCoverageMutationCount,
  0,
  "a rejected lane-coverage plan must not reconcile an empty receipt or write events",
);
assert.match(rejectedCoverageSummary.errors[0] ?? "", /Recurring schedule rejected/u);

const ambiguousLanePost = {
  ...commonPost,
  caption: "Weekly from 01.08.26: Monday and Wednesday at 14:00",
};
const ambiguousLaneExtraction = makeExtraction({
  venue: "COMMON",
  category: "learning",
  schedule_entries: [
    {
      date: "01.08.2026",
      time: "14:00",
      title: "Language club",
      artists: [],
      description: "Weekly language club",
      source_text: "WEEKLY FROM 01.08.26\nMONDAY AND WEDNESDAY 14:00",
    },
  ],
});
const ambiguousLaneResults = prepareEventsForInsert(
  ambiguousLanePost,
  ambiguousLaneExtraction,
  IMAGE_URL,
  { "common.belgrade": "COMMON | Белград | Мероприятия" },
  {},
  { "common.belgrade": "COMMON | Белград | Мероприятия" },
  { eventDateFilterNow: NOW, sourceRolesByHandle: { "common.belgrade": "venue" } },
);
assert.equal(
  ambiguousLaneResults.filter((result) => result.kind === "ok").length,
  0,
  "an ambiguous multi-weekday recurrence must not persist a model-selected first weekday",
);
assert.ok(
  ambiguousLaneResults.every(
    (result) => result.normalizedFields.rejectedRecurringModelSchedule === true,
  ),
);
const ambiguousLaneDates = ambiguousLaneResults.map((result) =>
  result.kind === "ok" ? [result.event.date, result.event.time, result.event.title] : [result.kind, result.normalizedFields.normalizedDate],
);
assert.ok(
  ambiguousLaneDates.every(([date]) => date !== "2026-08-01"),
  `an ambiguous multi-weekday lane must be rejected rather than fabricating its boundary: ${JSON.stringify(ambiguousLaneDates)}`,
);

const swappedPersistenceSummary = createEmptyIngestionSummary(["common.belgrade"]).handles[0];
const persistedSwappedLaneEvents = [];
await withoutConsoleNoise(() =>
  processIngestionPostWithExtractionForTesting({
    client: {
      query: async () => [],
      mutation: async (_reference, args) => {
        if ("representativeEventId" in args) return { recorded: true };
        if ("id" in args) return { updatedAt: 1000 };
        persistedSwappedLaneEvents.push(args);
        return {
          eventId: `qa-swapped-lane-${persistedSwappedLaneEvents.length}`,
          created: true,
          updatedAt: persistedSwappedLaneEvents.length,
        };
      },
    },
    handle: "common.belgrade",
    post: { ...groundedCommonPost, postType: "video" },
    summary: swappedPersistenceSummary,
    canonicalVenueNamesByHandle: { "common.belgrade": "COMMON | Белград | Мероприятия" },
    venueNameOverridesByHandle: {},
    configuredVenueNamesByHandle: { "common.belgrade": "COMMON | Белград | Мероприятия" },
    serviceSecret: "qa",
    eventDateFilterNow: NOW,
    extracted: swappedLaneExtraction,
  }),
);
assert.ok(persistedSwappedLaneEvents.length > 0);
assert.ok(
  persistedSwappedLaneEvents.every(
    (event) => JSON.parse(event.normalizedFieldsJson).sourceOccurrencePlanUnverified === true,
  ),
  "the real persistence loop must preserve the swapped-lane unverified marker",
);

const persistedSwappedLane = persistedSwappedLaneEvents[0];
const persistedSwappedExpected = persistedSwappedLane.sourceOccurrencePlan.expectedOccurrences.find(
  (item) => item.key === persistedSwappedLane.sourceOccurrenceKey,
);
assert.ok(persistedSwappedExpected);
const persistedSwappedEventId = "qa-swapped-lane-event";
const persistedSwappedReceipt = {
  _id: "qa-swapped-lane-receipt",
  sourceIdentity: persistedSwappedLane.sourceOccurrencePlan.sourceIdentity,
  sourceFingerprint: persistedSwappedLane.sourceOccurrencePlan.sourceFingerprint,
  expectedKeys: persistedSwappedLane.sourceOccurrencePlan.expectedKeys,
  expectedOccurrences: persistedSwappedLane.sourceOccurrencePlan.expectedOccurrences,
  deferredChildCount: persistedSwappedLane.sourceOccurrencePlan.deferredChildCount,
  deferredChildKeys: persistedSwappedLane.sourceOccurrencePlan.deferredChildKeys,
  satisfiedKeys: [persistedSwappedLane.sourceOccurrenceKey],
  satisfiedOccurrences: [
    {
      key: persistedSwappedLane.sourceOccurrenceKey,
      eventId: persistedSwappedEventId,
    },
  ],
};
const previousCronSecret = process.env.CRON_SECRET;
process.env.CRON_SECRET = "qa-receipt-secret";
try {
  const liveSwappedReceipt = await getInstagramSourceOccurrenceReceipt._handler(
    {
      auth: { getUserIdentity: async () => null },
      db: {
        get: async (id) =>
          id === persistedSwappedEventId
            ? {
                _id: persistedSwappedEventId,
                ...persistedSwappedLane,
                status: "pending",
              }
            : null,
        query: (table) => {
          assert.equal(table, "instagramSourceOccurrenceReceipts");
          return {
            withIndex: (_indexName, configure) => {
              const builder = {
                eq: (field, value) => {
                  assert.equal(field, "sourceIdentity");
                  assert.equal(value, persistedSwappedReceipt.sourceIdentity);
                  return builder;
                },
              };
              configure(builder);
              return { unique: async () => persistedSwappedReceipt };
            },
          };
        },
      },
    },
    {
      sourceIdentity: persistedSwappedReceipt.sourceIdentity,
      serviceSecret: "qa-receipt-secret",
    },
  );
  assert.deepEqual(
    liveSwappedReceipt.satisfiedKeys,
    [],
    "the real receipt query must exclude a pending swapped-lane representative",
  );
  assert.deepEqual(liveSwappedReceipt.satisfiedOccurrences, []);
} finally {
  if (previousCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = previousCronSecret;
}

const ingestionSource = readFileSync(
  new URL("../lib/pipeline/run-instagram-ingestion.ts", import.meta.url),
  "utf8",
);
assert.match(
  ingestionSource,
  /SOURCE_OCCURRENCE_EXTRACTION_PROTOCOL_VERSION\s*=\s*\n\s*"2026-08-23-event-evidence-v2-lineup-occurrence-v1"/,
  "the protocol fingerprint must invalidate receipts produced by the per-slot lineup policy",
);

console.log("Instagram occurrence regression QA passed.");
