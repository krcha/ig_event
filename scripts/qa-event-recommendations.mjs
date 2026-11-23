import assert from "node:assert/strict";
import { localizeHref, resolveLocaleRequestPath } from "../i18n/config.ts";
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
