import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildVenueLifecycleMigrationPlan,
  buildVenueLifecycleRollbackManifest,
  getEffectiveVenueLifecycle,
  isVenuePublic,
  isVenueScrapeActive,
} from "../lib/venues/venue-lifecycle.ts";
import {
  sanitizeVenueLinkedPublicEventFields,
  VENUE_LINKED_PUBLIC_EVENT_FIELDS,
} from "../lib/events/public-event-venue-fields.ts";

const stateMatrix = [
  {
    label: "legacy active remains scrape-active and published",
    input: { isActive: true },
    scrapeActive: true,
    publicStatus: "published",
    public: true,
  },
  {
    label: "legacy inactive remains scrape-paused and hidden",
    input: { isActive: false },
    scrapeActive: false,
    publicStatus: "hidden",
    public: false,
  },
  {
    label: "missing legacy state fails closed",
    input: {},
    scrapeActive: false,
    publicStatus: "hidden",
    public: false,
  },
  {
    label: "discovered candidate is scrape-active but pending",
    input: { scrapeActive: true, publicStatus: "pending" },
    scrapeActive: true,
    publicStatus: "pending",
    public: false,
  },
  {
    label: "hidden source can keep scraping",
    input: { scrapeActive: true, publicStatus: "hidden" },
    scrapeActive: true,
    publicStatus: "hidden",
    public: false,
  },
  {
    label: "published source can pause scraping",
    input: { scrapeActive: false, publicStatus: "published" },
    scrapeActive: false,
    publicStatus: "published",
    public: true,
  },
  {
    label: "explicit state wins over legacy active",
    input: { isActive: true, scrapeActive: false, publicStatus: "hidden" },
    scrapeActive: false,
    publicStatus: "hidden",
    public: false,
  },
];

for (const fixture of stateMatrix) {
  const effective = getEffectiveVenueLifecycle(fixture.input);
  assert.equal(effective.scrapeActive, fixture.scrapeActive, fixture.label);
  assert.equal(effective.publicStatus, fixture.publicStatus, fixture.label);
  assert.equal(isVenueScrapeActive(fixture.input), fixture.scrapeActive, fixture.label);
  assert.equal(isVenuePublic(fixture.input), fixture.public, fixture.label);
}

const venueLeakageEvent = {
  _id: "event-with-private-venue",
  title: "Event remains public",
  venue: "Private Venue Name",
  sourceCaption: "Exact source caption must remain available.",
  venueCategory: "club",
  venueHours: { hoursJson: "secret-hours" },
  venueId: "private-venue-id",
  venueInstagramHandle: "private.handle",
  venueLatitude: 44.8125,
  venueLocation: "Private location",
  venueLongitude: 20.4612,
};
const privateVenueFixtures = [
  {
    label: "new pending venue",
    venue: { scrapeActive: true, publicStatus: "pending" },
  },
  {
    label: "legacy-active venue explicitly hidden",
    venue: { isActive: true, publicStatus: "hidden" },
  },
];
for (const fixture of privateVenueFixtures) {
  const sanitized = sanitizeVenueLinkedPublicEventFields(
    venueLeakageEvent,
    isVenuePublic(fixture.venue),
  );
  assert.equal(sanitized._id, venueLeakageEvent._id, `${fixture.label}: preserve event`);
  assert.equal(
    sanitized.sourceCaption,
    venueLeakageEvent.sourceCaption,
    `${fixture.label}: preserve source caption`,
  );
  assert.equal(sanitized.venue, venueLeakageEvent.venue, `${fixture.label}: preserve venue text`);
  for (const field of VENUE_LINKED_PUBLIC_EVENT_FIELDS) {
    assert.equal(field in sanitized, false, `${fixture.label}: remove ${field}`);
  }
}

const migrationPlan = buildVenueLifecycleMigrationPlan([
  { _id: "legacy-on", instagramHandle: "legacy.on", isActive: true },
  { _id: "legacy-off", instagramHandle: "legacy.off", isActive: false },
  {
    _id: "partial",
    instagramHandle: "partial",
    isActive: true,
    scrapeActive: false,
  },
  {
    _id: "explicit",
    instagramHandle: "explicit",
    isActive: true,
    scrapeActive: true,
    publicStatus: "pending",
  },
]);
assert.deepEqual(migrationPlan.counts, {
  alreadyExplicit: 1,
  legacyActiveFalse: 1,
  legacyActiveMissing: 0,
  legacyActiveTrue: 3,
  needsMigration: 3,
  scanned: 4,
  targetHidden: 1,
  targetPending: 1,
  targetPublished: 2,
  targetScrapeActive: 2,
  targetScrapePaused: 2,
});
assert.deepEqual(migrationPlan.changes[0], {
  id: "legacy-on",
  instagramHandle: "legacy.on",
  before: { isActive: true },
  apply: { scrapeActive: true, publicStatus: "published" },
  rollback: { isActive: true, scrapeActive: null, publicStatus: null },
});
assert.deepEqual(migrationPlan.changes[2].apply, {
  scrapeActive: false,
  publicStatus: "published",
});

const schemaSource = readFileSync("convex/schema.ts", "utf8");
const venuesSource = readFileSync("convex/venues.ts", "utf8");
const usersSource = readFileSync("convex/users.ts", "utf8");
const eventDetailSource = readFileSync("app/(main)/events/[eventId]/page.tsx", "utf8");
const publicEventsSource = readFileSync("lib/events/public-events.ts", "utf8");
const adminRouteSource = readFileSync("app/api/admin/venues/route.ts", "utf8");
const adminUiSource = readFileSync("components/admin/venue-manager.tsx", "utf8");
const migrationSource = readFileSync("scripts/migrate-venue-lifecycle.mjs", "utf8");

for (const field of ["scrapeActive", "publicStatus"]) {
  assert.ok(schemaSource.includes(field), `Venue schema should include ${field}.`);
}
assert.match(schemaSource, /venueAuditLog:\s*defineTable/);
assert.match(schemaSource, /beforeJson:\s*v\.string\(\)/);
assert.match(schemaSource, /afterJson:\s*v\.string\(\)/);

assert.match(venuesSource, /export const listScrapeActiveVenues = query/);
assert.match(venuesSource, /isVenueScrapeActive/);
for (const publicQuery of [
  "listPublicVenueFieldsByIds",
  "listPublicVenueFields",
  "getPublicVenuePage",
  "listPublicVenueDirectory",
]) {
  assert.match(
    venuesSource,
    new RegExp(`export const ${publicQuery} = query[\\s\\S]*?(?:isVenuePublic|collectPublicVenues)`),
    `${publicQuery} must fail closed for pending and hidden venues.`,
  );
}
assert.match(usersSource, /favoriteVenues[\s\S]*isVenuePublic/);
assert.match(usersSource, /toggleFavoriteVenueForUser[\s\S]*isVenuePublic/);
assert.match(eventDetailSource, /event\.venueId = venue\?\._id/);
assert.match(publicEventsSource, /publicVenueIds/);
assert.match(publicEventsSource, /publicVenueIds\.has\(event\.venueId/);

for (const value of ["scrapeActive", "publicStatus", "Scraping", "Publication"]) {
  assert.ok(adminRouteSource.includes(value) || adminUiSource.includes(value));
}
assert.match(venuesSource, /venue\.scrape_activation\.changed/);
assert.match(venuesSource, /venue\.public_status\.changed/);
assert.match(venuesSource, /beforeJson/);
assert.match(venuesSource, /afterJson/);

assert.match(migrationSource, /(?:dryRun:\s*!apply|const dryRun = !apply)/);
assert.match(migrationSource, /--backup-reference/);
assert.match(migrationSource, /--confirm/);
assert.match(migrationSource, /APPLY_VENUE_LIFECYCLE/);
assert.match(migrationSource, /rollbackManifest/);

console.log("Venue lifecycle state-matrix and leakage QA passed.");
