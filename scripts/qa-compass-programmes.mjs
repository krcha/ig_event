import assert from "node:assert/strict";
import { getCompassView, requestOutingPart } from "../lib/travel/outing-request.ts";
import { compactCompassHoursJson } from "../lib/venues/venue-hours-cache.ts";
import { getEventDiscoveryTaxonomy } from "../lib/taxonomy/event-discovery.ts";
import { sortPublicEventsByDateVenueTimeTitle } from "../lib/events/public-event-sort.ts";
import { buildRecentVenueMusicProfile, projectCompassPlaces, projectOutingDirectory, projectOutingProgrammes, selectCompassProgramme } from "../lib/travel/compass-projection.ts";
import { compassCandidates, getCompassGenres, getCompassMusicBasis, getCompassSourceAt, getCompassSourceProgrammes, matchesVibe } from "../lib/travel/compass.ts";

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
assert.equal(compassCandidates([{ ...currentCandidates[0], programmes: undefined, musicProfile: { ...currentCandidates[0].musicProfile, basis: "recent" } }], historicalSource, origin, "different", now).length, 0,
  "Historical context alone cannot establish a destination's current programme.");
assert.equal(compassCandidates([{ ...currentCandidates[0], programmes: undefined, event: { ...currentCandidates[0].event, time: "23:00" } }], historicalSource, origin, "different", now).length, 0);
const hybrid = { ...currentCandidates[0], musicProfile: { ...currentCandidates[0].musicProfile, genres: ["house", "rock"] } };
assert.equal(matchesVibe(historicalSource, hybrid, "different"), false, "A mixed programme is not completely contrasting.");
const nearbyOnly = projectCompassPlaces([venue("nearby-only", 44.816)], [], now)[0];
assert.deepEqual(compassCandidates([nearbyOnly], historicalSource, origin, "nearby", now).map(place => place.id), ["nearby-only"]);

// Reviewed Belgrade venues and representative programme styles. The times,
// distances and availability below are fixture values, not actual listings.
const ljubavnica = { ...venue("k17dqbjstn1wtsxn9mhsj7d2h98gaw8p"), name: "Ljubavnica", instagramHandle: "ljubavnica_bar", category: "bar" };
const riddle = { ...venue("k177m0m9karm9rpygqnw7zayds8966ek", 44.817), name: "Riddle Bar", instagramHandle: "riddlebarbelgrade", category: "bar" };
const loro = { ...venue("k17a22381tkddgmwreq2rcqpr5896j00", 44.820), name: "Loro", instagramHandle: "lorobarbelgrade", category: "bar" };
const club = { ...venue("k17cp35s3e07ebpthy4m4trf01896hwv", 44.816), name: "20/44", instagramHandle: "20_44.nightclub", category: "club" };
const kafana = { ...venue("druga", 44.817), name: "Druga Kuća", location: "Karađorđeva 2", category: "restaurant/cafe" };
const genericBar = { ...venue("generic-bar", 44.8151), category: "bar" };
const cocktailWithTechno = { ...venue("cocktails-with-techno", 44.8155), category: "cocktail bar" };

const venueDeck = projectCompassPlaces([ljubavnica, riddle, loro, club, kafana, genericBar, cocktailWithTechno], [
  event("techno at the cocktail bar", ["techno"], { venueId: cocktailWithTechno._id }),
], now);
const [cocktailSource] = venueDeck;
const cocktails = compassCandidates(venueDeck, cocktailSource, origin, "same", now);
assert.deepEqual(cocktails.map(place => place.name), ["Riddle Bar", "Loro"], "A nearby generic bar or busy techno programme cannot outrank a cocktail bar.");
assert.equal(cocktails[0].recommendation.reason, "same-venue-type");
assert.equal(cocktails[0].recommendation.basis, "venue");
assert.equal(cocktails[0].event, undefined);
assert.equal(cocktails[0].openNow, true);
assert.deepEqual(compassCandidates(venueDeck, cocktailSource, origin, "different", now)
  .find(place => place.id === kafana._id).recommendation, { score: 29, reason: "contrast-venue-type", basis: "venue", programmeTiming: undefined });

const houseAtClub = event("20/44 house set", ["house"], { venueId: club._id, time: "20:00–23:00" });
const folkAtKafana = event("Narodna muzika at Druga Kuća", ["folk"], { venueId: kafana._id });
const technoElsewhere = event("Techno set", ["techno"], { venueId: "near-techno" });
const houseElsewhere = event("House set", ["house"], { venueId: "far-house" });
const crossover = event("House and narodna crossover", ["house", "folk"], { venueId: "crossover" });
const electronicDeck = projectCompassPlaces([club, kafana, venue("near-techno", 44.816), venue("far-house", 44.82),
  { ...venue("crossover"), category: "kafana" }, venue("genre-only-folk", 44.8155)], [houseAtClub,
  folkAtKafana, technoElsewhere, houseElsewhere, crossover, event("Nearby folk", ["folk"], { venueId: "genre-only-folk" })], now);
const [electronicSource] = electronicDeck;
assert.deepEqual(compassCandidates(electronicDeck, electronicSource, origin, "same", now)
  .map(({ recommendation }) => recommendation.reason), ["same-genre", "related-genre"], "Exact house precedes nearby related techno.");
assert.deepEqual(compassCandidates(electronicDeck, electronicSource, origin, "different", now)
  .map(({ recommendation }) => recommendation.reason), ["contrast-genre-and-venue", "contrast-genre"], "The verified kafana with folk outranks a closer generic folk programme, and crossover is excluded.");
assert.deepEqual(compassCandidates(venueDeck, electronicSource, origin, "different", now)
  .find(place => place.name === "Druga Kuća").recommendation.reason, "contrast-venue-type");

const timbe = event("Timbe R&B and soul night", ["rnb-soul"], { venueId: "timbe", artists: ["Timbe"] });
const rnbDeck = projectCompassPlaces([venue("timbe"), venue("near-rap", 44.8155), venue("far-rnb", 44.819), venue("unknown-rnb-time", 44.8151)], [
  timbe, event("Rap night", ["hip-hop"], { venueId: "near-rap" }),
  event("Contemporary R&B", ["rnb-soul"], { venueId: "far-rnb" }),
  event("R&B without confirmed start time", ["rnb-soul"], { venueId: "unknown-rnb-time", timeStatus: "unknown" }),
], now);
const rnbResults = compassCandidates(rnbDeck, rnbDeck[0], origin, "same", now);
assert.deepEqual(rnbResults.map(place => place.id), ["far-rnb", "near-rap", "unknown-rnb-time"]);
assert.equal(rnbResults[2].recommendation.programmeTiming, "unknown-start");

const switchDeck = projectCompassPlaces([venue("source"), venue("switch", 44.818), venue("expired-hours", 44.818)], [sourceEvent,
  event("Old techno set", ["techno"], { venueId: "switch", time: "20:00–21:02" }),
  event("Folk on arrival", ["folk"], { venueId: "switch", time: "21:03–23:00" }),
], now);
switchDeck[2].hours.hoursExpiresAt = now + 60_000;
assert.equal(compassCandidates(switchDeck, switchDeck[0], origin, "same", now).length, 0, "A compatible programme ending before arrival is unavailable.");
assert.equal(compassCandidates(switchDeck, switchDeck[0], origin, "different", now)[0].event.id, "Folk on arrival");
assert.deepEqual(compassCandidates(switchDeck, switchDeck[0], origin, "nearby", now).map(place => place.id), ["switch"]);

const openingHoursJson = hoursJson.replaceAll('"start":"16:00"', '"start":"21:03"');
const openingDeck = projectCompassPlaces([venue("source"), { ...venue("opens-by-arrival", 44.818), hoursJson: openingHoursJson }], [sourceEvent,
  event("Techno from opening", ["techno"], { venueId: "opens-by-arrival", time: "21:03–23:00" }),
], now);
assert.equal(compassCandidates(openingDeck, openingDeck[0], origin, "same", now)[0].openNow, false);
assert.deepEqual(compassCandidates(openingDeck, openingDeck[0], origin, "nearby", now), []);

const overlapping = event("Another active programme", ["rock"], { time: "20:30–23:00" });
const [programmeOptions] = projectCompassPlaces([venue("source")], [sourceEvent, lateEvent, overlapping], now);
assert.deepEqual(getCompassSourceProgrammes(programmeOptions, now).map(programme => programme.id), [overlapping._id, sourceEvent._id]);
assert.deepEqual(getCompassGenres(getCompassSourceAt(programmeOptions, now)), ["rock"]);
assert.deepEqual(getCompassGenres(getCompassSourceAt(programmeOptions, now, { eventId: sourceEvent._id })), ["house"]);
assert.equal(getCompassSourceAt(programmeOptions, now, "venue").event, undefined);
assert.equal(getCompassSourceAt(programmeOptions, now, { eventId: lateEvent._id }).event, undefined);
assert.deepEqual(getCompassGenres(getCompassSourceAt(programmeOptions, Date.parse("2026-11-17T22:30:00Z"))), ["rock"]);

const beforeMidnight = Date.parse("2026-11-17T22:58:00Z"); // 23:58 Belgrade.
const midnightDeck = projectCompassPlaces([club, venue("next-day", 44.818)], [houseAtClub,
  event("Techno after midnight", ["techno"], { venueId: "next-day", date: "2026-11-18", time: "00:01–03:00" }),
], beforeMidnight);
assert.equal(compassCandidates(midnightDeck, midnightDeck[0], origin, "same", beforeMidnight).length, 0,
  "The expired source programme should not carry its genre across midnight.");
const activeOvernightClub = { ...houseAtClub, time: "20:00–04:00" };
const midnightProgrammeDeck = projectCompassPlaces([club, venue("next-day", 44.818)], [activeOvernightClub,
  event("Techno after midnight", ["techno"], { venueId: "next-day", date: "2026-11-18", time: "00:01–03:00" }),
], beforeMidnight);
assert.equal(compassCandidates(midnightProgrammeDeck, midnightProgrammeDeck[0], origin, "same", beforeMidnight)[0].event.id, "Techno after midnight");
const lateProgramme = event("House until eight", ["house"], { venueId: "source", time: "23:00-08:00" });
const afterRollover = Date.parse("2026-11-18T06:15:00Z");
const lateDeck = projectCompassPlaces([venue("source")], [lateProgramme], afterRollover);
assert.equal(getCompassSourceAt(lateDeck[0], afterRollover).event?.id, "House until eight",
  "An explicit end time takes precedence over the morning outing rollover.");
assert.equal(getCompassSourceAt(lateDeck[0], Date.parse("2026-11-18T07:00:00Z")).event, undefined);
// The fast geographic picker arrives before the programme window. Once joined,
// both projections must choose exactly the same sources and ranked destinations.
const testVenues = [club, kafana, venue("source"), venue("near-rock"), venue("far-house")];
const closure = { verified: true, status: "temporarily_closed", checkedAt: "2026-11-12T10:00:00Z", sourceUrls: ["https://example.com/venue"] };
const enrichedHours = JSON.stringify({ ...JSON.parse(hoursJson), raw: { operatingStatus: closure, result: { internal: "not used" } } });
testVenues.push({ ...venue("closed"), hoursJson: enrichedHours });
const sorted = sortPublicEventsByDateVenueTimeTitle([houseAtClub, folkAtKafana, sourceEvent, lateEvent, endedEvent,
  houseElsewhere, { ...event("sourced", ["rock"], { venueId: "near-rock" }), performerGenreResearch: { sources: [{ url: "https://example.com/act" }] } },
  { ...event("unknown time", ["house"], { venueId: "far-house", timeStatus: "unknown" }), performerGenreResearch: { estimated: true, sources: [] } }]);
const compact = sorted.map(row => ({ _id: row._id, title: row.title, venueId: row.venueId, venue: row.venue, date: row.date,
  time: row.time, timeStatus: row.timeStatus, eventTaxonomy: getEventDiscoveryTaxonomy(row),
  genreEstimated: row.performerGenreResearch?.estimated === true, genreResearched: Boolean(row.performerGenreResearch?.sources.length) }));
const split = new Map(projectOutingProgrammes(compact, now).map(group => [group.venueId, group.programmes]));
const newDeck = projectOutingDirectory(testVenues.map(place => ({ ...place, hoursJson: compactCompassHoursJson(place.hoursJson) })))
  .map(place => ({ ...place, programmes: split.get(place.id) ?? [] }));
const fullDeck = projectCompassPlaces(testVenues, sorted, now);
assert.deepEqual(newDeck.map(place => place.id), fullDeck.map(place => place.id));
assert.deepEqual(JSON.parse(newDeck.at(-1).hours.hoursJson).raw, { operatingStatus: closure });
assert.equal(compactCompassHoursJson("invalid"), undefined);
for (const [i, place] of fullDeck.entries()) {
  assert.deepEqual(newDeck[i].programmes, place.programmes);
  assert.deepEqual(getCompassSourceAt(newDeck[i], now).musicProfile, getCompassSourceAt(place, now).musicProfile);
  for (const mode of ["same", "different", "nearby"]) {
    const output = ({ id, event, recommendation, hoursLabel, openNow }) => [id, event?.id, recommendation, hoursLabel, openNow];
    assert.deepEqual(compassCandidates(newDeck, getCompassSourceAt(newDeck[i], now), origin, mode, now).map(output),
      compassCandidates(fullDeck, getCompassSourceAt(place, now), origin, mode, now).map(output));
  }
}
// The chooser remains usable immediately after confirming a place. A selection
// can wait or retry without running the ranker on an incomplete programme.
for (const status of ["loading", "error", "ready"]) {
  assert.equal(getCompassView("confirm", status, false), "confirm");
  assert.equal(getCompassView("vibe", status, true), "vibe");
}
for (const status of ["loading", "error"]) assert.equal(getCompassView("results", status, false), "programme-status");
assert.equal(getCompassView("results", "ready", true), "music-status");
assert.equal(getCompassView("results", "ready", false), "results");
// A stalled listing request must reach retry, and a revoked location or
// unmounted screen must suppress late success/error updates.
const requests = [];
function pendingFetch(url, { signal }) {
  return new Promise((resolve, reject) => {
    requests.push({ url, signal, resolve });
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}
await new Promise(resolve => requestOutingPart("places", () => assert.fail("timeout resolved"), resolve, { fetcher: pendingFetch, timeoutMs: 5 }));
assert.equal(requests[0].url, "/api/travel/places");
assert.equal(requests[0].signal.aborted, true);
// Some mobile fetch layers stay pending after abort. A failed part still exposes
// a retry by its deadline, exactly once, and suppresses any subsequent reply.
let settleLate, stallErrors = 0;
await new Promise(resolve => requestOutingPart("programmes", () => assert.fail("late data was applied"), () => {
  stallErrors++; resolve();
}, { timeoutMs: 5, fetcher: () => new Promise(resolve => { settleLate = resolve; }) }));
settleLate(Response.json({ programmes: [] }));
await new Promise(resolve => setImmediate(resolve));
assert.equal(stallErrors, 1);
const updates = [];
const dispose = requestOutingPart("programmes", value => updates.push(value), () => updates.push("error"), { fetcher: pendingFetch });
dispose();
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(updates, []);
assert.equal(requests[1].url, "/api/travel/places?view=programmes");
const retried = await new Promise((resolve, reject) => {
  requestOutingPart("places", resolve, reject, { fetcher: pendingFetch });
  requests.at(-1).resolve(Response.json({ places: [{ id: "restored" }] }));
});
assert.deepEqual(retried, [{ id: "restored" }]);
console.log("Compass programme QA passed: time-specific programme selection, venue profiles, genre and outing contrast, evidence and arrival eligibility.");
