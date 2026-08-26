import assert from "node:assert/strict";
import {
  buildApprovedEventAutoCleanupGroups,
  filterUpcomingApprovedEventsForDuplicateCleanup,
} from "../lib/events/approved-event-duplicates.ts";
import {
  assertApprovedEventAutoMergeCompleted,
  buildApprovedEventAutoMergeGroups,
  classifyApprovedEventAutoMergePair,
  isApprovedEventAutoMergePairEligible,
  runApprovedEventAutoMergeOnceForCompletedRun,
  runApprovedEventAutoMerge,
  simulateApprovedEventAutoMerge,
} from "../lib/events/approved-event-automerge.ts";

const fixtureStartDate = new Date();
const todayDate = createFixtureDate(0);
const sameNightDate = createFixtureDate(1);
const followingNightDate = createFixtureDate(2);
const staleFixtureDate = createFixtureDate(-1);

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function createFixtureDate(offsetDays) {
  return formatLocalDate(
    new Date(
      fixtureStartDate.getFullYear(),
      fixtureStartDate.getMonth(),
      fixtureStartDate.getDate() + offsetDays,
    ),
  );
}

function createNormalizedFields(date, fields) {
  return JSON.stringify({
    normalizedDate: date,
    ...fields,
  });
}

function createEvent(overrides) {
  return {
    id: "event_id",
    title: "",
    date: sameNightDate,
    time: null,
    venue: "",
    artists: [],
    description: null,
    imageUrl: null,
    instagramPostUrl: null,
    instagramPostId: null,
    ticketPrice: null,
    eventType: "event",
    sourceCaption: null,
    sourcePostedAt: null,
    normalizedFieldsJson: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function buildGroupedIdSets(groups) {
  return groups.map(
    (group) => new Set([group.primaryEventId, ...group.duplicateEventIds]),
  );
}

function hasExactGroup(groupedIdSets, expectedIds) {
  return groupedIdSets.some((ids) => {
    if (ids.size !== expectedIds.length) {
      return false;
    }
    return expectedIds.every((id) => ids.has(id));
  });
}

function hasGroupedPair(groupedIdSets, leftId, rightId) {
  return groupedIdSets.some((ids) => ids.has(leftId) && ids.has(rightId));
}

const sameheadsPrimary = createEvent({
  id: "j57a61ynp36x7aack11shje0hx82k9ra",
  title: "20 Years of Sameheads",
  date: followingNightDate,
  venue: "Karmakoma",
  artists: [
    "Alicia Carrera",
    "Electric Evelyn",
    "Ali Guney",
    "Emil Doesn't Drive",
    "Edin",
  ],
  description:
    "Celebration of 20 years of Sameheads at Karmakoma with Alicia Carrera and Electric Evelyn.",
  sourceCaption:
    "MARCH 14. @sameheads with @aliciacarrera___ and @evelyn___siegmund at Karmakoma.",
  instagramPostUrl: "https://www.instagram.com/p/DUqP5GLjOE0/",
  instagramPostId: "3830944327376101684",
  updatedAt: 55,
  normalizedFieldsJson: createNormalizedFields(followingNightDate, {
    normalizedVenue: "Karmakoma",
    rawVenue: "Karmakoma",
    titleUsedFallback: false,
    sourceCaptionFromModel:
      "MARCH 14. @sameheads with @aliciacarrera___ and @evelyn___siegmund at Karmakoma.",
  }),
});

const sameheadsTakeover = createEvent({
  id: "j578h2je9rts4yg8v4216hdgds82n8w1",
  title: "20 year Anniversary",
  date: followingNightDate,
  venue: "karmakoma",
  artists: [
    "sameheads",
    "dimsam___",
    "emil_angelo",
    "aliciacarrera___",
    "evelyn___siegmund",
  ],
  description:
    "The @sameheads 20 year anniversary takeover in Belgrade at @karmakoma_belgrade.",
  sourceCaption:
    "The @sameheads 20 XX year anniversary tour kicks off in Belgrade at @karmakoma_belgrade.",
  instagramPostUrl: "https://www.instagram.com/p/DVq6-V2CNaI/",
  instagramPostId: "3849148202301838984",
  updatedAt: 32,
  normalizedFieldsJson: createNormalizedFields(followingNightDate, {
    normalizedVenue: "karmakoma",
    rawVenue: "Karmakoma Club",
    titleUsedFallback: false,
    sourceCaptionFromModel:
      "The @sameheads 20 XX year anniversary tour kicks off at @karmakoma_belgrade.",
  }),
});

const tttMerchPromo = createEvent({
  id: "j5749bd4p26gz06nehed1xa33582n02q",
  title: "merch available After",
  date: sameNightDate,
  venue: "karmakoma",
  artists: ["TTT", "ZUBI"],
  description:
    "Concert by TTT performing songs from the new album Vazan i Veliki with guest ZUBI.",
  sourceCaption:
    "Veliki koncert u Karmakomi. Novi album Vazan i Veliki. Gosti ZUBI @zubikidaju.",
  instagramPostUrl: "https://www.instagram.com/p/DVguBbXjV9i/",
  instagramPostId: "3846276490019561314",
  updatedAt: 48,
  normalizedFieldsJson: createNormalizedFields(sameNightDate, {
    normalizedVenue: "karmakoma",
    rawVenue: "Karmakoma",
    titleUsedFallback: false,
    titleDerivedFromContext: true,
    titleContextCandidate: "merch available after",
    sourceCaptionFromModel:
      "Veliki koncert u Karmakomi. Novi album Vazan i Veliki. Gosti ZUBI @zubikidaju.",
  }),
});

const tttGiveaway = createEvent({
  id: "j575pxp5x4y5fygn1ekpdsb9ds82mkh1",
  title: "Oblakoder",
  date: sameNightDate,
  venue: "karmakoma",
  artists: ["Turbo Trans Turisti"],
  description:
    "Concert of Turbo Trans Turisti promoting their new album Vazan i Veliki at Karmakoma.",
  sourceCaption:
    "Turbo Trans Turisti nastupice 12. marta u Karmakomi uz promociju albuma Vazan i Veliki.",
  instagramPostUrl: "https://www.instagram.com/p/DVqUS58Co-i/",
  instagramPostId: "3848978091632922530",
  updatedAt: 44,
  normalizedFieldsJson: createNormalizedFields(sameNightDate, {
    normalizedVenue: "karmakoma",
    rawVenue: "Karmakoma",
    titleUsedFallback: true,
    sourceCaptionFromModel:
      "Turbo Trans Turisti nastupice 12. marta u Karmakomi uz promociju albuma Vazan i Veliki.",
  }),
});

const bazaExhibitionOpening = createEvent({
  id: "j5703qcn59qca5k5sr67ewpwds82ncfz",
  title: "Irena Ivanovic followed by a Party",
  date: sameNightDate,
  time: "19:00",
  venue: "Baza Kulturnih Zbivanja",
  artists: ["Aleksssa"],
  description:
    "Opening of the exhibition The Weight of Light by Irena Ivanovic followed by a party at 20:00.",
  sourceCaption:
    "19:00 otvaranje izlozbe THE WEIGHT OF LIGHT Irena Ivanovic. 20:00 zurka startuje.",
  instagramPostUrl: "https://www.instagram.com/p/DVtJCirDeBs/",
  instagramPostId: "3849773013558747244",
  updatedAt: 43,
  normalizedFieldsJson: createNormalizedFields(sameNightDate, {
    normalizedVenue: "Baza Kulturnih Zbivanja",
    rawVenue: "Baza Kulturnih Zbivanja",
    titleUsedFallback: false,
    titleDerivedFromContext: true,
    titleContextCandidate: "Irena Ivanovic followed by a party",
    sourceCaptionFromModel:
      "19:00 otvaranje izlozbe THE WEIGHT OF LIGHT Irena Ivanovic. 20:00 zurka startuje.",
  }),
});

const bazaScheduleEntry = createEvent({
  id: "j57184adsqqb35wk4s3ks51dx982nddv",
  title: "The Weight of Light",
  date: sameNightDate,
  time: "19:00",
  venue: "Baza Kulturnih Zbivanja",
  artists: ["Irena Ivanovic"],
  description: "Exhibition of works by Irena Ivanovic.",
  sourceCaption:
    "CET 12. MAR - The Weight of Light - izlozba radova Irena Ivanovic - 19h",
  instagramPostUrl: "https://www.instagram.com/p/DVn0jWHjZkd/",
  instagramPostId: "3848275533960681757",
  updatedAt: 39,
  normalizedFieldsJson: createNormalizedFields(sameNightDate, {
    normalizedVenue: "Baza Kulturnih Zbivanja",
    rawVenue: "Baza Kulturnih Zbivanja",
    titleUsedFallback: false,
    splitSourceLine:
      "CET 12. MAR - The Weight of Light - izlozba radova Irena Ivanovic - 19h",
    sourceCaptionFromModel:
      "CET 12. MAR - The Weight of Light - izlozba radova Irena Ivanovic - 19h",
  }),
});

const vinylScheduleEntry = createEvent({
  id: "j571r50ms9gx8mq5vj4wdcekgd82m1f6",
  title: "VINYL",
  date: sameNightDate,
  venue: "Vinyl",
  artists: ["Intruder"],
  description: "Vinyl Intruder all nighter event.",
  sourceCaption:
    "CLUB VINYL SEASON 2. Thursday 12.03. Intruder - all nighter.",
  instagramPostUrl: "https://www.instagram.com/p/DVqub13jO-O/",
  instagramPostId: "3849093054947192718",
  updatedAt: 36,
  normalizedFieldsJson: createNormalizedFields(sameNightDate, {
    normalizedVenue: "Vinyl",
    rawVenue: "Vinyl",
    titleUsedFallback: false,
    splitSourceLine: "VINYL INTRUDER - ALL NIGHTER 12.03.",
    sourceCaptionFromModel:
      "CLUB VINYL SEASON 2. Thursday 12.03. Intruder - all nighter.",
  }),
});

const tavanScheduleEntry = createEvent({
  id: "j57996w7ker84j3ywa54hn2pm182m85p",
  title: "ZEITMASCHINE",
  date: sameNightDate,
  venue: "Vinyl Belgrade Nightclub",
  artists: ["ZEITMASCHINE", "DUSCHAN RECHT", "TYWIN FOX"],
  description: "ZEITMASCHINE with Duschan Recht and Tywin Fox",
  sourceCaption:
    "TAVAN CLUB SEASON 1. Thursday @zeitmaschine.bgd with Duschan Recht x Tywin Fox.",
  instagramPostUrl: "https://www.instagram.com/p/DVrBjBPjUHs/",
  instagramPostId: "3849177111081075180",
  updatedAt: 34,
  normalizedFieldsJson: createNormalizedFields(sameNightDate, {
    normalizedVenue: "Vinyl Belgrade Nightclub",
    rawVenue: "Vinyl Belgrade Nightclub",
    titleUsedFallback: false,
    splitSourceLine:
      "ZEITMASCHINE DUSCHAN RECHT X TYWIN FOX 12.03. THU",
    sourceCaptionFromModel:
      "TAVAN CLUB SEASON 1. Thursday @zeitmaschine.bgd with Duschan Recht x Tywin Fox.",
  }),
});

const fixtureEvents = [
  sameheadsPrimary,
  sameheadsTakeover,
  tttMerchPromo,
  tttGiveaway,
  bazaExhibitionOpening,
  bazaScheduleEntry,
  vinylScheduleEntry,
  tavanScheduleEntry,
];

const strictPrimary = createEvent({
  id: "strict-primary",
  title: "Strict Proven Night",
  date: createFixtureDate(3),
  time: "22:00",
  venue: "Strict Venue",
  artists: ["Strict Artist", "Second Artist"],
  description: "Strict Proven Night at Strict Venue.",
  instagramPostUrl: "https://www.instagram.com/p/strict-primary/",
  instagramPostId: "strict-primary-post",
  normalizedFieldsJson: createNormalizedFields(createFixtureDate(3), {
    title: "Strict Proven Night",
    time: "22:00",
    normalizedVenue: "Strict Venue",
    artists: ["Strict Artist", "Second Artist"],
  }),
  updatedAt: 70,
});

const strictDuplicate = createEvent({
  ...strictPrimary,
  id: "strict-duplicate",
  artists: ["Second Artist", "Strict Artist"],
  instagramPostUrl: "https://www.instagram.com/p/strict-duplicate/",
  instagramPostId: "strict-duplicate-post",
  normalizedFieldsJson: createNormalizedFields(createFixtureDate(3), {
    title: "Strict Proven Night",
    time: "22:00",
    normalizedVenue: "Strict Venue",
    artists: ["Second Artist", "Strict Artist"],
  }),
  updatedAt: 60,
});

const fuzzyTitleDuplicate = createEvent({
  ...strictPrimary,
  id: "fuzzy-title-duplicate",
  title: "Strict Proven Night Extended",
  instagramPostUrl: "https://www.instagram.com/p/fuzzy-title-duplicate/",
  instagramPostId: "fuzzy-title-duplicate-post",
  normalizedFieldsJson: createNormalizedFields(createFixtureDate(3), {
    title: "Strict Proven Night Extended",
    time: "22:00",
    normalizedVenue: "Strict Venue",
    artists: ["Strict Artist", "Second Artist"],
  }),
  updatedAt: 55,
});

const artistMismatchDuplicate = createEvent({
  ...strictPrimary,
  id: "artist-mismatch-duplicate",
  artists: ["Other Artist"],
  instagramPostUrl: "https://www.instagram.com/p/artist-mismatch-duplicate/",
  instagramPostId: "artist-mismatch-duplicate-post",
  normalizedFieldsJson: createNormalizedFields(createFixtureDate(3), {
    title: "Strict Proven Night",
    time: "22:00",
    normalizedVenue: "Strict Venue",
    artists: ["Other Artist"],
  }),
  updatedAt: 54,
});

const distinctChildPrimary = createEvent({
  id: "distinct-child-primary",
  title: "Two-stage schedule",
  date: createFixtureDate(4),
  time: "20:00",
  venue: "Schedule Venue",
  instagramPostUrl: "https://www.instagram.com/p/same-schedule-post/",
  instagramPostId: "same-schedule-post-id",
  sourceOccurrenceKey: "schedule-child-1",
  normalizedFieldsJson: createNormalizedFields(createFixtureDate(4), {
    title: "Two-stage schedule",
    time: "20:00",
    normalizedVenue: "Schedule Venue",
    artists: [],
  }),
  updatedAt: 50,
});

const distinctChild = createEvent({
  ...distinctChildPrimary,
  id: "distinct-child-duplicate",
  sourceOccurrenceKey: "schedule-child-2",
  updatedAt: 40,
});

const missingTimePrimary = createEvent({
  id: "missing-time-primary",
  title: "Repeated Performance",
  date: createFixtureDate(5),
  time: null,
  venue: "Repeat Venue",
  artists: ["Repeat Artist"],
  instagramPostUrl: "https://www.instagram.com/p/missing-time-primary/",
  instagramPostId: "missing-time-primary-post",
  normalizedFieldsJson: createNormalizedFields(createFixtureDate(5), {
    title: "Repeated Performance",
    normalizedVenue: "Repeat Venue",
    artists: ["Repeat Artist"],
  }),
  updatedAt: 30,
});

const missingTimeDuplicate = createEvent({
  ...missingTimePrimary,
  id: "missing-time-duplicate",
  instagramPostUrl: "https://www.instagram.com/p/missing-time-duplicate/",
  instagramPostId: "missing-time-duplicate-post",
  updatedAt: 29,
});

const oneSidedTimeDuplicate = createEvent({
  ...missingTimePrimary,
  id: "one-sided-time-duplicate",
  time: "20:00",
  instagramPostUrl: "https://www.instagram.com/p/one-sided-time-duplicate/",
  instagramPostId: "one-sided-time-duplicate-post",
  normalizedFieldsJson: createNormalizedFields(createFixtureDate(5), {
    title: "Repeated Performance",
    time: "20:00",
    normalizedVenue: "Repeat Venue",
    artists: ["Repeat Artist"],
  }),
  updatedAt: 28,
});

const sameKeyMissingTimeDuplicate = createEvent({
  ...missingTimePrimary,
  id: "same-key-missing-time-duplicate",
  sourceOccurrenceKey: "same-immutable-child",
  instagramPostUrl: "https://www.instagram.com/p/same-key-missing-time-duplicate/",
  instagramPostId: "same-key-missing-time-duplicate-post",
});
const sameKeyMissingTimePrimary = {
  ...missingTimePrimary,
  sourceOccurrenceKey: "same-immutable-child",
};

const staleSameheadsTakeover = createEvent({
  ...sameheadsTakeover,
  id: "stale_sameheads_takeover",
  date: staleFixtureDate,
  normalizedFieldsJson: createNormalizedFields(staleFixtureDate, {
    normalizedVenue: "karmakoma",
    rawVenue: "Karmakoma Club",
    titleUsedFallback: false,
    sourceCaptionFromModel:
      "The @sameheads 20 XX year anniversary tour kicks off at @karmakoma_belgrade.",
  }),
});

assert(
  sameNightDate > todayDate && followingNightDate > sameNightDate,
  "Expected automerge fixtures to stay in the future relative to the QA run date.",
);

const upcomingFixtureIds = new Set(
  filterUpcomingApprovedEventsForDuplicateCleanup([
    ...fixtureEvents,
    staleSameheadsTakeover,
  ]).map((event) => event.id),
);

assert.equal(upcomingFixtureIds.size, fixtureEvents.length);
for (const event of fixtureEvents) {
  assert(
    upcomingFixtureIds.has(event.id),
    `Expected future-dated fixture ${event.id} to be included in automerge cleanup.`,
  );
}
assert(
  !upcomingFixtureIds.has(staleSameheadsTakeover.id),
  "Expected stale approved-event fixtures to be excluded from automerge cleanup.",
);

const cleanupGroups = buildApprovedEventAutoCleanupGroups(
  filterUpcomingApprovedEventsForDuplicateCleanup(fixtureEvents),
);
const groupedIdSets = buildGroupedIdSets(cleanupGroups);

assert(
  hasExactGroup(groupedIdSets, [sameheadsPrimary.id, sameheadsTakeover.id]),
  "Expected Sameheads anniversary variants to collapse into one automerge group.",
);

assert(
  hasExactGroup(groupedIdSets, [tttMerchPromo.id, tttGiveaway.id]),
  "Expected TTT album-promo variants to collapse into one automerge group.",
);

assert(
  hasExactGroup(groupedIdSets, [bazaExhibitionOpening.id, bazaScheduleEntry.id]),
  "Expected Baza exhibition variants to collapse into one automerge group.",
);

assert(
  !hasGroupedPair(groupedIdSets, vinylScheduleEntry.id, tavanScheduleEntry.id),
  "Expected unrelated same-night Vinyl and Tavan entries to remain separate.",
);

const summary = simulateApprovedEventAutoMerge(fixtureEvents);

assert.equal(summary.approvedCount, 8);
assert.equal(summary.scannedEventCount, 8);
assert.equal(summary.mergedGroupCount, 0);
assert.equal(summary.mergedDuplicateCount, 0);
assert.equal(summary.remainingGroupCount, 0);
assert.equal(summary.finalApprovedCount, 8);
assert.equal(summary.failedCount, 0);
assert.equal(summary.passes, 1);
assert.equal(summary.duplicateGroupCount, 0);

const strictGroups = buildApprovedEventAutoMergeGroups([
  ...fixtureEvents,
  strictPrimary,
  strictDuplicate,
  fuzzyTitleDuplicate,
  artistMismatchDuplicate,
  distinctChildPrimary,
  distinctChild,
]);
const strictGroupedIdSets = buildGroupedIdSets(strictGroups);
assert(
  hasExactGroup(strictGroupedIdSets, [strictPrimary.id, strictDuplicate.id]),
  "Expected the unattended cleanup contract to keep a pair the mutation can prove is duplicate.",
);
assert(
  !hasGroupedPair(strictGroupedIdSets, sameheadsPrimary.id, sameheadsTakeover.id),
  "Expected broad Sameheads evidence to remain review-only when the mutation classifies it as ambiguous.",
);
assert(
  !hasGroupedPair(strictGroupedIdSets, distinctChildPrimary.id, distinctChild.id),
  "Expected distinct occurrence keys from one multi-event source post to remain separate.",
);
assert.equal(
  classifyApprovedEventAutoMergePair(distinctChildPrimary, distinctChild),
  "proven_distinct",
);
assert.equal(
  classifyApprovedEventAutoMergePair(strictPrimary, fuzzyTitleDuplicate),
  "proven_duplicate",
  "The broader occurrence classifier should demonstrate the fuzzy-title replay risk.",
);
assert.equal(
  isApprovedEventAutoMergePairEligible(strictPrimary, fuzzyTitleDuplicate),
  false,
  "A fuzzy title must not survive the immutable receipt-binding boundary.",
);
assert.equal(
  classifyApprovedEventAutoMergePair(strictPrimary, artistMismatchDuplicate),
  "proven_duplicate",
  "A same-title pair should demonstrate the artist-binding replay risk.",
);
assert.equal(
  isApprovedEventAutoMergePairEligible(strictPrimary, artistMismatchDuplicate),
  false,
  "A different immutable artist set must block unattended deletion.",
);
assert.equal(
  isApprovedEventAutoMergePairEligible(strictPrimary, strictDuplicate),
  true,
  "Exact immutable title/date/time/venue/artist bindings must remain eligible.",
);
const aggregateDuplicate = {
  ...strictDuplicate,
  id: "campaign-aggregate-duplicate",
  normalizedFieldsJson: JSON.stringify({
    ...JSON.parse(strictDuplicate.normalizedFieldsJson),
    crossPostCampaignAggregateAttestation: { malformedButReserved: true },
  }),
};
assert.equal(
  isApprovedEventAutoMergePairEligible(strictPrimary, aggregateDuplicate),
  false,
  "Generic cleanup must never delete or absorb a campaign aggregate without its receipt-aware path.",
);
assert.equal(
  isApprovedEventAutoMergePairEligible(aggregateDuplicate, strictPrimary),
  false,
  "Campaign aggregates must be excluded regardless of which row quality ordering chooses as primary.",
);
assert(
  !hasGroupedPair(strictGroupedIdSets, strictPrimary.id, fuzzyTitleDuplicate.id),
  "Expected fuzzy-title receipt bindings to stay outside strict groups.",
);
assert(
  !hasGroupedPair(strictGroupedIdSets, strictPrimary.id, artistMismatchDuplicate.id),
  "Expected artist-mismatched receipt bindings to stay outside strict groups.",
);
assert.equal(
  classifyApprovedEventAutoMergePair(missingTimePrimary, missingTimeDuplicate),
  "proven_duplicate",
  "The broad classifier should demonstrate the unknown-time repeated-show risk.",
);
assert.equal(
  isApprovedEventAutoMergePairEligible(missingTimePrimary, missingTimeDuplicate),
  false,
  "Distinct-post candidates with two missing times must fail closed.",
);
assert.equal(
  classifyApprovedEventAutoMergePair(missingTimePrimary, oneSidedTimeDuplicate),
  "proven_duplicate",
);
assert.equal(
  isApprovedEventAutoMergePairEligible(missingTimePrimary, oneSidedTimeDuplicate),
  false,
  "One-sided immutable time evidence must fail closed.",
);
assert.equal(
  isApprovedEventAutoMergePairEligible(
    sameKeyMissingTimePrimary,
    sameKeyMissingTimeDuplicate,
  ),
  true,
  "An exact source occurrence key may safely prove one missing-time child.",
);

let strictMutationCalls = 0;
let strictRunnerEvents = [strictPrimary, strictDuplicate].map((event) => ({
  ...event,
  _id: event.id,
  status: "approved",
}));
const strictRunnerSummary = await runApprovedEventAutoMerge({
  async query(_query, args) {
    assert.equal(args.status, "approved");
    return {
      page: strictRunnerEvents,
      isDone: true,
      continueCursor: "",
    };
  },
  async mutation(_mutation, args) {
    strictMutationCalls += 1;
    assert.equal(args.primaryId, strictPrimary.id);
    assert.deepEqual(args.duplicateIds, [strictDuplicate.id]);
    assert.equal(args.expectedPrimaryUpdatedAt, strictPrimary.updatedAt);
    assert.deepEqual(args.expectedDuplicateVersions, [
      { id: strictDuplicate.id, expectedUpdatedAt: strictDuplicate.updatedAt },
    ]);
    strictRunnerEvents = strictRunnerEvents.filter(
      (event) => event._id !== strictDuplicate.id,
    );
    return { primaryId: strictPrimary.id, deletedDuplicateCount: 1 };
  },
});
assert.equal(strictMutationCalls, 1);
assert.equal(strictRunnerSummary.mergedGroupCount, 1);
assert.equal(strictRunnerSummary.mergedDuplicateCount, 1);
assert.equal(strictRunnerSummary.failedCount, 0);

let ambiguousMutationCalls = 0;
const ambiguousRunnerEvents = [sameheadsPrimary, sameheadsTakeover].map((event) => ({
  ...event,
  _id: event.id,
  status: "approved",
}));
const ambiguousRunnerSummary = await runApprovedEventAutoMerge({
  async query() {
    return {
      page: ambiguousRunnerEvents,
      isDone: true,
      continueCursor: "",
    };
  },
  async mutation() {
    ambiguousMutationCalls += 1;
    throw new Error("Ambiguous broad cleanup candidates must never reach mutation.");
  },
});
assert.equal(ambiguousMutationCalls, 0);
assert.equal(ambiguousRunnerSummary.duplicateGroupCount, 0);
assert.equal(ambiguousRunnerSummary.failedCount, 0);

let paginatedQueryCalls = 0;
const paginatedSourceEvents = Array.from({ length: 25 }, (_, index) => ({
  ...createEvent({
    id: `paginated-${index}`,
    title: `Unique paginated event ${index}`,
    date: createFixtureDate(index + 10),
    venue: `Unique venue ${index}`,
    instagramPostUrl: `https://www.instagram.com/p/paginated-${index}/`,
  }),
  _id: `paginated-${index}`,
  status: "approved",
}));
const paginatedSummary = await runApprovedEventAutoMerge({
  async query(_query, args) {
    paginatedQueryCalls += 1;
    assert.equal(args.status, "approved");
    assert.equal(args.paginationOpts.numItems, 10);
    if (paginatedQueryCalls === 1) {
      assert.equal(args.paginationOpts.cursor, null);
      return {
        page: paginatedSourceEvents.slice(0, 10),
        isDone: false,
        continueCursor: "page-2",
      };
    }
    if (paginatedQueryCalls === 2) {
      assert.equal(args.paginationOpts.cursor, "page-2");
      return {
        page: paginatedSourceEvents.slice(10, 20),
        isDone: false,
        continueCursor: "page-3",
      };
    }
    assert.equal(args.paginationOpts.cursor, "page-3");
    return {
      page: paginatedSourceEvents.slice(20),
      isDone: true,
      continueCursor: "",
    };
  },
  async mutation() {
    throw new Error("No merge mutation should run for unique approved events.");
  },
});
assert.equal(paginatedQueryCalls, 3);
assert.equal(paginatedSummary.approvedCount, 25);
assert.equal(paginatedSummary.failedCount, 0);

assert.throws(
  () =>
    assertApprovedEventAutoMergeCompleted({
      ...paginatedSummary,
      error: "cleanup transport failed",
    }),
  /cleanup transport failed/,
);
assert.throws(
  () =>
    assertApprovedEventAutoMergeCompleted({
      ...paginatedSummary,
      failedCount: 1,
      failures: [
        { primaryEventId: "primary", duplicateEventIds: ["duplicate"], error: "stale" },
      ],
    }),
  /failed for 1 merge group/,
);

let oncePerRunQueryCalls = 0;
const oncePerRunClient = {
  async query() {
    oncePerRunQueryCalls += 1;
    return { page: [], isDone: true, continueCursor: "" };
  },
  async mutation() {
    throw new Error("An empty completed run must not mutate approved events.");
  },
};
const [firstCompletedCleanup, concurrentCompletedCleanup] = await Promise.all([
  runApprovedEventAutoMergeOnceForCompletedRun(oncePerRunClient, {
    runId: "qa-completed-run-singleflight",
  }),
  runApprovedEventAutoMergeOnceForCompletedRun(oncePerRunClient, {
    runId: "qa-completed-run-singleflight",
  }),
]);
const replayedCompletedCleanup = await runApprovedEventAutoMergeOnceForCompletedRun(
  oncePerRunClient,
  { runId: "qa-completed-run-singleflight" },
);
assert.equal(oncePerRunQueryCalls, 1, "normal completion cleanup must run once per process");
assert.equal(firstCompletedCleanup.failedCount, 0);
assert.equal(concurrentCompletedCleanup.failedCount, 0);
assert.equal(replayedCompletedCleanup.failedCount, 0);

let retryableCleanupQueryCalls = 0;
const retryableCleanupClient = {
  async query() {
    retryableCleanupQueryCalls += 1;
    if (retryableCleanupQueryCalls === 1) {
      throw new Error("temporary completed-run cleanup failure");
    }
    return { page: [], isDone: true, continueCursor: "" };
  },
  async mutation() {
    throw new Error("An empty completed run must not mutate approved events.");
  },
};
await assert.rejects(
  () =>
    runApprovedEventAutoMergeOnceForCompletedRun(retryableCleanupClient, {
      runId: "qa-completed-run-retry",
    }),
  /temporary completed-run cleanup failure/,
);
await runApprovedEventAutoMergeOnceForCompletedRun(retryableCleanupClient, {
  runId: "qa-completed-run-retry",
});
assert.equal(
  retryableCleanupQueryCalls,
  2,
  "failed completion cleanup must remain retryable instead of entering the success cache",
);

console.log(
  "QA passed: approved-event automerge only mutates pairwise-proven groups and keeps broad or distinct-occurrence candidates out of unattended cleanup.",
);
