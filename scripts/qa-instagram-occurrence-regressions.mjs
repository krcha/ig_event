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
  prepareEventsForInsert,
  processIngestionPostWithExtractionForTesting,
} from "../lib/pipeline/run-instagram-ingestion.ts";

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
      venue: "frǾm",
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
        return `qa-common-occurrence-${persistedCommonEvents.length}`;
      },
    },
    handle: "common.belgrade",
    post: { ...commonPost, postType: "video" },
    summary: persistenceSummary,
    canonicalVenueNamesByHandle: { "common.belgrade": "COMMON | Белград | Мероприятия" },
    venueNameOverridesByHandle: {},
    configuredVenueNamesByHandle: { "common.belgrade": "COMMON | Белград | Мероприятия" },
    serviceSecret: "qa",
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
            if ("id" in args) return args.id;
            persistedSyntaxEvents.push(args);
            return `qa-recurring-syntax-${persistedSyntaxEvents.length}`;
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
          ? `${suspiciousRecurrenceMarker}\nMONDAY 14:00`
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
    post: { ...missingLanePost, postType: "video" },
    summary: rejectedCoverageSummary,
    canonicalVenueNamesByHandle: { "common.belgrade": "COMMON | Белград | Мероприятия" },
    venueNameOverridesByHandle: {},
    configuredVenueNamesByHandle: { "common.belgrade": "COMMON | Белград | Мероприятия" },
    serviceSecret: "qa",
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
        if ("id" in args) return args.id;
        persistedSwappedLaneEvents.push(args);
        return `qa-swapped-lane-${persistedSwappedLaneEvents.length}`;
      },
    },
    handle: "common.belgrade",
    post: { ...groundedCommonPost, postType: "video" },
    summary: swappedPersistenceSummary,
    canonicalVenueNamesByHandle: { "common.belgrade": "COMMON | Белград | Мероприятия" },
    venueNameOverridesByHandle: {},
    configuredVenueNamesByHandle: { "common.belgrade": "COMMON | Белград | Мероприятия" },
    serviceSecret: "qa",
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
  /SOURCE_OCCURRENCE_EXTRACTION_PROTOCOL_VERSION\s*=\s*"2026-07-28-v3"/,
  "the protocol fingerprint must invalidate receipts produced by the old split policy",
);

console.log("Instagram occurrence regression QA passed.");
