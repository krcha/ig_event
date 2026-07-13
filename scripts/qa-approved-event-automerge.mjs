import assert from "node:assert/strict";
import {
  buildApprovedEventAutoCleanupGroups,
  filterUpcomingApprovedEventsForDuplicateCleanup,
} from "../lib/events/approved-event-duplicates.ts";
import {
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
assert.equal(summary.mergedGroupCount, 3);
assert.equal(summary.mergedDuplicateCount, 3);
assert.equal(summary.remainingGroupCount, 0);
assert.equal(summary.finalApprovedCount, 5);
assert.equal(summary.failedCount, 0);
assert.equal(summary.passes, 2);
assert(summary.duplicateGroupCount >= 3);

let paginatedQueryCalls = 0;
const paginatedSourceEvent = {
  ...sameheadsPrimary,
  _id: sameheadsPrimary.id,
  status: "approved",
};
const paginatedSummary = await runApprovedEventAutoMerge({
  async query(_query, args) {
    paginatedQueryCalls += 1;
    assert.equal(args.status, "approved");
    assert.equal(args.paginationOpts.numItems, 100);
    if (paginatedQueryCalls === 1) {
      assert.equal(args.paginationOpts.cursor, null);
      return {
        page: [paginatedSourceEvent],
        isDone: false,
        continueCursor: "page-2",
      };
    }
    assert.equal(args.paginationOpts.cursor, "page-2");
    return {
      page: [],
      isDone: true,
      continueCursor: "",
    };
  },
  async mutation() {
    throw new Error("No merge mutation should run for a single approved event.");
  },
});
assert.equal(paginatedQueryCalls, 2);
assert.equal(paginatedSummary.approvedCount, 1);
assert.equal(paginatedSummary.failedCount, 0);

console.log(
  "QA passed: approved-event automerge uses future fixtures, collapses known duplicate groups, and leaves unrelated same-night entries separate.",
);
