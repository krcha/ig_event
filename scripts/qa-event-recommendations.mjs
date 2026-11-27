import assert from "node:assert/strict";
import { localizeHref, resolveLocaleRequestPath } from "../i18n/config.ts";
import { getEventDiscoveryTaxonomy, getStoredOrLegacyEventTaxonomy } from "../lib/taxonomy/event-discovery.ts";
import { getEventRecommendationWindow, rankEventRecommendations } from "../lib/travel/event-recommendations.ts";
import { getCompassVenueType, getReviewedCompassVenueProfile } from "../lib/travel/venue-profile.ts";

const now = Date.parse("2026-11-27T21:00:00Z");
const event = (_id, title, genres, overrides = {}) => ({
  _id, title, date: "2026-11-28", time: "22:00-03:00", status: "approved",
  venue: "Fixture venue", artists: [], eventType: "nightlife", createdAt: 1, updatedAt: 1,
  eventTaxonomy: { primaryCategory: "party", categories: ["party"], formats: ["dj-set"], genres },
  ...overrides,
});

// Programme styles come from the actual dated fixture listings. Other names
// are test candidates; these cases make no claims about live availability.
const stellar = event("stellar", "Stellarcompanion at LIFT", ["house"], {
  venue: "LIFT", instagramPostUrl: "https://ra.co/events/2575951",
});
const timbe = event("timbe", "Timbe at LIFT", ["hip-hop", "rnb-soul", "disco-funk"], {
  date: "2026-10-10", venue: "LIFT", instagramPostUrl: "https://it.ra.co/events/2549034",
});
const house = event("house", "House evening", ["house"]);
const techno = event("techno", "Techno evening", ["techno"]);
const folk = event("folk", "Folk evening", ["folk"], {
  venue: "Druga Kuca",
  eventTaxonomy: { primaryCategory: "live", categories: ["live"], formats: ["concert"], genres: ["folk"] },
});
const estimate = event("estimate", "Estimated folk", ["folk"], { performerGenreResearch: { sources: [], estimated: true } });
const mixed = event("mixed", "House and folk", ["house", "folk"]);
const expired = event("ended", "Ended house set", ["house"], { date: "2026-11-27", time: "18:00-19:00" });
const pending = event("pending", "Pending house", ["house"], { status: "pending" });
const later = event("later", "Out of window house", ["house"], { date: "2026-12-12" });

const electro = rankEventRecommendations(stellar, [stellar, techno, house, folk, mixed, estimate, expired, pending, later], now);
assert.deepEqual(electro.same.map(({ event }) => event._id), ["house", "techno"]);
assert.deepEqual(electro.different.map(({ event }) => event._id), ["folk"]);
assert.ok(electro.same[0].match.score > electro.same[1].match.score);
assert.ok(electro.different[0].match.score < electro.same[1].match.score);
assert.deepEqual(getEventRecommendationWindow(stellar.date, now), { fromDate: "2026-11-28", beforeDate: "2026-12-12" });
assert.deepEqual(getEventRecommendationWindow(timbe.date, now), { fromDate: "2026-11-27", beforeDate: "2026-12-11" });

const rnb = event("rnb", "R&B and soul", ["rnb-soul"]);
assert.deepEqual(rankEventRecommendations(timbe, [timbe, stellar, rnb], now).same.map(({ event }) => event._id), ["rnb"]);
assert.deepEqual(rankEventRecommendations(event("unknown", "Unspecified DJ set", []), [stellar, rnb], now), { same: [], different: [] });

// Public summaries can carry usable evidence before a discovery label is saved.
const swing = event("swing", "Vous Ete's Swing", [], {
  eventTaxonomy: undefined, eventType: "live music", venue: "Bluz i Pivo", artists: ["Vous Ete's Swing"],
  description: "An evening of soul, jazz, blues, gospel and swing.",
});
assert.deepEqual(getEventDiscoveryTaxonomy(swing).genres, ["rnb-soul", "jazz-blues"]);
assert.deepEqual(getStoredOrLegacyEventTaxonomy(swing).genres, [], "Read-time evidence must not mark a missing durable enrichment as known.");
const jazz = event("jazz", "Announced jazz concert", ["jazz-blues"]);
const fromSummary = rankEventRecommendations(swing, [swing, jazz, techno], now);
assert.deepEqual(fromSummary.same.map(({ event, match }) => [event._id, match.score]), [["jazz", 94]]);
assert.deepEqual(fromSummary.different.map(({ event, match }) => [event._id, match.score]), [["techno", 20]]);
assert.deepEqual(rankEventRecommendations(jazz, [swing], now).same.map(({ match }) => match.score), [94]);
const filmFestival = { title: "32. ФЕСТИВАЛ АУТОРСКОГ ФИЛМА", eventType: "event",
  description: "Избор филмова из актуелног фестивалског програма; Мала сала." };
assert.deepEqual(getEventDiscoveryTaxonomy(filmFestival), {
  primaryCategory: "culture", categories: ["culture"], formats: ["festival"], genres: [],
});
assert.deepEqual(getEventDiscoveryTaxonomy({ title: "Чучук Стана последњи сат", eventType: "event",
  description: "Премијера представе; игра Драгица Ужарева." }).formats, ["theatre"]);
assert.deepEqual(getEventDiscoveryTaxonomy({ title: "VOLIM TE JOS", eventType: "nightlife",
  description: "All-night DJ program." }).formats, ["dj-set"]);
assert.deepEqual(getEventDiscoveryTaxonomy({ title: "Goran Korunović, Sara Arsenović", eventType: "arts & culture",
  description: "Book presentation; Goran Korunović participates and Sara Arsenović moderates." }).primaryCategory, "talk");
assert.deepEqual(getEventDiscoveryTaxonomy({ title: "Rock quiz", eventType: "nightlife",
  description: "Music quiz about rock." }), {
  primaryCategory: "participate", categories: ["participate"], formats: ["quiz"], genres: [],
});
const nameOnly = { eventType: "live music", title: "KYOTO JAZZ MASSIVE ft. EOANDO",
  artists: ["KYOTO JAZZ MASSIVE", "EOANDO"], venue: "Sinnerman Jazz Club",
  sourceCaption: "Friday DJ set: techno and house." };
assert.deepEqual(getEventDiscoveryTaxonomy(nameOnly).genres, []);
for (const description of ["Live jazz concert.", "Jazz live concert."]) {
  assert.deepEqual(getEventDiscoveryTaxonomy({ title: "Evening programme", eventType: "live music", description }), {
    primaryCategory: "live", categories: ["live"], formats: ["concert"], genres: ["jazz-blues"],
  });
}
assert.deepEqual(getEventDiscoveryTaxonomy({ title: "Evening programme", eventType: "event",
  description: "A quiz about a live jazz concert." }), {
  primaryCategory: "participate", categories: ["participate"], formats: ["quiz"], genres: [],
});
assert.deepEqual(getEventDiscoveryTaxonomy({ ...nameOnly, description: "No live music. Background jazz playlist." }).genres, []);
assert.deepEqual(getEventDiscoveryTaxonomy({ title: "Jazz live concert", eventType: "live music",
  description: "No jazz. We play rock music." }).genres, ["rock"]);
assert.deepEqual(getEventDiscoveryTaxonomy({ title: "Film festival", eventType: "arts & culture",
  description: "Film festival cancelled." }), {
  primaryCategory: "other", categories: ["other"], formats: [], genres: [],
});
assert.deepEqual(getEventDiscoveryTaxonomy({ title: "Film festival", eventType: "arts & culture",
  description: "Guest appearance cancelled. Film festival is going ahead." }).formats, ["festival"]);
assert.equal(getEventDiscoveryTaxonomy({ ...swing, eventTaxonomy: house.eventTaxonomy }), house.eventTaxonomy);

const ljubavnica = {
  _id: "k17dqbjstn1wtsxn9mhsj7d2h98gaw8p", instagramHandle: "@LJUBAVNICA_BAR",
  name: "Ljubavnica Bar", category: "bar",
};
assert.equal(getReviewedCompassVenueProfile(ljubavnica)?.source, "https://ljubicabgd.rs/ljubavnica/");
assert.equal(getCompassVenueType(ljubavnica), "cocktail-bar");
assert.equal(getCompassVenueType({ ...ljubavnica, _id: "different-floor", name: "Ljubica" }), "bar");
assert.equal(getCompassVenueType({ _id: "druga", name: "Kafana Druga Ku\u0107a", location: "Kara\u0111or\u0111eva 2, Beograd" }), "kafana");
assert.equal(getCompassVenueType({ _id: "different-restaurant", name: "Druga Ku\u0107a", location: "Makedonska 2" }), undefined);
assert.equal(getCompassVenueType({ _id: "unknown", name: "Cocktail Bar", category: "venue" }), undefined);

const path = "/next/event/k17w183xb0es3d37sqv8egrpgx8971pa";
assert.equal(localizeHref(path, "en"), `/en${path}`);
assert.deepEqual(resolveLocaleRequestPath(`/ru${path}`), { kind: "rewrite", locale: "ru", pathname: path });

console.log("Event recommendation QA passed: reference window, sourced genres, ranking, mixed and estimated programmes, public events, venue identity and localized routes.");
