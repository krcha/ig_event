import assert from "node:assert/strict";
import { buildRecentVenueMusicProfile, projectCompassPlaces, selectCompassProgramme } from "../lib/travel/compass-projection.ts";
import { compassCandidates, getCompassGenres, getCompassMusicBasis, matchesVibe } from "../lib/travel/compass.ts";

const now = Date.parse("2026-11-17T20:00:00Z"); // 21:00 Belgrade.
const hoursJson = JSON.stringify({ version: 1, timezone: "Europe/Belgrade", source: "manual", generatedAt: "2026-11-17T00:00:00Z", weekly: Array.from({ length: 7 }, (_, day) => ({ day, closed: false, windows: [{ day, start: "16:00", end: "04:00", spansNextDay: true }] })) });
const venue = (id, latitude = 44.815) => ({ _id: id, name: id, instagramHandle: id, latitude, longitude: 20.46, hoursJson, hoursSource: "manual", hoursTimezone: "Europe/Belgrade" });
const event = (id, genres, { date = "2026-11-17", time = "20:00", venueId = "source", category = "party", ...rest } = {}) => ({
  _id: id, title: id, date, time, venueId, venue: venueId, artists: ["Actual billed artist"], eventType: "party",
  status: "approved", createdAt: now - 1, updatedAt: now - 1,
  eventTaxonomy: { primaryCategory: category, categories: [category], genres, formats: [] }, ...rest,
});
const sourceEvent = event("House now", ["house"], { time: "20:00–22:00" });
const lateEvent = event("Rock later", ["rock"], { time: "23:00–04:00" });
const endedEvent = event("Jazz ended", ["jazz-blues"], { time: "17:00–19:00" });
assert.equal(selectCompassProgramme([lateEvent, endedEvent, sourceEvent], now)._id, sourceEvent._id);
const original = JSON.stringify([sourceEvent, lateEvent, endedEvent]);
let places = projectCompassPlaces([venue("source")], [lateEvent, endedEvent, sourceEvent], now);
assert.deepEqual(getCompassGenres(places[0]), ["house"], "A later lineup must not pollute the current programme.");
assert.equal(places[0].event.title, "House now");
assert.equal(getCompassMusicBasis(places[0]), "programme");
assert.equal(JSON.stringify([sourceEvent, lateEvent, endedEvent]), original, "Projection cannot mutate stored/public source objects.");
const futureOnly = projectCompassPlaces([venue("source")], [lateEvent], now)[0];
assert.deepEqual(getCompassGenres(futureOnly), [], "A future bill does not describe the current venue music.");

const history = [
  event("past-1", ["house"], { date: "2026-11-16" }),
  event("past-2", ["house"], { date: "2026-11-15" }),
  event("past-3", ["techno"], { date: "2026-11-14" }),
];
assert.equal(buildRecentVenueMusicProfile(history.slice(0, 2), now), undefined);
assert.equal(buildRecentVenueMusicProfile([history[0], history[0], history[0]], now), undefined, "Duplicates are not independent nights.");
const recent = buildRecentVenueMusicProfile(history, now);
assert.equal(recent.basis, "recent");
assert.equal(recent.eventCount, 3);
assert.deepEqual(recent.sources.map(row => row.eventId), ["past-1", "past-2", "past-3"]);
assert.equal(buildRecentVenueMusicProfile(history.map(row => ({ ...row, date: "2026-10-01" })), now), undefined);
assert.equal(buildRecentVenueMusicProfile([...history.slice(0, 2), event("unknown-1", [], { date: "2026-11-13" }), event("unknown-2", [], { date: "2026-11-12" })], now), undefined,
  "Unknown nights count against the coverage of a typical profile.");
places = projectCompassPlaces([venue("source"), venue("other")], [...history, sourceEvent], now);
assert.deepEqual(getCompassGenres(places[0]), ["house"], "Current programme evidence overrides the historical context.");
assert.deepEqual(getCompassGenres(places[1]), [], "Canonical venue IDs isolate profiles.");
const historicalSource = projectCompassPlaces([venue("source")], history, now)[0];
assert.equal(getCompassMusicBasis(historicalSource), "recent");
assert.equal(historicalSource.event, undefined);
assert.ok(getCompassGenres(historicalSource).includes("house"));
const futureWithHistory = projectCompassPlaces([venue("source")], [...history, lateEvent], now)[0];
assert.equal(getCompassMusicBasis(futureWithHistory), "recent");
assert.ok(!getCompassGenres(futureWithHistory).includes("rock"));
const knownNonMusic = projectCompassPlaces([venue("source")], [...history, event("Film now", [], { category: "culture" })], now)[0];
assert.deepEqual(getCompassGenres(knownNonMusic), [], "An announced film cannot inherit past music.");
assert.equal(getCompassMusicBasis(knownNonMusic), "programme");
const estimated = projectCompassPlaces([venue("source")], [event("estimated", ["house"], { performerGenreResearch: { estimated: true, sources: [] } })], now)[0];
assert.equal(estimated.musicProfile.evidence, "estimate");
const researched = projectCompassPlaces([venue("source")], [event("researched", ["house"], { performerGenreResearch: { sources: [{ performer: "Actual billed artist", url: "https://example.com/artist" }] } })], now)[0];
assert.equal(researched.musicProfile.evidence, "research");

const currentCandidates = projectCompassPlaces([venue("near", 44.816), venue("far", 44.82)], [
  event("near-rock", ["rock"], { venueId: "near" }), event("far-rock", ["rock"], { venueId: "far" }),
], now);
const origin = { latitude: 44.815, longitude: 20.46 };
assert.deepEqual(compassCandidates(currentCandidates.reverse(), historicalSource, origin, "different", now).map(place => place.id), ["near", "far"]);
assert.equal(matchesVibe(historicalSource, currentCandidates[0], "different"), true);
assert.equal(compassCandidates([{ ...currentCandidates[0], musicProfile: { ...currentCandidates[0].musicProfile, basis: "recent" } }], historicalSource, origin, "different", now).length, 0,
  "Historical context alone cannot establish a destination's current programme.");
assert.equal(compassCandidates([{ ...currentCandidates[0], event: { ...currentCandidates[0].event, time: "23:00" } }], historicalSource, origin, "different", now).length, 0);
const hybrid = { ...currentCandidates[0], musicProfile: { ...currentCandidates[0].musicProfile, genres: ["house", "rock"] } };
assert.equal(matchesVibe(historicalSource, hybrid, "different"), false, "A mixed programme is not completely contrasting.");
const nearbyOnly = projectCompassPlaces([venue("nearby-only", 44.816)], [], now)[0];
assert.deepEqual(compassCandidates([nearbyOnly], historicalSource, origin, "nearby", now).map(place => place.id), ["nearby-only"]);
console.log("Compass programme QA passed: individual bills, current evidence/provenance, bounded historical context, unknown coverage, venue isolation, genre comparison and open/arrival distance order.");
