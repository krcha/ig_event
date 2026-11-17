import assert from "node:assert/strict";
import { getPublicVenueMusicEvents, getPublicVenuePage } from "../convex/venues.ts";
import { addDaysToDateKey } from "../lib/events/nightlife-date.ts";

const originalNow = Date.now;
const originalFetch = globalThis.fetch;
const now = Date.parse("2026-11-18T01:00:00.000Z");
Date.now = () => now;
globalThis.fetch = async () => assert.fail("Venue music reads must never call a provider or network transport.");
const today = "2026-11-17";
const since = addDaysToDateKey(today, -30);
const before = "2026-11-18";
const overnightBefore = "2026-11-19";
const venue = { _id: "venue-music", _creationTime: 1, name: "Current Physical Club", category: "club",
  instagramHandle: "music_club", normalizedInstagramHandle: "music_club", aliases: [],
  publicStatus: "published", scrapeActive: true, createdAt: 1, updatedAt: 1 };
const neighbor = { ...venue, _id: "venue-neighbor", name: "Other Branch" };
const queryArgs = { id: venue._id, today, beforeDate: before };
const party = genres => ({ primaryCategory: "party", categories: ["party"], formats: ["dj-set"], genres });

/** The real grounding adapter validates this against the persisted source post. */
function event(id, overrides = {}, grounded = true) {
  const value = { _id: id, _creationTime: 1, title: `Music programme ${id}`, date: today, time: "22:00", timeStatus: "confirmed",
    venue: "Original Source Club Name", venueId: venue._id, venueInstagramHandle: venue.instagramHandle,
    normalizedVenueInstagramHandle: venue.instagramHandle, normalizedVenueIdentity: "current physical club",
    artists: ["Actual Artist"], eventType: "nightlife", updatedAt: 42, createdAt: 1,
    status: "approved", publicationPolicyVersion: 1, publicationState: "publishable",
    sourceCaption: `Original programme source for ${id}`, sourcePostedAt: "2026-10-01T12:00:00.000Z",
    instagramPostId: `post-${id}`, instagramPostUrl: `https://www.instagram.com/p/${id}/`,
    description: "Existing public event description", rawExtractionJson: "PRIVATE_RAW_EXTRACTION",
    ticketPrice: "200 RSD", imageUrl: "https://images.example.com/poster.jpg", ...overrides };
  if (grounded) {
    Object.assign(value, { humanReviewedLegacySourcePolicyVersion: 1, reviewedAt: 1, reviewedBy: "qa-operator",
      moderationNote: "PRIVATE_OPERATOR_NOTE: reviewed the original persisted Instagram source event.",
      normalizedFieldsJson: JSON.stringify({ sourceGroundingVersion: 4, sourceGroundingEvidence: "instagram_caption",
        sourceGroundingSourceKind: "caption", sourceGroundingSourceCaption: value.sourceCaption,
        sourceGroundingInstagramPostId: value.instagramPostId, sourceGroundingInstagramPostUrl: value.instagramPostUrl,
        sourceGroundingInstagramHandle: venue.instagramHandle, humanReviewedLegacySourcePolicyVersion: 1,
        normalizedIsValid: true, titleUsedFallback: false, dateSuspiciousYear: false,
        title: value.title, normalizedDate: value.date, time: value.time }) });
  }
  return value;
}
function label(value, genres, extras = {}) {
  return { _id: `label-${value._id}`, eventId: value._id, version: 1, eventUpdatedAt: value.updatedAt,
    model: "PRIVATE_MODEL", auditJson: "PRIVATE_CLASSIFIER_AUDIT", taxonomy: party(genres), ...extras };
}
function fixture(initial = {}) {
  const tables = structuredClone({ venues: [venue, neighbor], events: [], scrapedPosts: [],
    eventDiscoveryLabels: [], eventPerformerGenreResearch: [], ...initial });
  const snapshot = structuredClone(tables);
  const reads = [];
  const ctx = { db: {
    normalizeId(table, id) { return (tables[table] ?? []).some(row => row._id === id) ? id : null; },
    async get(id) { reads.push({ operation: "get", id }); return Object.values(tables).flat().find(row => row._id === id) ?? null; },
    insert() { assert.fail("A public music read must not insert records."); },
    patch() { assert.fail("A public music read must not mutate records."); },
    delete() { assert.fail("A public music read must not delete records."); },
    query(table) {
      const criteria = []; let index; let order = "asc";
      const q = {};
      const comparisons = { eq: (a, b) => a === b, lt: (a, b) => a < b, lte: (a, b) => a <= b,
        gt: (a, b) => a > b, gte: (a, b) => a >= b };
      for (const operation of Object.keys(comparisons)) q[operation] = (field, value) => { criteria.push({ operation, field, value }); return q; };
      const select = () => {
        const selected = (tables[table] ?? []).filter(row => criteria.every(c => comparisons[c.operation](row[c.field], c.value)));
        return [...selected].sort((a, b) => String(a.date ?? a._id).localeCompare(String(b.date ?? b._id)) * (order === "desc" ? -1 : 1));
      };
      const chain = {
        withIndex(name, configure) { index = name; configure(q); return chain; },
        order(direction) { order = direction; return chain; },
        collect() { assert.fail(`Unbounded ${table} collection is forbidden.`); },
        filter() { assert.fail(`Use indexed ${table} conditions, not an unbounded filter.`); },
        async take(limit) {
          assert.ok(Number.isSafeInteger(limit) && limit > 0 && limit <= 100, "Every indexed read requires a small explicit bound.");
          reads.push({ table, index, order, criteria: structuredClone(criteria), operation: "take", limit });
          return select().slice(0, limit);
        },
        async unique() {
          reads.push({ table, index, criteria: structuredClone(criteria), operation: "unique" });
          const rows = select(); assert.ok(rows.length <= 1, `Unexpected duplicate ${table} row.`); return rows[0] ?? null;
        },
      };
      return chain;
    },
  } };
  return { ctx, tables, reads, assertUnchanged: () => assert.deepEqual(tables, snapshot, "Public handlers must not mutate database fixtures.") };
}
function withSources(events) {
  return events.filter(e => e.humanReviewedLegacySourcePolicyVersion).map(e => ({ _id: `source-${e._id}`,
    handle: venue.instagramHandle, username: venue.instagramHandle, postId: e.instagramPostId,
    instagramPostUrl: e.instagramPostUrl, caption: e.sourceCaption, postedAt: e.sourcePostedAt }));
}

try {
  for (const candidate of [null, { ...venue, publicStatus: "hidden" }, { ...venue, publicStatus: "pending" },
    { ...venue, category: "promoter" }]) {
    const f = fixture({ venues: candidate ? [candidate] : [] });
    assert.equal(await getPublicVenueMusicEvents._handler(f.ctx, queryArgs), null);
    assert.deepEqual(f.reads, [{ operation: "get", id: venue._id }], "Ineligible venues must stop before any event/source/research reads.");
    f.assertUnchanged();
  }

  for (const [invalidToday, invalidBefore] of [
    ["2026-02-30", "2026-03-03"], ["2026-02-28", "2026-02-30"],
    ["2026-2-01", "2026-02-02"], ["2026-11-17", "2026-11-17"],
    ["2026-11-17", "2026-11-16"], ["2026-11-17", "2026-11-20"],
    ["", before], [today, "not-a-date"], [today, undefined], [undefined, before],
  ]) {
    const f = fixture();
    await assert.rejects(getPublicVenueMusicEvents._handler(f.ctx, { id: venue._id, today: invalidToday, beforeDate: invalidBefore }),
      /Invalid programme date window/, "Reject malformed calendar dates and any span other than one or two days.");
    assert.deepEqual(f.reads, [{ operation: "get", id: venue._id }], "An invalid window must stop before event/source/research reads.");
    f.assertUnchanged();
  }
  const leap = fixture();
  assert.deepEqual(await getPublicVenueMusicEvents._handler(leap.ctx, { id: venue._id, today: "2028-02-29", beforeDate: "2028-03-01" }),
    { asOf: now, events: [] }, "Valid leap dates must be accepted without a timezone runtime.");

  const events = [
    event("boundary", { date: since }), event("recent", { date: addDaysToDateKey(today, -1) }),
    event("announced"), event("performer", { artists: Array.from({ length: 25 }, (_, i) => `Artist ${i}`) }),
    event("estimated"), event("unknown-time", { timeStatus: "unknown", time: "23:30" }),
    event("missing-label"), event("stale-label"), event("civil-overnight", { date: before, time: "02:00" }),
    event("too-old", { date: addDaysToDateKey(since, -1) }), event("future", { date: overnightBefore }),
    event("pending", { status: "pending" }), event("rejected", { status: "rejected" }),
    event("not-publishable", { publicationState: "pending_verification" }), event("ungrounded", {}, false),
    event("legacy-unbound", { venueId: undefined }), event("different-bound-venue", { venueId: neighbor._id }),
  ];
  const byId = new Map(events.map(value => [value._id, value]));
  const labels = events.filter(e => !["missing-label", "ungrounded"].includes(e._id)).map(e => label(e,
    ["performer", "estimated"].includes(e._id) ? [] : ["house"], {
      ...(e._id === "stale-label" ? { eventUpdatedAt: e.updatedAt - 1 } : {}),
      ...(e._id === "estimated" ? { auditJson: '{"estimatedGenres":["techno"]}' } : {}),
    }));
  const profileSource = "https://ra.co/dj/actualartist";
  const f = fixture({ events, scrapedPosts: withSources(events), eventDiscoveryLabels: labels,
    eventPerformerGenreResearch: [{ _id: "research-performer", eventId: "performer", eventUpdatedAt: 42, version: 1,
      researchedAt: now, model: "PRIVATE_RESEARCH_MODEL", auditJson: "PRIVATE_RESEARCH_AUDIT",
      matches: [{ performer: "Actual Artist", genre: "house", url: profileSource, identityUrl: profileSource }] },
    { _id: "research-announced", eventId: "announced", eventUpdatedAt: 42, version: 1, researchedAt: now,
      model: "PRIVATE_RESEARCH_MODEL", auditJson: "PRIVATE_RESEARCH_AUDIT",
      matches: [{ performer: "Actual Artist", genre: "rock", url: profileSource, identityUrl: profileSource }] }],
  });
  const result = await getPublicVenueMusicEvents._handler(f.ctx, queryArgs);
  assert.equal(result.asOf, now);
  const expected = ["boundary", "recent", "announced", "performer", "estimated", "unknown-time", "missing-label", "stale-label"];
  assert.deepEqual(result.events.map(e => e._id).sort(), expected.sort(), "Only public, grounded, canonical-venue events inside the exact date window may cross the boundary.");
  assert.equal(new Set(result.events.map(e => e._id)).size, result.events.length);
  const projected = new Map(result.events.map(e => [e._id, e]));
  const allowed = new Set(["_id", "title", "date", "time", "timeStatus", "venueId", "venue", "eventType", "artists", "updatedAt", "eventTaxonomy", "performerGenreResearch"]);
  for (const value of result.events) {
    assert.ok(Object.keys(value).every(key => allowed.has(key)), `Unexpected public field on ${value._id}`);
    assert.equal(value.venueId, venue._id); assert.equal(value.venue, venue.name);
    assert.equal(value.title, byId.get(value._id).title); assert.equal(value.updatedAt, 42);
  }
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|sourceCaption|normalizedFieldsJson|rawExtractionJson|moderationNote|identityUrl/);
  assert.deepEqual(projected.get("announced").eventTaxonomy.genres, ["house"], "Announced source genre must override performer fallback.");
  assert.equal(projected.get("announced").performerGenreResearch, undefined);
  assert.deepEqual(projected.get("performer").performerGenreResearch, { sources: [{ performer: "Actual Artist", url: profileSource }] });
  assert.equal(projected.get("performer").artists.length, 20);
  assert.deepEqual(projected.get("estimated").eventTaxonomy.genres, ["techno"]);
  assert.deepEqual(projected.get("estimated").performerGenreResearch, { sources: [], estimated: true });
  assert.equal(Object.hasOwn(projected.get("unknown-time"), "time"), false, "A stale raw time cannot become a claimed start when its status is unknown.");
  assert.equal(projected.get("unknown-time").timeStatus, "unknown");
  assert.equal(projected.get("missing-label").eventTaxonomy, undefined);
  assert.equal(projected.get("stale-label").eventTaxonomy, undefined, "Outdated classifier evidence must remain absent.");
  const eventReads = f.reads.filter(read => read.table === "events");
  assert.equal(eventReads.length, 6);
  for (const index of ["by_venueId_status_date", "by_normalizedVenueHandle_status_date", "by_normalizedVenueIdentity_status_date"]) {
    for (const [direction, operation, limit] of [["desc", "lt", 24], ["asc", "gte", 12]]) {
      const read = eventReads.find(r => r.index === index && r.order === direction);
      assert.equal(read?.limit, limit);
      assert.ok(read.criteria.some(c => c.operation === "eq" && c.field === "status" && c.value === "approved"));
      assert.ok(read.criteria.some(c => c.operation === operation && c.field === "date" && c.value === today));
    }
  }
  const discoveryIds = f.reads.filter(read => ["eventDiscoveryLabels", "eventPerformerGenreResearch"].includes(read.table))
    .flatMap(read => read.criteria.filter(c => c.field === "eventId").map(c => c.value));
  assert.ok(discoveryIds.every(id => expected.includes(id)), "Do not load genre evidence for out-of-window, legacy-unbound or unpublished rows.");
  f.assertUnchanged();

  const night = fixture(f.tables);
  const overnight = await getPublicVenueMusicEvents._handler(night.ctx, { ...queryArgs, beforeDate: overnightBefore });
  assert.deepEqual(overnight.events.map(e => e._id).sort(), [...expected, "civil-overnight"].sort(),
    "An explicit two-day nightlife window includes the next civil day's early programme but excludes its upper boundary.");
  night.assertUnchanged();
  Date.now = () => now + 100 * 86_400_000;
  const stableWindow = await getPublicVenueMusicEvents._handler(fixture(f.tables).ctx, queryArgs);
  assert.deepEqual(stableWindow.events.map(e => e._id).sort(), [...expected].sort(),
    "Public date-window arguments, not cached backend clock or timezone, determine which programmes are read.");
  Date.now = () => now;
  const originalIntl = globalThis.Intl;
  try {
    globalThis.Intl = undefined;
    const withoutIntl = await getPublicVenueMusicEvents._handler(fixture(f.tables).ctx, queryArgs);
    assert.deepEqual(withoutIntl.events.map(e => e._id).sort(), [...expected].sort(),
      "The Convex query must run without an Intl/timezone runtime when date keys are supplied by Node.");
  } finally {
    globalThis.Intl = originalIntl;
  }

  const empty = fixture();
  assert.deepEqual(await getPublicVenueMusicEvents._handler(empty.ctx, queryArgs), { asOf: now, events: [] });
  const drifted = fixture({ ...f.tables, scrapedPosts: f.tables.scrapedPosts.map(post => post.postId === byId.get("announced").instagramPostId
    ? { ...post, caption: "A changed persisted source no longer matches the event attestation." } : post) });
  const driftedResult = await getPublicVenueMusicEvents._handler(drifted.ctx, queryArgs);
  assert.equal(driftedResult.events.some(e => e._id === "announced"), false, "An approved/materialized event must still fail when persisted source proof drifts.");
  drifted.assertUnchanged();
  const denseEvents = [
    ...Array.from({ length: 55 }, (_, index) => event(`dense-history-${index}`, { date: addDaysToDateKey(today, -(index % 28) - 1) })),
    ...Array.from({ length: 40 }, (_, index) => event(`dense-current-${index}`)),
  ];
  const dense = fixture({ events: denseEvents, scrapedPosts: withSources(denseEvents) });
  const bounded = await getPublicVenueMusicEvents._handler(dense.ctx, queryArgs);
  assert.equal(bounded.events.filter(e => e.date < today).length, 24, "A busy venue must return at most 24 recent historical cards.");
  assert.equal(bounded.events.filter(e => e.date >= today).length, 12, "A busy venue must return at most 12 current/upcoming cards.");
  assert.equal(bounded.events.length, 36);
  dense.assertUnchanged();
  const oldPage = await getPublicVenuePage._handler(f.ctx, { id: venue._id, today, historyLimit: 24, upcomingLimit: 12 });
  assert.deepEqual(Object.keys(oldPage).sort(), ["historyEvents", "stats", "upcomingEvents", "venue"]);
  assert.ok(oldPage.upcomingEvents.some(e => e._id === "legacy-unbound"), "Existing venue-page legacy compatibility must remain unchanged.");
  assert.ok(oldPage.upcomingEvents.some(e => e._id === "future"), "The old page still includes its bounded upcoming programmes beyond this music window.");
  assert.equal(oldPage.upcomingEvents.find(e => e._id === "performer").artists.length, 25, "The new music field bound must not alter original venue pages.");
  assert.equal(oldPage.upcomingEvents.find(e => e._id === "announced").description, byId.get("announced").description);
  assert.equal(oldPage.upcomingEvents.find(e => e._id === "announced").venue, byId.get("announced").venue);
  assert.ok(oldPage.upcomingEvents.every(e => !Object.hasOwn(e, "eventTaxonomy")), "The existing public page projection must not acquire new genre/metadata fields.");
  f.assertUnchanged();
  console.log("Venue music profile QA passed: actual grounding/discovery, private-field allowlist, canonical/date/publication fences, 24/12 indexed bounds and unchanged public venue pages.");
} finally {
  Date.now = originalNow;
  globalThis.fetch = originalFetch;
}
