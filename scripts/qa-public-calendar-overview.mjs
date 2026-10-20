import assert from "node:assert/strict";
import { getFunctionName } from "convex/server";
import * as overviewModule from "../convex/publicCalendarOverview.ts";
import { resolvePublicEventVenueFilter } from "../lib/events/public-event-venue-filter.ts";

const { listWindow } = overviewModule;
assert.deepEqual(Object.keys(overviewModule), ["listWindow"], "The additive module must expose exactly one query.");
assert.equal(listWindow.isQuery, true);
assert.equal(listWindow.isPublic, true);
const publicVenue = {
  _id: "venue-public", name: "Current Venue", aliases: ["Stari lokal"], location: "Reviewed address",
};
const event = {
  _id: "event-first", artists: ["\u017deljko"], date: "2026-10-20", description: "A live band concert",
  eventType: "music", title: "First concert", venue: "Source Venue", venueId: publicVenue._id,
};
const second = { ...event, _id: "event-second", title: "Second concert", venue: publicVenue.name };
const workshop = { ...event, _id: "workshop", date: "2026-10-21", title: "Creative evening", description: "A hands-on workshop" };
const window = { fromDate: "2026-10-01", beforeDate: "2026-11-01" };

function context({ events = [event, second, workshop], venues = [publicVenue], cursor = null, isDone = true, fail } = {}) {
  const calls = [];
  return {
    calls,
    ctx: {
      // All authority stays in the existing API; the adapter cannot read or
      // write tables, inspect private evidence, schedule or mutate anything.
      db: new Proxy({}, { get() { throw new Error("Direct DB access is forbidden."); } }),
      async runQuery(reference, args) {
        const name = getFunctionName(reference);
        calls.push({ name, args: structuredClone(args) });
        if (fail === name) throw new Error("Authoritative public query failed");
        if (name === "events:listPublicCalendarEventsWindowPaginated") {
          assert.deepEqual(args, { ...window, cursor });
          return {
            page: structuredClone(events), continueCursor: "event-zeka-publication-cursor-v1:materialized:next",
            isDone, rawPageCount: 1, scanLimitReached: false,
          };
        }
        assert.equal(name, "venues:listPublicVenueFieldsByIds");
        assert.ok(args.ids.length <= 50);
        assert.equal(new Set(args.ids).size, args.ids.length);
        return structuredClone(venues.filter((venue) => args.ids.includes(venue._id)));
      },
    },
  };
}

const fixture = context();
const result = await listWindow._handler(fixture.ctx, { ...window, venue: " Source Venue " });
assert.deepEqual(result.page, [
  { date: "2026-10-20", category: "live", venueValue: "id:venue-public", count: 2, legacyVenueMatchCount: 1 },
  { date: "2026-10-21", category: "event", venueValue: "id:venue-public", count: 1, legacyVenueMatchCount: 1 },
]);
assert.deepEqual(result.venues, [{
  value: "id:venue-public", label: "Current Venue", names: ["Current Venue", "Source Venue", "Stari lokal"], location: "Reviewed address",
}]);
assert.equal(resolvePublicEventVenueFilter("Source Venue", result.venues), "id:venue-public");
assert.equal(fixture.calls.length, 2, "One bounded public event page needs at most one deduplicated venue query.");
assert.equal(result.rawPageCount, 1);
assert.equal(result.scanLimitReached, false);
for (const field of ["_id", "title", "artists", "description", "hoursJson", "sourceCaption", "normalizedFieldsJson"]) {
  assert.ok(!JSON.stringify(result).includes(`"${field}"`), `Detailed field leaked: ${field}`);
}
for (const q of ["zeljko", "Stari lokal", "Current Venue", "Source Venue", "FIRST CONCERT"]) {
  const test = context({ events: [event] });
  const found = await listWindow._handler(test.ctx, { ...window, q });
  assert.equal(found.page[0].count, 1, `Missing title/artist/curated alias search: ${q}`);
}
const unmatched = context();
const noMatches = await listWindow._handler(unmatched.ctx, { ...window, q: "not present" });
assert.deepEqual(noMatches.page, []);
assert.equal(noMatches.venues.length, 1, "The venue selector must survive a search with no matches.");

const rejectedByAuthority = context({ events: [], venues: [], isDone: false });
const empty = await listWindow._handler(rejectedByAuthority.ctx, window);
assert.deepEqual(empty.page, []);
assert.deepEqual(empty.venues, []);
assert.equal(empty.isDone, false, "Do not terminate an empty but non-terminal visibility page.");
assert.equal(rejectedByAuthority.calls.length, 1, "Do not query venues for an empty authorized event page.");
const continuation = context({ cursor: empty.continueCursor });
await listWindow._handler(continuation.ctx, { ...window, cursor: empty.continueCursor });
assert.equal(continuation.calls[0].args.cursor, empty.continueCursor, "Publication cursors are opaque authority-owned tokens.");
const compatibilityCursor = "event-zeka-publication-cursor-v1:compatibility:older";
const compatibility = context({ events: Array.from({ length: 10 }, (_, index) => ({ ...event, _id: `legacy-${index}` })), cursor: compatibilityCursor });
const compatibilityResult = await listWindow._handler(compatibility.ctx, { ...window, cursor: compatibilityCursor });
assert.equal(compatibilityResult.page[0].count, 10);

for (const fail of ["events:listPublicCalendarEventsWindowPaginated", "venues:listPublicVenueFieldsByIds"]) {
  const failed = context({ fail });
  await assert.rejects(listWindow._handler(failed.ctx, window), /Authoritative public query failed/);
}
for (const bounds of [
  { fromDate: "2026-02-30", beforeDate: "2026-03-30" },
  { fromDate: "2026-10-01", beforeDate: "2026-12-01" },
  { fromDate: "2026-10-01", beforeDate: "2026-10-01" },
]) {
  const invalid = context();
  await assert.rejects(listWindow._handler(invalid.ctx, bounds), /1-45 days/);
  assert.equal(invalid.calls.length, 0);
}
const overflow = context({ events: Array.from({ length: 51 }, () => event) });
await assert.rejects(listWindow._handler(overflow.ctx, window), /50-row bound/);
assert.equal(overflow.calls.length, 1);
const fullPage = context({ events: Array.from({ length: 50 }, (_, index) => ({ ...event, venueId: `venue-${index}` })), venues: [] });
await listWindow._handler(fullPage.ctx, window);
assert.equal(fullPage.calls[1].args.ids.length, 50);

const unbound = context({ events: [{ ...event, venueId: undefined, venueAliases: ["Unsupported alias"] }] });
const legacy = await listWindow._handler(unbound.ctx, window);
assert.equal(legacy.venues[0].value, "name:source venue");
assert.deepEqual(legacy.venues[0].names, ["Source Venue"]);
assert.equal(unbound.calls.length, 1, "Unbound source rows must not trigger directory-wide identity guesses.");
const hidden = context({ events: [event], venues: [] });
const hiddenProjection = await listWindow._handler(hidden.ctx, window);
assert.equal(hiddenProjection.venues[0].value, "name:source venue", "Missing public venue fields must never retain an ID or private aliases.");
assert.deepEqual(event.venue, "Source Venue", "The adapter must not rewrite source fixtures.");
console.log("Standalone calendar overview QA passed: one read-only query, authoritative APIs, bounded cursors, 5 categories, search and venue identity.");
