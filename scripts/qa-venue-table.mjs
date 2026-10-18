import assert from "node:assert/strict";
import {
  DEFAULT_VENUE_TABLE_SORT,
  EMPTY_VENUE_TABLE_FILTERS,
  filterAndSortVenues,
  getVenueHoursState,
  getVenueMapState,
} from "../lib/admin/venue-table.ts";
import { getActiveVenueHoursRefreshTargets } from "../lib/venues/venue-hours-refresh.ts";
import { fetchVenueHoursPatch } from "../lib/venues/venue-hours-fetcher.ts";
import { classifyPublicVenue, buildVenueGapSnapshot } from "./export-public-venue-data-gaps.mjs";
import { validateVenueBulkPatch } from "../lib/admin/venue-bulk-edit.ts";

const now = Date.parse("2026-10-18T10:00:00Z");
const hours = (source) => JSON.stringify({ version: 1, source, timezone: "Europe/Belgrade", generatedAt: new Date(now).toISOString(), weekly: [{ day: 0, closed: true, windows: [] }] });
const base = { aliases: [], latitude: null, longitude: null, location: null, hoursSource: null, hoursJson: null, updatedAt: 1 };
const venues = [
  { ...base, id: "a", name: "Alpha", instagramHandle: "zalpha", category: "club", location: "Alpha Street", latitude: 44.8, longitude: 20.4, hoursSource: "manual", hoursJson: hours("manual"), publicStatus: "published", scrapeActive: true },
  { ...base, id: "b", name: "Bistro", instagramHandle: "xbistro", aliases: ["Bircafe"], category: "bar", location: "Beta Street", latitude: 0, longitude: 0, hoursSource: "google", hoursJson: hours("google"), publicStatus: "hidden", scrapeActive: false },
  { ...base, id: "c", name: "Collective", instagramHandle: "wcollective", category: "promoter", location: "Old organizer office", latitude: 44.9, longitude: 20.5, hoursSource: "google", hoursJson: hours("google"), publicStatus: "pending", scrapeActive: true },
  { ...base, id: "d", name: "Delta", instagramHandle: "ydelta", category: "venue", publicStatus: "pending", scrapeActive: false },
];
const original = structuredClone(venues);
const ids = (filters = {}, query = "", sort = DEFAULT_VENUE_TABLE_SORT) => filterAndSortVenues(venues, query, { ...EMPTY_VENUE_TABLE_FILTERS, ...filters }, sort).map(({ id }) => id);

for (const [filter, expected] of [
  [{ name: "bircaf\u00e9" }, ["b"]],
  [{ instagram: "@zalpha" }, ["a"]],
  [{ category: "promoter" }, ["c"]],
  [{ mapStatus: "present" }, ["a"]],
  [{ mapStatus: "missing" }, ["b", "d"]],
  [{ mapStatus: "not_applicable" }, ["c"]],
  [{ hours: "known" }, ["a", "b"]],
  [{ hours: "manual" }, ["a"]],
  [{ hours: "google" }, ["b"]],
  [{ hours: "osm" }, []],
  [{ hours: "missing" }, ["d"]],
  [{ hours: "not_applicable" }, ["c"]],
  [{ publication: "published" }, ["a"]],
  [{ publication: "hidden" }, ["b"]],
  [{ publication: "pending" }, ["c", "d"]],
  [{ scraping: "scraping" }, ["a", "c"]],
  [{ scraping: "paused" }, ["b", "d"]],
  [{ name: "Bircafe", instagram: "xbistro", category: "bar", mapStatus: "missing", hours: "google", publication: "hidden", scraping: "paused" }, ["b"]],
  [{ category: "promoter", mapStatus: "missing" }, []],
  [{ category: "promoter", mapStatus: "not_applicable", hours: "not_applicable" }, ["c"]],
]) assert.deepEqual(ids(filter), expected, `Column filters ${JSON.stringify(filter)}`);
assert.deepEqual(ids({ scraping: "scraping" }, "Alpha"), ["a"], "global and column filters combine");
assert.deepEqual(ids({}, "Beta Street"), ["b"], "global search retains physical venue addresses");
assert.deepEqual(ids({}, "Map missing"), ["d"], "global search retains displayed map status");
assert.deepEqual(ids({}, "Not applicable"), ["c"], "global search reflects visible promoter state rather than stale physical data");
assert.deepEqual(ids({}, "Old organizer office"), [], "promoter's historical office is not a physical venue search claim");

const orders = {
  name: [["a", "b", "c", "d"], ["d", "c", "b", "a"]],
  instagram: [["c", "b", "d", "a"], ["a", "d", "b", "c"]],
  category: [["b", "a", "c", "d"], ["d", "c", "a", "b"]],
  location: [["a", "b", "d", "c"], ["c", "d", "b", "a"]],
  hours: [["b", "a", "d", "c"], ["c", "d", "a", "b"]],
  publication: [["b", "c", "d", "a"], ["a", "c", "d", "b"]],
  scraping: [["a", "c", "b", "d"], ["b", "d", "a", "c"]],
};
for (const [column, [ascending, descending]] of Object.entries(orders)) {
  assert.deepEqual(ids({}, "", { column, direction: "asc" }), ascending, `${column} ascending`);
  assert.deepEqual(ids({}, "", { column, direction: "desc" }), descending, `${column} descending`);
}
assert.deepEqual(venues, original, "filtering and sorting never mutate venue records or original order");
assert.equal(getVenueMapState(venues[2]), "not_applicable");
assert.equal(getVenueHoursState(venues[2]), "not_applicable");
assert.equal(getVenueMapState(venues[1]), "missing", "0,0 is not a map location");
assert.equal(getVenueHoursState({ ...venues[0], hoursJson: "invalid" }), "missing");
assert.deepEqual(validateVenueBulkPatch({ category: "promoter" }), { category: "promoter" });

const promoter = { ...venues[2], _id: "c", publicStatus: "published" };
const physical = { ...venues[0], _id: "a" };
assert.deepEqual(getActiveVenueHoursRefreshTargets([promoter, physical]).map(({ _id }) => _id), ["a"], "promoter stays scrape-active but never enters hours enrichment");
let requests = 0;
assert.equal(await fetchVenueHoursPatch(promoter, { force: true, googleApiKey: "not-used", nominatimFetch: async () => { requests += 1; throw new Error("Must not fetch"); } }), null);
assert.equal(requests, 0, "even a forced refresh cannot bill an hours lookup for a promoter");
const row = classifyPublicVenue(promoter, now);
assert.equal(row.missingMapLocation, false);
assert.equal(row.missingOpeningHours, false);
assert.equal(row.partialOpeningHours, false);
assert.equal(row.mapStatus, "Nije primenljivo");
assert.equal(row.hoursStatus, "Nije primenljivo");
assert.equal(row.latitude, null);
assert.equal(row.weeklyHours, "");
const gaps = buildVenueGapSnapshot([promoter, physical], { now });
assert.equal(gaps.lists.missingMapLocation.some(({ id }) => id === "c"), false);
assert.equal(gaps.lists.missingOpeningHours.some(({ id }) => id === "c"), false);
console.log("Venue table QA passed: seven column filters and sortable columns in both directions, combined search, promoter N/A, safe bulk category, enrichment exclusion and missing-data exports.");
