import assert from "node:assert/strict";
import { matchesPublicEventNameArtistOrVenue } from "../lib/events/public-event-search.ts";

const baseEvent = {
  title: "",
  venue: "",
  artists: [],
  eventType: "nightlife",
  ticketPrice: "Free",
  description: "Late-night description text",
};

function makeEvent(overrides) {
  return {
    ...baseEvent,
    ...overrides,
  };
}

const event = makeEvent({
  title: "Žurka na krovu",
  venue: "Klub Drugstore",
  artists: ["Konstrakta", "DJ Brka"],
  eventType: "nightlife",
  ticketPrice: "2500 RSD",
  description: "Only the description mentions sunset jazz.",
});

assert.equal(
  matchesPublicEventNameArtistOrVenue(event, "zurka"),
  true,
  "Search should match the event name/title with Serbian diacritics folded.",
);
assert.equal(
  matchesPublicEventNameArtistOrVenue(event, "konstrakta"),
  true,
  "Search should match artist names.",
);
assert.equal(
  matchesPublicEventNameArtistOrVenue(event, "drugstore"),
  true,
  "Search should match venue names.",
);
assert.equal(
  matchesPublicEventNameArtistOrVenue(event, "nightlife"),
  false,
  "Search should not match event type; type remains a separate filter.",
);
assert.equal(
  matchesPublicEventNameArtistOrVenue(event, "2500"),
  false,
  "Search should not match ticket prices.",
);
assert.equal(
  matchesPublicEventNameArtistOrVenue(event, "sunset jazz"),
  false,
  "Search should stay scoped to event name, artists, and venue rather than description text.",
);
assert.equal(
  matchesPublicEventNameArtistOrVenue(event, "   "),
  true,
  "Blank search should include all events.",
);

const cyrillicVenueEvent = makeEvent({
  title: "Концерт на отвореном",
  venue: "Дом омладине",
  artists: ["DJ Šćepa & Friends"],
});

assert.equal(
  matchesPublicEventNameArtistOrVenue(cyrillicVenueEvent, "dom omladine"),
  true,
  "Search should match Cyrillic venue names using Latin input.",
);
assert.equal(
  matchesPublicEventNameArtistOrVenue(cyrillicVenueEvent, "dj scepa"),
  true,
  "Search should fold punctuation and Serbian Latin characters in artist names.",
);
assert.equal(
  matchesPublicEventNameArtistOrVenue(cyrillicVenueEvent, "!!!"),
  true,
  "Punctuation-only search normalizes to blank and should include all events.",
);

console.log("QA passed: public event search is scoped to event name, artist, and venue.");
