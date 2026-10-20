import assert from "node:assert/strict";
import {
  CANONICAL_EVENT_TYPES,
  CANONICAL_VENUE_CATEGORIES,
  canonicalizeEventType,
  canonicalizeVenueCategory,
  cultureSubtypeFor,
  eventTypeFromVenueCategory,
  mainCategoryForEventType,
} from "../lib/taxonomy/venue-types.ts";

function runEventTypeQa() {
  assert.ok(
    CANONICAL_EVENT_TYPES.length <= 6,
    "Event types should be consolidated to a small set of main public types.",
  );

  assert.equal(canonicalizeEventType("club night"), "nightlife");
  assert.equal(canonicalizeEventType("DJ set"), "nightlife");
  assert.equal(canonicalizeEventType("party"), "nightlife");
  assert.equal(canonicalizeEventType("concert"), "live music");
  assert.equal(canonicalizeEventType("gig"), "live music");
  assert.equal(canonicalizeEventType("exhibition"), "arts & culture");
  assert.equal(canonicalizeEventType("screening"), "arts & culture");
  assert.equal(canonicalizeEventType("theater"), "arts & culture");
  assert.equal(canonicalizeEventType("talk"), "learning");
  assert.equal(canonicalizeEventType("workshop"), "learning");
  assert.equal(canonicalizeEventType("bazaar"), "food & market");
  assert.equal(canonicalizeEventType("festival"), "nightlife");
  assert.equal(canonicalizeEventType("zur"), "nightlife");
  assert.equal(canonicalizeEventType("\u0436\u0443\u0440\u043a\u0430"), "nightlife");
  assert.equal(canonicalizeEventType("nastup"), "live music");
  assert.equal(canonicalizeEventType("predstava"), "arts & culture");
  assert.equal(canonicalizeEventType("predavanje"), "learning");
  assert.equal(canonicalizeEventType("pijaca"), "food & market");
  assert.equal(canonicalizeEventType(""), "event");
  assert.equal(canonicalizeEventType("one-off happening"), "event");
}

function runVenueCategoryQa() {
  assert.ok(
    CANONICAL_VENUE_CATEGORIES.length <= 6,
    "Venue categories should stay limited to a few main venue types.",
  );

  assert.equal(canonicalizeVenueCategory("night club"), "club");
  assert.equal(canonicalizeVenueCategory("discotheque"), "club");
  assert.equal(canonicalizeVenueCategory("cocktail bar"), "bar");
  assert.equal(canonicalizeVenueCategory("pub"), "bar");
  assert.equal(canonicalizeVenueCategory("cafe"), "restaurant/cafe");
  assert.equal(canonicalizeVenueCategory("kafana"), "restaurant/cafe");
  assert.equal(canonicalizeVenueCategory("cultural center"), "culture");
  assert.equal(canonicalizeVenueCategory("kulturni centar"), "culture");
  assert.equal(canonicalizeVenueCategory("gallery"), "gallery");
  assert.equal(canonicalizeVenueCategory("museum"), "gallery");
  assert.equal(canonicalizeVenueCategory(""), "venue");
  assert.equal(canonicalizeVenueCategory("event space"), "venue");
}

function runDisplayCategoryQa() {
  assert.equal(mainCategoryForEventType("nightlife"), "club");
  assert.equal(mainCategoryForEventType("live music"), "live");
  assert.equal(mainCategoryForEventType("arts & culture"), "culture");
  assert.equal(mainCategoryForEventType("learning"), "day");
  assert.equal(mainCategoryForEventType("food & market"), "day");
  assert.equal(mainCategoryForEventType("event"), "other");

  assert.equal(eventTypeFromVenueCategory("club"), "nightlife");
  assert.equal(eventTypeFromVenueCategory("gallery"), "arts & culture");
  assert.equal(eventTypeFromVenueCategory("culture"), "arts & culture");
  assert.equal(eventTypeFromVenueCategory("restaurant/cafe"), "food & market");
  assert.equal(eventTypeFromVenueCategory("bar"), "event");
  assert.equal(eventTypeFromVenueCategory("venue"), "event");
  assert.equal(eventTypeFromVenueCategory("cinema"), "arts & culture");

  assert.equal(
    cultureSubtypeFor({ title: "Predstava", venue: "Atelje", venueCategory: null }),
    "stage",
  );
  assert.equal(
    cultureSubtypeFor({ title: "Film screening", venue: "Dvorana", venueCategory: null }),
    "screen",
  );
  assert.equal(
    cultureSubtypeFor({ title: "Izlozba", venue: "Salon", venueCategory: null }),
    "art",
  );
  assert.equal(
    cultureSubtypeFor({ title: "Program", venue: "Culture center", venueCategory: "culture" }),
    "stage",
  );
  assert.equal(
    cultureSubtypeFor({ title: "Program", venue: "Cinema", venueCategory: "cinema" }),
    "screen",
  );
  assert.equal(
    cultureSubtypeFor({ title: "Program", venue: "Gallery", venueCategory: "gallery" }),
    "art",
  );
  assert.equal(
    cultureSubtypeFor({ title: "Open night", venue: "Bar", venueCategory: "bar" }),
    null,
  );
}

runEventTypeQa();
runVenueCategoryQa();
runDisplayCategoryQa();

console.log("QA passed: venue/event type taxonomy is consolidated.");
