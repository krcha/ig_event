import assert from "node:assert/strict";
import {
  listGenreResearchInputs,
  listRecentInputs,
  loadPublicEventDiscoveryLabels,
  recordBatch,
  recordGenreResearch,
} from "../convex/eventDiscovery.ts";
import {
  PERFORMER_GENRE_RESEARCH_BATCH_LIMIT,
  researchPerformerGenresBatch,
} from "../lib/ai/research-performer-genres.ts";
import {
  applyPerformerGenreResearch,
  canPublishPerformerGenreSource,
  EMPTY_RESEARCH_RETRY_MS,
  getPerformerGenreResearchActs,
  getPerformerGenreResearchFormat,
  PERFORMER_GENRE_RESEARCH_VERSION,
} from "../lib/taxonomy/performer-genre-research.ts";
import { EVENT_DISCOVERY_VERSION } from "../lib/taxonomy/event-discovery.ts";

const options = { apiKey: "test-only-key", model: "fixture-search-model" };
const eventUrl = "https://ra.co/events/1234567";
const profileUrl = "https://www.instagram.com/selkadj/";
const wrongArtistUrl = "https://ra.co/dj/selka";

const party = { primaryCategory: "party", categories: ["party"], genres: [], formats: ["dj-set"] };
const concert = { primaryCategory: "live", categories: ["live"], genres: [], formats: ["concert"] };
const nonMusic = { primaryCategory: "culture", categories: ["culture"], genres: [], formats: ["screening"] };
const announced = { ...party, genres: ["techno"] };
assert.equal(getPerformerGenreResearchFormat(party), "dj-set");
assert.equal(getPerformerGenreResearchFormat(concert), "concert");
assert.equal(getPerformerGenreResearchFormat(announced), undefined);
assert.equal(getPerformerGenreResearchFormat(nonMusic), undefined);
assert.deepEqual(getPerformerGenreResearchActs({ title: "Night program", artists: [" Selka ", "Selka", "@other.act", "TBA"] }, "dj-set"), [
  { billedName: "Selka" }, { billedName: "@other.act", billedHandle: "other.act" },
], "Deduplicate exact artist identities without erasing distinct billed acts.");
assert.deepEqual(getPerformerGenreResearchActs({ title: "Night program", artists: ["Act One", "Act Two", "Act Three"] }, "dj-set"), [
  { billedName: "Act One" }, { billedName: "Act Two" },
], "A longer lineup is bounded to two source-ordered artists.");
assert.deepEqual(getPerformerGenreResearchActs({ title: "Act Two", artists: ["Act One", "Act Two", "Act Three"] }, "dj-set"), [{ billedName: "Act Two" }]);
assert.deepEqual(getPerformerGenreResearchActs({ title: "Saturday Night", artists: ["Special guest"] }, "party"), [],
  "A generic party title and unnamed guest cannot authorize profile lookup.");

const unsafeUrls = [
  "http://ra.co/dj/selka", "https://user:password@ra.co/dj/selka", "https://ra.co:8443/dj/selka",
  "https://127.0.0.1/artist", "https://[::1]/artist", "https://private.local/artist",
];
for (const url of unsafeUrls) assert.equal(canPublishPerformerGenreSource(url), false, `Reject unsafe source shape ${url}.`);
assert.equal(canPublishPerformerGenreSource(eventUrl), true);
const researchMatches = [
  { genre: "house", performer: "Selka", url: eventUrl, identityUrl: eventUrl },
  { genre: "house", performer: "Selka", url: eventUrl, identityUrl: eventUrl },
  { genre: "techno", performer: "Another Act", url: wrongArtistUrl, identityUrl: wrongArtistUrl },
  { genre: "pop", performer: "Private claim", url: unsafeUrls[0], identityUrl: eventUrl },
];
const initialParty = structuredClone(party);
const projected = applyPerformerGenreResearch(party, researchMatches);
assert.deepEqual(projected.eventTaxonomy.genres, ["house", "techno"]);
assert.equal(projected.performerGenreResearch.sources.length, 2);
assert.deepEqual(party, initialParty, "Research projection cannot mutate the announced taxonomy.");
assert.deepEqual(applyPerformerGenreResearch(announced, researchMatches), { eventTaxonomy: announced }, "Announced genre always wins over research.");
assert.deepEqual(applyPerformerGenreResearch(nonMusic, researchMatches), { eventTaxonomy: nonMusic });
assert.deepEqual(applyPerformerGenreResearch(party, [researchMatches[3]]), { eventTaxonomy: party }, "Unsafe evidence cannot add an inferred genre.");

const input = {
  key: "internal-event-performer-id",
  eventTitle: "Neonski susreti",
  venue: "Fabrika Test",
  date: "2026-11-08",
  billedName: "Selka",
  trustedFormat: "dj-set",
};
const eventQuote = "Selka plays house and techno at Fabrika Test for Neonski susreti on November 8, 2026.";
const profileQuote = "Selka (@selkadj) is a house and techno DJ from Belgrade.";
const identity = (kind, url, quote) => ({ kind, url, quote });
const genre = (label, url, quote) => ({ genre: label, url, quote });
const row = (index, overrides = {}) => ({
  row: index,
  status: "resolved",
  identity: identity("event-listing", eventUrl, eventQuote),
  genres: [genre("house", eventUrl, eventQuote), genre("techno", eventUrl, eventQuote)],
  ...overrides,
});
function envelope(rows, { sources = [eventUrl], annotations = [], completedSearch = true } = {}) {
  return Response.json({
    id: "response-research-fixture",
    model: "fixture-search-model-2026-11-07",
    status: "completed",
    output: [
      ...(completedSearch ? [{ type: "web_search_call", status: "completed", action: {
        type: "search", sources: sources.map((url) => ({ type: "url", url })),
      } }] : []),
      { type: "message", role: "assistant", status: "completed", content: [{
        type: "output_text", text: JSON.stringify({ rows }),
        annotations: annotations.map((url) => ({ type: "url_citation", url, title: "Fixture source", start_index: 0, end_index: 4 })),
      }] },
    ],
    usage: { input_tokens: 90, output_tokens: 30, total_tokens: 120 },
  });
}

let enteredBoundary = false;
const listing = await researchPerformerGenresBatch([input], {
  ...options,
  beforeTransport: async () => { enteredBoundary = true; },
  fetch: async (url, request) => {
    assert.equal(enteredBoundary, true, "The budget boundary runs before the search provider request.");
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal(request.method, "POST");
    const body = JSON.parse(request.body);
    assert.equal(body.store, false);
    assert.ok(body.tools.some(({ type }) => type === "web_search" || type === "web_search_preview"));
    assert.ok(!request.body.includes(input.key), "A web request must not expose internal event IDs.");
    return envelope([row(0, { genres: [
      genre("house", eventUrl, eventQuote), genre("house", eventUrl, eventQuote),
      genre("techno", eventUrl, eventQuote), genre("pop", eventUrl, eventQuote),
    ] })]);
  },
});
assert.equal(listing.searchCalls, 1);
const accepted = listing.results.get(input.key);
assert.equal(accepted.status, "resolved");
assert.equal(accepted.billedName, input.billedName);
assert.deepEqual(accepted.genres, ["house", "techno"], "Keep unique genres explicitly stated by a cited source for the exact act.");
assert.equal(accepted.identityEvidence.url, eventUrl);
assert.ok(accepted.genreEvidence.every((proof) => proof.url === eventUrl));

const billedHandle = { ...input, billedHandle: "@selkadj" };
const profile = await researchPerformerGenresBatch([billedHandle], {
  ...options,
  fetch: async () => envelope([row(0, {
    identity: identity("profile-handle", profileUrl, profileQuote),
    genres: [genre("house", profileUrl, profileQuote)],
  })], { sources: [], annotations: [profileUrl] }),
});
assert.deepEqual(profile.results.get(input.key).genres, ["house"], "A cited profile can establish identity through an exactly billed handle.");
await assert.rejects(researchPerformerGenresBatch([input], {
  ...options, fetch: async () => envelope([row(0)], { completedSearch: false, annotations: [eventUrl] }),
}), /web search did not complete/i, "An output that claims a citation without a completed search cannot supply proof.");

const ambiguousInputs = [
  [input, row(0, { identity: identity("event-listing", eventUrl, "Selka appears at Another Venue on November 9, 2026.") }), { sources: [eventUrl] }],
  [input, row(0, { identity: identity("event-listing", eventUrl, eventQuote.replace("November 8", "November 9")) }), { sources: [eventUrl] }],
  [billedHandle, row(0, {
    identity: identity("profile-handle", wrongArtistUrl, "Selka (@unrelated) is a house DJ."),
    genres: [genre("house", wrongArtistUrl, "Selka (@unrelated) is a house DJ.")],
  }), { sources: [wrongArtistUrl] }],
  [input, row(0), { sources: [] }],
  [input, row(0, { status: "ambiguous" }), { sources: [eventUrl] }],
  [{ ...billedHandle, titleOnly: true }, row(0, {
    identity: identity("profile-handle", profileUrl, profileQuote),
    genres: [genre("house", profileUrl, profileQuote)],
  }), { sources: [profileUrl] }],
];
for (const [candidate, output, sources] of ambiguousInputs) {
  const response = await researchPerformerGenresBatch([candidate], { ...options, fetch: async () => envelope([output], sources) });
  const declined = response.results.get(candidate.key);
  assert.notEqual(declined.status, "resolved", "A wrong occurrence, wrong handle, uncited source or ambiguous response must fail closed.");
  assert.deepEqual(declined.genres, []);
}

const wrongGenreEvidence = await researchPerformerGenresBatch([input], {
  ...options,
  fetch: async () => envelope([row(0, { genres: [
    genre("jazz-blues", wrongArtistUrl, "Selka plays jazz in London."),
    genre("rock", eventUrl, "A different band plays rock."),
    genre("fake-genre", eventUrl, eventQuote),
    genre("house", eventUrl, eventQuote),
  ] })], { sources: [eventUrl, wrongArtistUrl] }),
});
assert.deepEqual(wrongGenreEvidence.results.get(input.key).genres, ["house"],
  "Genre evidence from a same-name act at a different source, a different billed act, or a non-enum claim cannot follow the event identity.");

const corroborated = await researchPerformerGenresBatch([input], {
  ...options,
  fetch: async () => envelope([row(0, {
    identity: { ...identity("event-listing", eventUrl, eventQuote), corroboration: {
      url: wrongArtistUrl, quote: "Selka appears at Fabrika Test on November 8.",
    } },
    genres: [genre("techno", wrongArtistUrl, "House and techno DJ.")],
  })], { sources: [eventUrl, wrongArtistUrl] }),
});
assert.deepEqual(corroborated.results.get(input.key).genres, ["techno"],
  "A separate artist profile can supply genre only when its citation independently corroborates this artist and occurrence.");

assert.equal(PERFORMER_GENRE_RESEARCH_BATCH_LIMIT, 4);
const maxInputs = Array.from({ length: PERFORMER_GENRE_RESEARCH_BATCH_LIMIT }, (_, index) => ({ ...input, key: index }));
const maxBatch = await researchPerformerGenresBatch(maxInputs, {
  ...options, fetch: async () => envelope(maxInputs.map((_, index) => row(index)).reverse()),
});
assert.deepEqual([...maxBatch.results.keys()], [0, 1, 2, 3], "Provider row order must not change billed act identities.");
let unexpectedTransport = 0;
const neverTransport = async () => {
  unexpectedTransport++;
  assert.fail("Invalid inputs must stop before network transport.");
};
for (const invalid of [[], [...maxInputs, { ...input, key: 4 }], [input, input]]) {
  await assert.rejects(researchPerformerGenresBatch(invalid, { ...options, beforeTransport: neverTransport, fetch: neverTransport }));
}
assert.equal(unexpectedTransport, 0);
for (const invalid of [[row(0)], [row(0), row(0)], [row(0), row(2)], [row(0), row("1")], [row(0), row(1), row(2)]]) {
  await assert.rejects(researchPerformerGenresBatch(maxInputs.slice(0, 2), { ...options, fetch: async () => envelope(invalid) }),
    /row|coverage/i, "Missing, duplicate, string or extra provider rows must fail closed for the whole batch.");
}

const currentEvent = {
  _id: "event-fixture", title: input.eventTitle, venue: input.venue, date: input.date, artists: ["Selka"],
  eventType: "nightlife", status: "approved", publicationState: "publishable", updatedAt: 100,
};
let event = currentEvent;
const currentLabel = { version: EVENT_DISCOVERY_VERSION, eventUpdatedAt: event.updatedAt, taxonomy: party };
let label = currentLabel;
let research = null;
let researchReads = 0;
const db = {
  get: async (id) => id === event._id ? event : null,
  query(table) {
    return { withIndex(index, lookup) {
      assert.equal(index, "by_eventId");
      lookup({ eq: (field, id) => {
        assert.equal(field, "eventId");
        assert.equal(id, currentEvent._id);
      } });
      return { unique: async () => {
        if (table === "eventDiscoveryLabels") return label;
        assert.equal(table, "eventPerformerGenreResearch");
        researchReads++;
        return research;
      } };
    } };
  },
  insert: async (table, data) => {
    if (table === "eventDiscoveryLabels") {
      assert.equal(label, null);
      label = { ...data, _id: "discovery-label-fixture" };
      return;
    }
    assert.equal(table, "eventPerformerGenreResearch");
    assert.equal(research, null);
    research = { ...data, _id: "research-fixture" };
  },
  replace: async (id, data) => {
    assert.equal(id, research?._id);
    research = { ...data, _id: id };
  },
};
const ctx = { db, auth: { getUserIdentity: async () => ({ subject: "fixture-admin" }) } };
const nextResearch = { eventId: event._id, expectedUpdatedAt: 100, model: "fixture", matches: [researchMatches[0]], auditJson: '{"quote":"internal fixture evidence"}' };
const record = (entry = nextResearch) => recordGenreResearch._handler(ctx, { serviceSecret: "", results: [entry] });
const stale = { written: 0, resolved: 0, unchanged: 0, stale: 1 };
const unchanged = { written: 0, resolved: 0, unchanged: 1, stale: 0 };
const publicProjection = (includePerformerGenreResearch = true) => loadPublicEventDiscoveryLabels(ctx, event, includePerformerGenreResearch);
const adminBeforeFixture = process.env.ADMIN_CLERK_USER_IDS;

function upcomingQueueFixture() {
  const upcomingFrom = "2026-11-08";
  const later = "2026-11-15";
  const fixtureEvent = (id, date = upcomingFrom, overrides = {}) => ({
    ...currentEvent, _id: id, title: "Selka", date, ...overrides,
  });
  const events = [
    fixtureEvent("later-unclassified", later, { updatedAt: 1 }),
    fixtureEvent("later-research", later, { updatedAt: 2 }),
    fixtureEvent("pending", upcomingFrom, { status: "pending" }),
    fixtureEvent("hidden", upcomingFrom, { publicationState: "hidden" }),
    fixtureEvent("past", "2026-11-07"),
    fixtureEvent("today-unclassified", upcomingFrom, { updatedAt: 3 }),
    fixtureEvent("today-research", upcomingFrom, { updatedAt: 4 }),
    fixtureEvent("announced"),
    fixtureEvent("stale-version"),
    fixtureEvent("stale-revision"),
    fixtureEvent("already-researched"),
    fixtureEvent("recent-empty"),
    fixtureEvent("expired-empty"),
    fixtureEvent("outdated-research"),
    fixtureEvent("unknown-act", upcomingFrom, { title: "Saturday Night", artists: ["Special guest"] }),
    fixtureEvent("screening"),
  ];
  const byId = new Map(events.map((row) => [row._id, row]));
  const labels = new Map(events.filter((row) => !row._id.endsWith("-unclassified")).map((row) => [row._id, {
    eventId: row._id,
    eventUpdatedAt: row.updatedAt,
    version: EVENT_DISCOVERY_VERSION,
    taxonomy: party,
  }]));
  labels.get("announced").taxonomy = announced;
  labels.get("stale-version").version = EVENT_DISCOVERY_VERSION + 1;
  labels.get("stale-revision").eventUpdatedAt--;
  labels.get("screening").taxonomy = nonMusic;
  const retryBefore = 1000;
  const researchRow = (key, researchedAt, matches = []) => ({
    version: PERFORMER_GENRE_RESEARCH_VERSION,
    eventUpdatedAt: byId.get(key).updatedAt,
    researchedAt,
    matches,
  });
  const rows = new Map([
    ["already-researched", researchRow("already-researched", 100, [researchMatches[0]])],
    ["recent-empty", researchRow("recent-empty", retryBefore + 1)],
    ["expired-empty", researchRow("expired-empty", retryBefore - 1)],
    ["outdated-research", { ...researchRow("outdated-research", retryBefore + 1, [researchMatches[0]]), eventUpdatedAt: 99 }],
  ]);
  const pages = [];
  const reads = [];
  function ordered(table, index, matches) {
    return {
      order(direction) {
        return {
          async paginate({ cursor, numItems }) {
            pages.push({ table, index, direction, numItems, cursor });
            const sorted = index === "by_publicationState_date"
              ? [...matches].sort((a, b) => a.date.localeCompare(b.date))
              : [...matches].sort((a, b) => (b.updatedAt ?? b.eventUpdatedAt) - (a.updatedAt ?? a.eventUpdatedAt));
            const start = cursor === null ? 0 : Number(cursor);
            const end = start + numItems;
            return { page: sorted.slice(start, end), isDone: end >= sorted.length, continueCursor: String(end) };
          },
        };
      },
    };
  }
  const queueCtx = {
    auth: ctx.auth,
    db: {
      get: async (id) => { reads.push(id); return byId.get(id) ?? null; },
      query(table) {
        if (table === "events") return {
          withIndex(index, range) {
            if (index === "by_updatedAt") return ordered(table, index, events);
            assert.equal(index, "by_publicationState_date");
            const calls = [];
            const chain = {
              eq(field, value) { calls.push(["eq", field, value]); return chain; },
              gte(field, value) { calls.push(["gte", field, value]); return chain; },
            };
            range(chain);
            assert.deepEqual(calls, [["eq", "publicationState", "publishable"], ["gte", "date", upcomingFrom]]);
            return ordered(table, index, events.filter((row) => row.publicationState === "publishable" && row.date >= upcomingFrom));
          },
        };
        const byEventId = table === "eventDiscoveryLabels" ? labels : rows;
        assert.ok(["eventDiscoveryLabels", "eventPerformerGenreResearch"].includes(table));
        return {
          withIndex(index, range) {
            assert.equal(index, "by_eventId");
            let eventId;
            range({ eq(field, id) { assert.equal(field, "eventId"); eventId = id; } });
            return { unique: async () => byEventId.get(eventId) ?? null };
          },
          ...ordered(table, null, [...byEventId.values()]),
        };
      },
    },
  };
  return { queueCtx, upcomingFrom, retryBefore, pages, reads };
}

try {
  process.env.ADMIN_CLERK_USER_IDS = "fixture-admin";
  event = { ...currentEvent, publicationState: "held" };
  assert.deepEqual(await record(), stale, "An unpublished event cannot receive research.");
  event = currentEvent;
  assert.deepEqual(await record({ ...nextResearch, expectedUpdatedAt: 99 }), stale, "A changed event cannot receive stale research.");
  assert.deepEqual(await record({ ...nextResearch, matches: [researchMatches[2]] }), stale, "Research must match the source-billed performer.");
  assert.equal(research, null);

  const empty = { ...nextResearch, matches: [] };
  assert.deepEqual(await record(empty), { written: 1, resolved: 0, unchanged: 0, stale: 0 });
  assert.deepEqual(await record(empty), unchanged, "An empty result does not immediately repeat the same research write.");
  research = { ...research, researchedAt: Date.now() - EMPTY_RESEARCH_RETRY_MS - 1000 };
  assert.deepEqual(await record(empty), { written: 1, resolved: 0, unchanged: 0, stale: 0 }, "An expired empty result may be refreshed.");
  assert.deepEqual(await record(), { written: 1, resolved: 1, unchanged: 0, stale: 0 });
  assert.deepEqual(await record(empty), unchanged, "A repeated empty result cannot erase current sourced research.");

  const validResearch = research;
  const validProjection = await publicProjection();
  assert.deepEqual(validProjection.eventTaxonomy.genres, ["house"]);
  assert.deepEqual(validProjection.performerGenreResearch.sources, [{ url: eventUrl, performer: "Selka" }]);
  assert.doesNotMatch(JSON.stringify(validProjection), /internal fixture evidence|auditJson|identityUrl/);
  const readsBeforeDisabled = researchReads;
  assert.deepEqual(await publicProjection(false), { eventTaxonomy: party }, "Disabled research preserves the announced classification only.");
  assert.equal(researchReads, readsBeforeDisabled, "Disabled research must not fetch estimate rows.");
  research = { ...validResearch, eventUpdatedAt: 99 };
  assert.deepEqual(await publicProjection(), { eventTaxonomy: party }, "Revision-stale provenance cannot be projected.");
  research = { ...validResearch, version: PERFORMER_GENRE_RESEARCH_VERSION + 1 };
  assert.deepEqual(await publicProjection(), { eventTaxonomy: party }, "Incompatible research versions cannot be projected.");
  research = validResearch;
  label = { ...currentLabel, eventUpdatedAt: 99 };
  assert.equal(await publicProjection(), undefined, "A stale discovery label cannot confer eligibility on current research.");
  label = { ...currentLabel, taxonomy: announced };
  const readsBeforeAnnounced = researchReads;
  assert.deepEqual(await publicProjection(), { eventTaxonomy: announced }, "Announced genres always win.");
  assert.equal(researchReads, readsBeforeAnnounced, "Announced genres do not trigger an extra research lookup.");

  const { queueCtx, upcomingFrom, retryBefore, pages, reads } = upcomingQueueFixture();
  const recentArgs = { serviceSecret: "", cursor: null };
  const genreArgs = { ...recentArgs, retryBefore };
  const keys = (result) => result.events.map(({ key }) => key);
  const first = await listRecentInputs._handler(queueCtx, { ...recentArgs, upcomingFrom });
  assert.deepEqual(keys(first), ["today-unclassified", "stale-version", "stale-revision"]);
  assert.equal(first.cursor, "12", "The cursor advances across raw date-ordered rows, including already classified rows.");
  const second = await listRecentInputs._handler(queueCtx, { ...recentArgs, upcomingFrom, cursor: first.cursor });
  assert.deepEqual(keys(second), ["later-unclassified"], "A future event is reachable even when its update timestamp is the oldest.");
  assert.equal(second.cursor, null);
  assert.deepEqual(pages.splice(0), [
    { table: "events", index: "by_publicationState_date", direction: "asc", numItems: 12, cursor: null },
    { table: "events", index: "by_publicationState_date", direction: "asc", numItems: 12, cursor: "12" },
  ]);
  const upcoming = await listGenreResearchInputs._handler(queueCtx, { ...genreArgs, upcomingFrom });
  assert.deepEqual(keys(upcoming), ["today-research", "expired-empty", "outdated-research", "later-research"],
    "Research walks upcoming public dates and excludes unpublished, stale-classification, already labeled and recently attempted rows.");
  assert.equal(upcoming.cursor, null);
  assert.deepEqual(pages.splice(0), [
    { table: "events", index: "by_publicationState_date", direction: "asc", numItems: 36, cursor: null },
  ]);
  reads.length = 0;
  const eventIds = [
    "later-research", "missing", "announced", "stale-version", "today-research", "pending",
    "hidden", "past", "stale-revision", "already-researched", "recent-empty", "expired-empty",
  ];
  const focused = await listGenreResearchInputs._handler(queueCtx, { ...genreArgs, upcomingFrom, eventIds });
  assert.deepEqual(keys(focused), ["later-research", "today-research", "expired-empty"],
    "Focused research preserves the requested order while requiring public eligibility and current classifications.");
  assert.deepEqual(focused.events.map(({ expectedUpdatedAt }) => expectedUpdatedAt), [2, 4, 100]);
  assert.equal(focused.cursor, null);
  assert.deepEqual(pages, [], "A focused request does not scan the date index.");
  assert.equal(reads.length, eventIds.length);
  for (const invalid of [
    { eventIds }, { upcomingFrom, eventIds, cursor: "1" }, { upcomingFrom, eventIds: [...eventIds, "outdated-research"] },
    { upcomingFrom, eventIds: ["today-research", "today-research"] },
  ]) await assert.rejects(listGenreResearchInputs._handler(queueCtx, { ...genreArgs, ...invalid }));
  assert.equal(reads.length, eventIds.length, "Invalid focused requests are rejected before loading event rows.");

  await listRecentInputs._handler(queueCtx, recentArgs);
  await listGenreResearchInputs._handler(queueCtx, genreArgs);
  assert.deepEqual(pages, [
    { table: "events", index: "by_updatedAt", direction: "desc", numItems: 60, cursor: null },
    { table: "eventDiscoveryLabels", index: null, direction: "desc", numItems: 36, cursor: null },
  ], "Omitting upcoming options preserves both legacy indexes and bounds.");

  const nextClassification = { eventId: currentEvent._id, expectedUpdatedAt: 100, taxonomy: party, auditJson: "{}" };
  const recordClassification = () => recordBatch._handler(ctx, {
    serviceSecret: "", model: "fixture", results: [nextClassification],
  });
  label = null;
  for (const overrides of [{ publicationState: "hidden" }, { publicationState: "pending_verification" }, { status: "pending" }, { updatedAt: 101 }]) {
    event = { ...currentEvent, ...overrides };
    assert.deepEqual(await recordClassification(), { written: 0, unchanged: 0, stale: 1 });
    assert.equal(label, null, "Publication or revision changes after listing must fence off the classification write.");
  }
  event = currentEvent;
  assert.deepEqual(await recordClassification(), { written: 1, unchanged: 0, stale: 0 });
  assert.deepEqual(await recordClassification(), { written: 0, unchanged: 1, stale: 0 });
} finally {
  if (adminBeforeFixture === undefined) delete process.env.ADMIN_CLERK_USER_IDS;
  else process.env.ADMIN_CLERK_USER_IDS = adminBeforeFixture;
}

console.log("Performer genre research QA passed: cited web transport, upcoming and focused scheduling, revision-bound projection.");
