import assert from "node:assert/strict";
import {
  listDailyInputs,
  listGenreResearchInputs,
  listRecentInputs,
  listUnknownGenreInputs,
  listUpcomingDiscoveryRefresh,
  loadPublicEventDiscoveryLabels,
  recordBatch,
  recordDailyBatch,
  recordGenreResearch,
  recordUnknownGenreBatch,
  refreshUpcomingDiscoveryBatch,
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
import { getBelgradeDayKey } from "../lib/pipeline/belgrade-day-key.ts";

const options = { apiKey: "test-only-key", model: "fixture-search-model" };
const eventUrl = "https://ra.co/events/1234567";
const profileUrl = "https://www.instagram.com/selkadj/";
const wrongArtistUrl = "https://ra.co/dj/selka";

const party = { primaryCategory: "party", categories: ["party"], genres: [], formats: ["dj-set"] };
const hybrid = { ...party, primaryCategory: "food", categories: ["food", "party"], formats: ["dinner", "dj-set"] };
const concert = { primaryCategory: "live", categories: ["live"], genres: [], formats: ["concert"] };
const nonMusic = { primaryCategory: "culture", categories: ["culture"], genres: [], formats: ["screening"] };
const announced = { ...party, genres: ["techno"] };
assert.equal(getPerformerGenreResearchFormat(party), "dj-set");
assert.equal(getPerformerGenreResearchFormat(hybrid), "dj-set", "A secondary music activity is visible in the Unknown filter.");
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
assert.deepEqual(getPerformerGenreResearchActs({ title: "Saturday Night", artists: ["Special guest"] }, "party", true),
  [{ billedName: "Saturday Night", titleOnly: true }], "The new fallback may research the exact listing, separately from artist profiles.");

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
    _id: `label-${row._id}`,
    eventId: row._id,
    eventUpdatedAt: row.updatedAt,
    version: EVENT_DISCOVERY_VERSION,
    taxonomy: party,
  }]));
  labels.get("announced").taxonomy = announced;
  labels.get("stale-version").version = EVENT_DISCOVERY_VERSION + 2;
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
      insert: async (table, data) => {
        assert.equal(table, "eventDiscoveryLabels");
        assert.equal(labels.has(data.eventId), false);
        labels.set(data.eventId, { ...data, _id: `label-${data.eventId}` });
      },
      replace: async (id, data) => {
        assert.equal(labels.get(data.eventId)?._id, id);
        labels.set(data.eventId, { ...data, _id: id });
      },
    },
  };
  return { queueCtx, upcomingFrom, retryBefore, pages, reads };
}

function dailyQueueFixture() {
  const startedAt = Date.parse("2026-11-08T08:00:00Z");
  const finishedAt = startedAt + 30_000;
  const run = { _id: "run-today", mode: "daily", status: "completed", dailyDayKey: "2026-11-08",
    createdAt: startedAt - 10_000, queueBuildCompletedAt: startedAt - 1_000, dispatchReadyAt: startedAt, finishedAt };
  const runs = new Map([
    [run._id, run],
    ["manual-run", { ...run, _id: "manual-run", mode: "manual" }],
    ["running-run", { ...run, _id: "running-run", status: "running", finishedAt: undefined }],
    ["unowned-run", { ...run, _id: "unowned-run", dailyDayKey: undefined }],
  ]);
  const events = new Map();
  const labels = new Map();
  const webRows = new Map();
  const posts = [];
  const receipts = [];
  const pages = [];
  const venues = new Map([["venue-fixture", { _id: "venue-fixture", publicStatus: "published" }],
    ["venue-hidden", { _id: "venue-hidden", publicStatus: "hidden" }]]);
  const source = (postId, sourceCaption) => {
    const url = `https://www.instagram.com/p/${postId}/`;
    return { instagramPostId: postId, instagramPostUrl: url, canonicalSourceUrl: url,
      normalizedInstagramPostUrl: url, sourceCaption };
  };
  function eventFixture(id, overrides = {}, proof = "current") {
    const event = {
      ...currentEvent, _id: id, _creationTime: startedAt + 500, createdAt: startedAt + 500,
      publicationPolicyVersion: 1, publicationReason: "canonical_source_grounding_verified", venueId: "venue-fixture",
      ...source(`Post_${id.replaceAll("-", "_")}`, "Selka večeras pušta house i disco ploče."), ...overrides,
    };
    events.set(id, event);
    if (proof === "no-post") return;
    const post = { _id: `scraped-${id}`, handle: `fixture_${id.replaceAll("-", "_")}`,
      postId: event.instagramPostId, caption: event.sourceCaption, instagramPostUrl: event.instagramPostUrl };
    posts.push(post);
    if (proof === "no-receipt") return;
    receipts.push({ runId: proof === "other-run" ? "manual-run" : run._id, handle: post.handle, status: "completed",
      ...(proof === "legacy" ? { scrapedPostId: post._id } : {
        savedPostLinks: [{ scrapedPostId: post._id, postId: post.postId, sourceRevision: 1, instagramPostUrl: post.instagramPostUrl }],
      }) });
  }
  const localRow = "08.11. Selka pušta house.";
  const localDetail = "Selka večeras pušta i disco ploče.";
  const neighbor = "09.11. Drugi DJ pušta techno.";
  const sharedCaption = [localRow, localDetail, neighbor].join("\n");
  eventFixture("single", { _creationTime: startedAt, createdAt: startedAt, time: "22:30", timeStatus: "confirmed", timeSource: "caption",
    timeEvidenceKind: "start_time_stated", timeEvidenceText: "Početak u 22:30",
    normalizedFieldsJson: JSON.stringify({ time: "22:30", timeEvidenceVerified: true }) });
  eventFixture("split", { ...source("FixtureSplit", sharedCaption), normalizedFieldsJson: JSON.stringify({
    splitEventTotal: 2, rowSourceText: localRow, carouselTextEvidence: [{ source: "caption", text: localDetail }],
  }) });
  eventFixture("ambiguous", { ...source("FixtureAmbiguous", sharedCaption), time: "22:30", timeStatus: "confirmed", timeSource: "caption",
    timeEvidenceKind: "doors_open_only", timeEvidenceText: "Vrata od 22:30",
    normalizedFieldsJson: JSON.stringify({ multiEventSplitCount: 2, time: "22:30", timeEvidenceVerified: true }) });
  eventFixture("legacy-sibling", source("FixtureSiblings", sharedCaption));
  eventFixture("legacy-sibling-pending", { ...source("FixtureSiblings", sharedCaption), status: "pending" }, "no-post");
  eventFixture("estimate", { _creationTime: finishedAt, createdAt: finishedAt }, "legacy");
  eventFixture("nonmusic", { title: "Projekcija", eventType: "screening" });
  eventFixture("unbilled", { title: "Saturday Night", artists: [] });
  eventFixture("already-classified");
  labels.set("already-classified", { _id: "existing-label", version: 0, eventUpdatedAt: 90, taxonomy: announced });
  eventFixture("historical", { _creationTime: startedAt - 1, createdAt: startedAt - 1 });
  eventFixture("historic-created-at", { createdAt: startedAt - 1 });
  eventFixture("future", { _creationTime: finishedAt + 1, createdAt: finishedAt + 1 });
  eventFixture("hidden", { publicationState: "hidden" });
  eventFixture("no-post-id", { instagramPostId: undefined }, "no-post");
  eventFixture("no-post", {}, "no-post");
  eventFixture("no-receipt", {}, "no-receipt");
  eventFixture("other-run", {}, "other-run");
  const tables = {
    events: () => [...events.values()],
    scrapedPosts: () => posts,
    ingestionRunHandleReceipts: () => receipts,
    eventDiscoveryLabels: () => [...labels.values()],
    eventPerformerGenreResearch: () => [...webRows.values()],
  };
  const lookupKeys = {
    by_instagramPostId: ["instagramPostId"], by_canonicalSourceUrl: ["canonicalSourceUrl"],
    by_normalizedInstagramPostUrl: ["normalizedInstagramPostUrl"], by_instagramPostUrl: ["instagramPostUrl"],
    by_eventId: ["eventId"], by_postId: ["postId"], by_run_handle: ["runId", "handle"],
    by_creation_time: ["_creationTime", "_creationTime"],
    by_publicationState_date: ["publicationState", "date"],
  };
  const dailyCtx = {
    auth: ctx.auth,
    db: {
      get: async (...args) => runs.get(args.at(-1)) ?? events.get(args.at(-1)) ?? venues.get(args.at(-1)) ?? null,
      query(table) {
        assert.ok(table in tables);
        return { withIndex(index, range) {
          const fields = [];
          const checks = [];
          const chain = Object.fromEntries(Object.entries({
            eq: (value, target) => value === target,
            gte: (value, target) => value >= target,
            lte: (value, target) => value <= target,
          }).map(([op, test]) => [op, (field, value) => {
            fields.push(field);
            checks.push((row) => test(row[field], value));
            return chain;
          }]));
          range(chain);
          const expectedFields = index === "by_creation_time" && fields.length === 1 ? ["_creationTime"] : lookupKeys[index];
          assert.deepEqual(fields, expectedFields, `Unexpected ${table} index range.`);
          const rows = tables[table]().filter((row) => checks.every((check) => check(row)));
          const operations = {
            take: async (limit) => rows.slice(0, limit),
            unique: async () => { assert.ok(rows.length < 2); return rows[0] ?? null; },
            paginate: async ({ cursor, numItems }) => {
              assert.ok(["by_creation_time", "by_publicationState_date"].includes(index));
              pages.push({ cursor, numItems });
              const start = cursor === null ? 0 : Number(cursor);
              const end = start + numItems;
              return { page: rows.slice(start, end), isDone: end >= rows.length, continueCursor: String(end) };
            },
            order(direction) {
              assert.equal(direction, "asc");
              return operations;
            },
          };
          return operations;
        } };
      },
      insert: async (table, data) => {
        assert.ok(["eventDiscoveryLabels", "eventPerformerGenreResearch"].includes(table));
        const byEvent = table === "eventDiscoveryLabels" ? labels : webRows;
        assert.ok(!byEvent.has(data.eventId));
        byEvent.set(data.eventId, { ...data, _id: `${table}-${data.eventId}` });
      },
      replace: async (id, data) => {
        const byEvent = labels.get(data.eventId)?._id === id ? labels : webRows;
        assert.equal(byEvent.get(data.eventId)?._id, id);
        byEvent.set(data.eventId, { ...data, _id: id });
      },
    },
  };
  labels.get("already-classified").eventId = "already-classified";
  return { dailyCtx, events, labels, webRows, run, pages, localRow, localDetail, neighbor };
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

  const daily = dailyQueueFixture();
  const dailyArgs = { serviceSecret: "", runId: daily.run._id };
  const readDaily = async (runId = daily.run._id) => {
    const result = new Map();
    let cursor = null;
    do {
      const page = await listDailyInputs._handler(daily.dailyCtx, { ...dailyArgs, runId, cursor });
      for (const item of page.events) result.set(item.key, item);
      cursor = page.cursor;
    } while (cursor !== null);
    return result;
  };
  for (const invalid of ["missing-run", "manual-run", "running-run", "unowned-run"]) assert.equal((await readDaily(invalid)).size, 0);
  assert.deepEqual(daily.pages, [], "An invalid run cannot open the events index.");
  const dailyQueue = await readDaily();
  assert.deepEqual([...dailyQueue.keys()].sort(), ["ambiguous", "estimate", "legacy-sibling", "nonmusic", "single", "split", "unbilled"],
    "Only unclassified, newly inserted, publishable events from posts recorded in the completed daily run are eligible.");
  assert.equal(dailyQueue.get("single").sourceCaption, daily.events.get("single").sourceCaption);
  assert.equal(dailyQueue.get("single").eventType, daily.events.get("single").eventType);
  assert.equal(dailyQueue.get("single").date, daily.events.get("single").date);
  assert.equal(dailyQueue.get("single").time, "22:30", "Include a confirmed and source-verified start time.");
  assert.equal(dailyQueue.get("ambiguous").time, undefined, "Doors-open time cannot stand in for the event start.");
  const splitInput = dailyQueue.get("split");
  assert.equal(splitInput.occurrenceText, daily.localRow);
  assert.ok(splitInput.sourceCaption.includes(daily.localDetail), "A shared carousel may contribute exact caption text scoped to this event.");
  assert.ok(!splitInput.sourceCaption.includes(daily.neighbor), "A sibling's genre cannot reach this event's classifier.");
  assert.equal(dailyQueue.get("ambiguous").sourceCaption, undefined);
  assert.equal(dailyQueue.get("legacy-sibling").sourceCaption, undefined, "A pending sibling still means the caption covers multiple events.");

  const dailyResult = (eventId, extra = {}) => ({ eventId, expectedUpdatedAt: 100, taxonomy: party, auditJson: "{}", ...extra });
  const recordDaily = (...results) => recordDailyBatch._handler(daily.dailyCtx, { ...dailyArgs, model: "fixture", results });
  const projection = (eventId, includeEstimate = true) =>
    loadPublicEventDiscoveryLabels(daily.dailyCtx, daily.events.get(eventId), includeEstimate);
  const originalLabel = daily.labels.get("already-classified");
  assert.deepEqual(await recordDaily(dailyResult("already-classified")), { written: 0, unchanged: 1, stale: 0 });
  assert.equal(daily.labels.get("already-classified"), originalLabel, "A previously classified event is never rewritten by the daily batch.");
  assert.deepEqual(await recordDaily(dailyResult("historical"), dailyResult("no-receipt"),
    dailyResult("single", { expectedUpdatedAt: 99 })), { written: 0, unchanged: 0, stale: 3 });

  const announcedFromCaption = { ...party, genres: ["house"] };
  const captionClaim = (label, quote) => ({ kind: "genre", label, source: "sourceCaption", quote });
  const webResult = (matches = [researchMatches[0]]) => ({ model: "web-fixture", matches, auditJson: '{"evidence":"private web proof"}' });
  assert.deepEqual(await recordDaily(
    dailyResult("single", {
      taxonomy: announcedFromCaption,
      auditJson: JSON.stringify({ evidence: [captionClaim("house", "pušta house i disco ploče")] }),
      estimatedGenres: ["techno"],
      webResearch: webResult(),
    }),
    dailyResult("estimate", { estimatedGenres: ["techno", "house"], webResearch: webResult() }),
    dailyResult("nonmusic", { taxonomy: nonMusic, estimatedGenres: ["rock"] }),
    dailyResult("unbilled", { estimatedGenres: ["pop"] }),
  ), { written: 4, unchanged: 0, stale: 0 });
  assert.deepEqual(await projection("single"), { eventTaxonomy: announcedFromCaption }, "A verified original caption takes precedence over an estimate.");
  assert.deepEqual(await projection("estimate"), {
    eventTaxonomy: { ...party, genres: ["techno", "house"] }, performerGenreResearch: { sources: [], estimated: true },
  });
  assert.deepEqual(await projection("estimate", false), { eventTaxonomy: party }, "Consumers that opt out do not see estimated genres.");
  assert.deepEqual(await projection("nonmusic"), { eventTaxonomy: nonMusic });
  assert.deepEqual(await projection("unbilled"), { eventTaxonomy: party }, "A generic title cannot stand in for a billed performer.");
  assert.equal(daily.webRows.size, 0, "Web research cannot supersede an announced genre or model estimate.");
  assert.deepEqual(await recordDaily(dailyResult("legacy-sibling", { webResearch: webResult() }),
    dailyResult("ambiguous", { webResearch: webResult([researchMatches[2]]) })), { written: 2, unchanged: 0, stale: 0 });
  assert.deepEqual(await projection("legacy-sibling"), {
    eventTaxonomy: { ...party, genres: ["house"] }, performerGenreResearch: { sources: [{ url: eventUrl, performer: "Selka" }] },
  }, "Web proof is stored with the new classification and keeps its provenance.");
  assert.deepEqual(await projection("ambiguous"), { eventTaxonomy: party }, "A web result for a different artist is ignored.");
  assert.deepEqual(await recordDaily(dailyResult("split", {
    taxonomy: { ...party, genres: ["techno"] },
    auditJson: JSON.stringify({ evidence: [captionClaim("techno", daily.neighbor)] }),
  })), { written: 0, unchanged: 0, stale: 1 }, "The write path verifies every original caption quote against the current scoped text.");
  assert.equal(await projection("split"), undefined);
  assert.deepEqual(await recordDaily(dailyResult("split", { webResearch: webResult([{
    ...researchMatches[0], performer: daily.events.get("split").title.toUpperCase(),
  }]) })), { written: 1, unchanged: 0, stale: 0 });
  assert.deepEqual((await projection("split")).performerGenreResearch.sources,
    [{ url: eventUrl, performer: daily.events.get("split").title.toUpperCase() }], "An exact listing title can corroborate web genre even when the event has billed artists.");
  assert.deepEqual(await recordDaily(dailyResult("single")), { written: 0, unchanged: 1, stale: 0 }, "Replaying the daily batch cannot remove existing genres.");
  assert.ok(!(await readDaily()).has("single"));

  const backfill = dailyQueueFixture();
  const setBackfillLabel = (eventId, taxonomy, auditJson = "{}") => backfill.labels.set(eventId, {
    _id: `label-${eventId}`, eventId, eventUpdatedAt: 100, version: EVENT_DISCOVERY_VERSION, model: "original-fixture", taxonomy, auditJson,
  });
  setBackfillLabel("single", announced);
  setBackfillLabel("estimate", party, '{"estimatedGenres":["techno"],"estimateModel":"old-model"}');
  setBackfillLabel("ambiguous", party);
  setBackfillLabel("split", hybrid, '{"originalAudit":"preserve"}');
  setBackfillLabel("legacy-sibling", party);
  for (const [eventId, eventUpdatedAt] of [["ambiguous", 100], ["legacy-sibling", 99]]) {
    backfill.webRows.set(eventId, { _id: `web-${eventId}`, eventId, eventUpdatedAt, version: PERFORMER_GENRE_RESEARCH_VERSION,
      model: "web-fixture", researchedAt: 10, matches: [researchMatches[0]], auditJson: "{}" });
  }
  backfill.events.get("historical").description = "DJ Selka pušta rok ploče.";
  const backfillArgs = { serviceSecret: "", cutoff: backfill.run.finishedAt };
  const readUnknown = () => listUnknownGenreInputs._handler(backfill.dailyCtx, { ...backfillArgs, cursor: null });
  const recordUnknown = (...results) => recordUnknownGenreBatch._handler(backfill.dailyCtx, { ...backfillArgs, model: "backfill-fixture", results });
  const backfillProjection = (eventId) => loadPublicEventDiscoveryLabels(backfill.dailyCtx, backfill.events.get(eventId), true);

  const initialUnknown = new Map((await readUnknown()).events.map((candidate) => [candidate.key, candidate]));
  for (const eventId of ["single", "estimate", "ambiguous", "hidden", "legacy-sibling-pending", "nonmusic", "future"]) {
    assert.equal(initialUnknown.has(eventId), false, `${eventId} is outside the effective Unknown scope.`);
  }
  for (const eventId of ["split", "legacy-sibling", "historical", "already-classified", "unbilled"]) {
    assert.ok(initialUnknown.has(eventId), `${eventId} should be included in the effective Unknown scope.`);
  }
  assert.deepEqual(initialUnknown.get("split").currentTaxonomy, hybrid);
  assert.equal(initialUnknown.get("historical").date, backfill.events.get("historical").date);

  const initialEstimate = backfill.labels.get("estimate");
  const initialWeb = backfill.webRows.get("ambiguous");
  const previousUnknownLabel = backfill.labels.get("legacy-sibling");
  assert.deepEqual(await recordUnknown(
    dailyResult("estimate", { estimatedGenres: ["house"] }),
    dailyResult("ambiguous", { estimatedGenres: ["techno"] }),
    dailyResult("legacy-sibling", { webResearch: webResult([researchMatches[2]]) }),
    dailyResult("unbilled", { webResearch: webResult([{ ...researchMatches[0], performer: "Saturday Night", identityUrl: wrongArtistUrl }]) }),
  ), { written: 0, unchanged: 4, stale: 0 });
  assert.equal(backfill.labels.get("estimate"), initialEstimate);
  assert.equal(backfill.webRows.get("ambiguous"), initialWeb);
  assert.equal(backfill.labels.get("legacy-sibling"), previousUnknownLabel, "Unresolved results do not rewrite taxonomy.");
  assert.deepEqual(await recordUnknown(
    dailyResult("split", { taxonomy: { ...concert, genres: ["techno"] },
      auditJson: JSON.stringify({ evidence: [captionClaim("techno", backfill.neighbor)] }) }),
    dailyResult("no-post", { taxonomy: announced, auditJson: JSON.stringify({
      evidence: [{ kind: "genre", label: "techno", source: "title", quote: "Outdated listing title" }],
    }) }),
    dailyResult("historical", { expectedUpdatedAt: 99, estimatedGenres: ["rock"] }),
    dailyResult("future", { estimatedGenres: ["house"] }),
  ), { written: 0, unchanged: 0, stale: 4 });

  assert.deepEqual(await recordUnknown(
    dailyResult("split", { taxonomy: { ...concert, genres: ["house", "disco-funk"] },
      auditJson: JSON.stringify({ evidence: [captionClaim("house", backfill.localRow),
        { kind: "genre", label: "disco-funk", source: "description", quote: "Unaccepted after a caption match" }] }),
      estimatedGenres: ["techno"], webResearch: webResult() }),
    dailyResult("historical", { taxonomy: { ...concert, genres: ["rock"] },
      auditJson: JSON.stringify({ evidence: [{ kind: "genre", label: "rock", source: "description", quote: "pušta rok ploče" }] }) }),
    dailyResult("already-classified", { estimatedGenres: ["house"] }),
    dailyResult("legacy-sibling", { webResearch: webResult() }),
    dailyResult("unbilled", { estimatedGenres: ["pop"], webResearch: webResult([{ ...researchMatches[0], performer: "Saturday Night" }]) }),
  ), { written: 5, unchanged: 0, stale: 0 });
  assert.deepEqual(await backfillProjection("split"), { eventTaxonomy: { ...hybrid, genres: ["house"] } },
    "Only exact original caption genres win and the existing hybrid taxonomy stays intact.");
  assert.equal(backfill.labels.get("split").model, "original-fixture");
  assert.equal(JSON.parse(backfill.labels.get("split").auditJson).originalAudit, "preserve");
  assert.deepEqual((await backfillProjection("historical")).eventTaxonomy.genres, ["rock"]);
  assert.deepEqual((await backfillProjection("already-classified")).performerGenreResearch, { sources: [], estimated: true });
  assert.equal(backfill.labels.get("legacy-sibling"), previousUnknownLabel, "A web result leaves the original classification intact.");
  assert.deepEqual((await backfillProjection("unbilled")).performerGenreResearch, { sources: [{ url: eventUrl, performer: "Saturday Night" }] });
  assert.deepEqual(await recordUnknown(dailyResult("split", { estimatedGenres: ["techno"] })), { written: 0, unchanged: 1, stale: 0 });
  assert.ok((await readUnknown()).events.every(({ key }) => !["split", "historical", "already-classified", "legacy-sibling", "unbilled"].includes(key)));

  const refresh = dailyQueueFixture();
  const refreshDate = getBelgradeDayKey();
  for (const event of refresh.events.values()) event.date = "2000-01-01";
  function setRefreshEvent(eventId, title, eventType, fields = {}) {
    Object.assign(refresh.events.get(eventId), { title, eventType, date: refreshDate, sourceCaption: undefined, ...fields });
  }
  function setRefreshLabel(eventId, taxonomy, auditJson = "{}") {
    refresh.labels.set(eventId, { _id: `label-${eventId}`, eventId, eventUpdatedAt: 100, version: EVENT_DISCOVERY_VERSION,
      model: "original-fixture", taxonomy, auditJson });
  }
  setRefreshEvent("single", "Koncert Selke", "live music");
  setRefreshEvent("estimate", "Koncert Selke", "live music");
  setRefreshEvent("legacy-sibling", "DJ set uz Selku", "nightlife");
  setRefreshEvent("nonmusic", "JAZZ VEČE", "live music", {
    artists: ["Billed Musician"], description: "Jazz uz razgovor i hranu.",
    sourceCaption: "Još jedan lep ponedeljak za jazaa, razgovor i klopu.",
    normalizedFieldsJson: JSON.stringify({ rowSourceText: "JAZZ VEČE; 9. NOVEMBAR; BILLED MUSICIAN" }),
  });
  setRefreshEvent("ambiguous", "Radionica keramike", "learning");
  setRefreshEvent("no-post", "Radionica keramike", "learning");
  setRefreshEvent("unbilled", "Saturday Night", "event");
  setRefreshEvent("hidden", "Radionica keramike", "learning");
  setRefreshEvent("no-receipt", "Radionica keramike", "learning", { venueId: "venue-hidden" });
  setRefreshEvent("legacy-sibling-pending", "Radionica keramike", "learning");
  setRefreshLabel("single", { ...announced, formats: [] }, '{"originalAudit":"keep"}');
  setRefreshLabel("estimate", { ...party, formats: [] }, '{"estimatedGenres":["techno"],"estimateModel":"original-model"}');
  setRefreshLabel("legacy-sibling", { ...concert, formats: [] });
  setRefreshLabel("nonmusic", { primaryCategory: "talk", categories: ["talk"], genres: [], formats: [] },
    '{"evidence":[{"kind":"category","label":"talk","source":"description","quote":"razgovor"}]}');
  setRefreshLabel("ambiguous", announced);
  setRefreshEvent("future", "Razgovor sa autorima filma", "arts & culture");
  setRefreshLabel("future", { primaryCategory: "culture", categories: ["culture", "talk"], formats: ["screening"], genres: [] });
  const preservedWeb = { _id: "web-legacy-sibling", eventId: "legacy-sibling", eventUpdatedAt: 100,
    version: PERFORMER_GENRE_RESEARCH_VERSION, model: "web-fixture", researchedAt: 10, matches: [researchMatches[0]], auditJson: "{}" };
  refresh.webRows.set("legacy-sibling", preservedWeb);
  const previewRefresh = (extra = {}) => listUpcomingDiscoveryRefresh._handler(refresh.dailyCtx, { serviceSecret: "", cursor: null, ...extra });
  const applyRefresh = (proposals) => refreshUpcomingDiscoveryBatch._handler(refresh.dailyCtx, {
    serviceSecret: "", fromDate: refreshDate, proposals: proposals.map(({ eventId, expectedUpdatedAt, before, after }) =>
      ({ eventId, expectedUpdatedAt, before, after })),
  });
  await assert.rejects(previewRefresh({ fromDate: "2000-01-01" }), /current Belgrade date/);
  const preview = await previewRefresh();
  assert.equal(preview.fromDate, refreshDate);
  assert.equal(preview.counts.needsReview, 2, "Leave known genres and removals of existing formats or activities for review.");
  assert.ok(preview.counts.inconclusive >= 1);
  assert.deepEqual(preview.proposals.map(({ eventId }) => eventId).sort(), ["estimate", "legacy-sibling", "no-post", "nonmusic", "single"]);
  assert.equal(refresh.labels.has("no-post"), false, "A preview cannot change labels.");
  const singleProposal = preview.proposals.find(({ eventId }) => eventId === "single");
  const jazzProposal = preview.proposals.find(({ eventId }) => eventId === "nonmusic");
  assert.ok(jazzProposal.evidence.some(({ kind, label, source, quote }) => kind === "genre" && label === "jazz-blues" && source === "title" && jazzProposal.title.includes(quote)));
  assert.equal(singleProposal.before.primaryCategory, "party");
  assert.equal(singleProposal.after.primaryCategory, "live");
  assert.ok(singleProposal.evidence.some(({ source, quote }) => source === "title" && singleProposal.title.includes(quote)));
  assert.deepEqual(await applyRefresh([{ ...singleProposal, expectedUpdatedAt: 99 },
    { ...preview.proposals.find(({ eventId }) => eventId === "estimate"), before: concert }]),
  { written: 0, unchanged: 0, stale: 2, needsReview: 0 }, "A changed event revision or conflicting original taxonomy fences the write.");
  assert.deepEqual(await applyRefresh(preview.proposals), { written: 5, unchanged: 0, stale: 0, needsReview: 0 });
  const refreshed = (eventId) => loadPublicEventDiscoveryLabels(refresh.dailyCtx, refresh.events.get(eventId), true);
  assert.deepEqual((await refreshed("single")).eventTaxonomy.genres, ["techno"]);
  assert.equal(JSON.parse(refresh.labels.get("single").auditJson).originalAudit, "keep");
  assert.deepEqual((await refreshed("estimate")).performerGenreResearch, { sources: [], estimated: true });
  assert.deepEqual((await refreshed("legacy-sibling")).performerGenreResearch.sources, [{ url: eventUrl, performer: "Selka" }]);
  assert.equal(refresh.webRows.get("legacy-sibling"), preservedWeb);
  assert.equal((await refreshed("no-post")).eventTaxonomy.primaryCategory, "participate");
  assert.deepEqual((await refreshed("nonmusic")).eventTaxonomy, { primaryCategory: "live", categories: ["live"], formats: ["live-performance"], genres: ["jazz-blues"] });
  assert.deepEqual(await applyRefresh(preview.proposals), { written: 0, unchanged: 5, stale: 0, needsReview: 0 });
} finally {
  if (adminBeforeFixture === undefined) delete process.env.ADMIN_CLERK_USER_IDS;
  else process.env.ADMIN_CLERK_USER_IDS = adminBeforeFixture;
}

console.log("Performer genre research QA passed: cited web transport, daily scope, exact Instagram captions, and source-aware Unknown backfill.");
