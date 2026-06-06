import assert from "node:assert/strict";
import {
  CANONICAL_EVENT_TYPES,
  CANONICAL_VENUE_CATEGORIES,
  canonicalizeEventType,
  canonicalizeVenueCategory,
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

runEventTypeQa();
runVenueCategoryQa();

console.log("QA passed: venue/event type taxonomy is consolidated.");
