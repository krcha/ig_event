import assert from "node:assert/strict";
import "./qa-public-calendar-overview-loader.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ConvexHttpClient } from "convex/browser";
import {
  loadPublicCalendarEventsWindow,
  loadPublicEventsWindowPage,
} from "../lib/events/public-events.ts";
import { loadPublicVenuePage } from "../lib/venues/public-venue-pages.ts";
import { matchesPublicEventNameArtistOrVenue } from "../lib/events/public-event-search.ts";
import {
  buildPublicEventVenueFilterOptions,
  getPublicEventVenueFilterValue,
  matchesPublicEventVenueFilter,
  resolvePublicEventVenueFilter,
} from "../lib/events/public-event-venue-filter.ts";
import { projectPublicEventVenueDisplay } from "../lib/events/public-event-venue-fields.ts";

const zappa = {
  _id: "venue-zappa-baza",
  aliases: ["Old Zappa Hall"],
  category: "club",
  instagramHandle: "zappa_baza",
  latitude: 44.8271,
  location: "Bulevar vojvode Bojovica 30",
  longitude: 20.4519,
  name: "Zappa Baza",
};
const barka = {
  ...zappa,
  _id: "venue-zappa-barka",
  aliases: [],
  instagramHandle: "zappa_barka",
  latitude: 44.8338,
  location: "Usce bb",
  longitude: 20.4346,
  name: "Zappa Barka",
};
const branchOne = {
  ...zappa,
  _id: "venue-branch-one",
  aliases: [],
  instagramHandle: "same_brand_one",
  latitude: 44.815,
  location: "First Street 1",
  longitude: 20.465,
  name: "Same Brand",
};
const branchTwo = {
  ...branchOne,
  _id: "venue-branch-two",
  instagramHandle: "same_brand_two",
  latitude: 44.805,
  location: "Second Street 2",
  longitude: 20.475,
};
const removedLocationVenue = {
  ...zappa,
  _id: "venue-removed-location",
  aliases: [],
  instagramHandle: "removed_location",
  latitude: null,
  location: "  ",
  longitude: null,
  name: "Removed Location",
};
const partialLocationVenue = {
  ...removedLocationVenue,
  _id: "venue-partial-location",
  instagramHandle: "partial_location",
  latitude: 44.81,
  location: "Current Street 3",
  name: "Partial Location",
};
function makeEvent(overrides) {
  return {
    _id: "event-base",
    artists: ["PAT TODD AND THE RANKOUTSIDERS"],
    createdAt: 1,
    date: "2026-10-29",
    eventType: "live_music",
    instagramPostUrl: "https://www.instagram.com/p/QA_Zappa/",
    sourceCaption: "Original source with ZAPPA BAZA and the precise program.",
    status: "approved",
    time: "20:00",
    title: "PAT TODD AND THE RANKOUTSIDERS",
    updatedAt: 1,
    venue: "ZAPPA BAZA",
    venueId: zappa._id,
    // A stale handle must not supersede the exact physical venue binding.
    venueInstagramHandle: barka.instagramHandle,
    venueLatitude: 45.25,
    venueLocation: "Old source address 99",
    venueLongitude: 19.84,
    ...overrides,
  };
}
const originalFixtures = [
  makeEvent({ _id: "zappa-uppercase" }),
  makeEvent({ _id: "zappa-former-name", venue: "Old Zappa Hall" }),
  makeEvent({ _id: "barka", venue: barka.name, venueId: barka._id }),
  makeEvent({ _id: "branch-one", venue: branchOne.name, venueId: branchOne._id }),
  makeEvent({ _id: "branch-two", venue: branchTwo.name, venueId: branchTwo._id }),
  makeEvent({ _id: "removed-location", venue: removedLocationVenue.name, venueId: removedLocationVenue._id }),
  makeEvent({ _id: "partial-location", venue: partialLocationVenue.name, venueId: partialLocationVenue._id }),
  makeEvent({
    _id: "hidden-linked-venue",
    venue: "Public source venue text",
    venueAliases: ["Private alias"],
    venueId: "hidden-venue-id",
    venueLocation: "Private location",
  }),
];
let transportEvents = structuredClone(originalFixtures);
let transportVenues = [zappa, barka, branchOne, branchTwo, removedLocationVenue, partialLocationVenue];
const originalVenueFixtures = structuredClone(transportVenues);
const queries = [];
const originalQuery = ConvexHttpClient.prototype.query;
const originalFetch = globalThis.fetch;
const originalUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
process.env.NEXT_PUBLIC_CONVEX_URL = "https://public-venue-qa.convex.cloud";
globalThis.fetch = async () => {
  throw new Error("Public venue QA must never perform an external request.");
};
ConvexHttpClient.prototype.query = async function query(name, args) {
  queries.push({ name, args });
  if (name === "events:listPublicEventsWindow" || name === "events:listPublicCalendarEventsWindowPaginated") {
    const windowEvents = transportEvents.filter((event) =>
      event.date >= args.fromDate && event.date < args.beforeDate,
    );
    const cursor = args.cursor ?? args.paginationOpts?.cursor ?? "0";
    const offset = Number(cursor);
    const page = windowEvents.slice(offset, offset + 50);
    return {
      continueCursor: String(offset + page.length),
      isDone: offset + page.length >= windowEvents.length,
      page: structuredClone(page),
    };
  }
  if (name === "venues:listPublicVenueFieldsByIds") {
    assert.ok(args.ids.length <= 100, "Venue enrichment must remain bounded.");
    return structuredClone(transportVenues.filter((venue) => args.ids.includes(venue._id)));
  }
  if (name === "venues:listPublicActiveVenueFields") {
    return structuredClone(transportVenues);
  }
  if (name === "venues:getPublicVenuePage") {
    return {
      venue: structuredClone(zappa),
      upcomingEvents: structuredClone(originalFixtures.filter((event) => event.venueId === zappa._id)),
      historyEvents: [],
      stats: null,
    };
  }
  if (name === "scrapedPosts:listPublicRecentPostsByHandle") {
    return [];
  }
  throw new Error(`Unexpected QA query: ${name}`);
};

try {
  const page = await loadPublicEventsWindowPage({ fromDate: "2026-10-01", beforeDate: "2026-11-01" });
  assert.equal(page.error, undefined);
  assert.equal(page.events.length, originalFixtures.length);
  const events = page.events;
  const uppercase = events.find((event) => event._id === "zappa-uppercase");
  assert.equal(uppercase.venue, "Zappa Baza");
  assert.equal(uppercase.venueId, zappa._id);
  assert.equal(uppercase.instagramHandle, zappa.instagramHandle);
  assert.equal(uppercase.venueLocation, zappa.location);
  assert.equal(uppercase.venueLatitude, zappa.latitude);
  assert.equal(uppercase.venueLongitude, zappa.longitude);
  assert.notEqual(uppercase.venueLocation, originalFixtures[0].venueLocation);
  assert.notEqual(uppercase.venueLatitude, originalFixtures[0].venueLatitude);
  assert.ok(uppercase.venueAliases.includes("ZAPPA BAZA"));
  assert.ok(uppercase.venueAliases.includes("Old Zappa Hall"));
  assert.equal(uppercase.sourceCaption, originalFixtures[0].sourceCaption);
  assert.deepEqual(transportEvents, originalFixtures, "A read must never rewrite persisted/source fixtures.");
  assert.deepEqual(transportVenues, originalVenueFixtures, "A read must not mutate the current venue records.");
  for (const event of events) {
    const source = originalFixtures.find((candidate) => candidate._id === event._id);
    for (const field of ["_id", "title", "date", "time", "artists", "status", "sourceCaption", "instagramPostUrl", "createdAt", "updatedAt"]) {
      assert.deepEqual(event[field], source[field], `A location refresh must preserve ${field}: ${event._id}`);
    }
  }
  for (const branch of [branchOne, branchTwo, barka]) {
    const branchEvent = events.find((event) => event.venueId === branch._id);
    assert.equal(branchEvent.venueLocation, branch.location);
    assert.equal(branchEvent.venueLatitude, branch.latitude, "Shared names and stale handles must not select another branch's coordinates.");
    assert.equal(branchEvent.venueLongitude, branch.longitude);
  }
  for (const eventId of ["removed-location", "partial-location"]) {
    const event = events.find((candidate) => candidate._id === eventId);
    assert.equal("venueLatitude" in event, false, "Missing current coordinates must remove stale event coordinates.");
    assert.equal("venueLongitude" in event, false, "A partial current pair must never mix with old coordinates.");
  }
  assert.equal("venueLocation" in events.find((event) => event._id === "removed-location"), false);
  assert.equal(events.find((event) => event._id === "partial-location").venueLocation, partialLocationVenue.location);

  const options = buildPublicEventVenueFilterOptions(events);
  const zappaOptions = options.filter((option) => option.value === `id:${zappa._id}`);
  assert.equal(zappaOptions.length, 1, "One canonical venue must have one dropdown option.");
  assert.equal(zappaOptions[0].label, zappa.name);
  for (const legacyName of ["Zappa Baza", "ZAPPA BAZA", "Old Zappa Hall"]) {
    const selected = resolvePublicEventVenueFilter(legacyName, options);
    assert.equal(selected, `id:${zappa._id}`);
    assert.deepEqual(
      events.filter((event) => matchesPublicEventVenueFilter(event, selected)).map((event) => event._id).sort(),
      ["zappa-former-name", "zappa-uppercase"],
      "Every old name link must find all events for the same physical venue.",
    );
  }
  assert.equal(matchesPublicEventNameArtistOrVenue(uppercase, "Old Zappa Hall"), true);
  assert.equal(matchesPublicEventNameArtistOrVenue(uppercase, "precise program"), false);
  assert.equal(matchesPublicEventVenueFilter(uppercase, `id:${barka._id}`), false);
  assert.equal(matchesPublicEventVenueFilter(uppercase, "id:missing-venue"), false);
  assert.equal(matchesPublicEventVenueFilter(uppercase, undefined), true);
  const selectedBranch = getPublicEventVenueFilterValue({ venue: branchOne.name, venueId: branchOne._id });
  assert.deepEqual(events.filter((event) => matchesPublicEventVenueFilter(event, selectedBranch)).map((event) => event._id), ["branch-one"]);
  assert.equal(resolvePublicEventVenueFilter("Same Brand", options), "Same Brand", "An ambiguous legacy name must not arbitrarily select a branch.");
  assert.equal(options.find((option) => option.value === selectedBranch).label, "Same Brand (First Street 1)");
  const hidden = events.find((event) => event._id === "hidden-linked-venue");
  assert.equal(hidden.venue, "Public source venue text");
  assert.equal(hidden.venueId, undefined);
  assert.equal(hidden.venueAliases, undefined);
  assert.equal(hidden.venueLocation, undefined);
  assert.equal(hidden.venueLatitude, undefined);
  assert.equal(hidden.venueLongitude, undefined);
  assert.equal(hidden.sourceCaption, originalFixtures.at(-1).sourceCaption);
  assert.deepEqual(projectPublicEventVenueDisplay(originalFixtures[0], barka), originalFixtures[0], "A conflicting venue cannot rename a source-bound event.");
  for (const [latitude, longitude] of [
    [undefined, undefined], [44.81, undefined], [undefined, 20.46],
    [NaN, 20.46], [44.81, Infinity], [91, 20.46], [44.81, -181], [0, 0],
  ]) {
    const projected = projectPublicEventVenueDisplay(originalFixtures[0], {
      ...zappa, latitude, longitude, location: null,
    });
    assert.equal("venueLatitude" in projected, false);
    assert.equal("venueLongitude" in projected, false);
    assert.equal("venueLocation" in projected, false);
  }
  const unknown = { venue: "Unlinked Place" };
  assert.equal(matchesPublicEventVenueFilter(unknown, getPublicEventVenueFilterValue(unknown)), true);
  assert.equal(matchesPublicEventVenueFilter(unknown, "UNLINKED PLACE"), true);

  const calendar = await loadPublicCalendarEventsWindow({ fromDate: "2026-10-01", beforeDate: "2026-11-01" });
  assert.equal(calendar.error, undefined);
  assert.deepEqual(calendar.events, page.events, "Calendar and public list must project the same venue identities.");
  const venuePage = await loadPublicVenuePage(zappa._id, { today: "2026-10-01" });
  assert.equal(venuePage.error, undefined);
  assert.ok(venuePage.upcomingEvents.every((event) => event.venue === zappa.name && event.venueId === zappa._id));
  for (const event of venuePage.upcomingEvents) {
    assert.equal(event.venueLocation, zappa.location);
    assert.equal(event.venueLatitude, zappa.latitude);
    assert.equal(event.venueLongitude, zappa.longitude);
  }
  assert.deepEqual(transportEvents, originalFixtures);
  assert.deepEqual(transportVenues, originalVenueFixtures);

  const unboundLegacy = makeEvent({
    _id: "unbound-legacy-source",
    date: "2026-11-05",
    venue: "Old Zappa Hall",
    venueId: undefined,
    venueInstagramHandle: zappa.instagramHandle,
    venueAliases: ["Source-only alias"],
    venueHours: { hoursJson: "Stale denormalized venue hours" },
  });
  const boundNeighbor = makeEvent({
    _id: "bound-neighbor",
    date: unboundLegacy.date,
    venue: zappa.name,
  });
  const unboundLegacySnapshot = structuredClone(unboundLegacy);
  transportEvents = [unboundLegacy, boundNeighbor];
  const monthWithNeighbor = await loadPublicCalendarEventsWindow({ fromDate: "2026-11-01", beforeDate: "2026-12-01" });
  const dayWithNeighbor = await loadPublicCalendarEventsWindow({ fromDate: "2026-11-05", beforeDate: "2026-11-06" });
  for (const result of [monthWithNeighbor, dayWithNeighbor]) {
    assert.equal(result.error, undefined);
    const legacy = result.events.find((event) => event._id === unboundLegacy._id);
    assert.equal(legacy.venue, unboundLegacy.venue, "An unbound calendar row must retain its authorized source label.");
    assert.equal(legacy.venueId, undefined, "A name, alias or handle shared with a neighboring bound event must not supply a calendar venue binding.");
    assert.equal(legacy.venueAliases, undefined);
    assert.equal(legacy.venueHours, undefined);
    assert.equal(legacy.venueLatitude, undefined);
    assert.equal(legacy.venueLongitude, undefined);
    assert.equal(legacy.venueLocation, undefined);
    assert.equal(legacy.sourceCaption, unboundLegacy.sourceCaption);
    assert.equal(result.events.find((event) => event._id === boundNeighbor._id).venueId, zappa._id, "Exact canonical bindings still receive the current public venue projection.");
  }
  const genericLegacyPage = await loadPublicEventsWindowPage({ fromDate: "2026-11-05", beforeDate: "2026-11-06" });
  assert.equal(genericLegacyPage.events.find((event) => event._id === unboundLegacy._id).venueId, zappa._id, "The generic feed's existing legacy inference must remain unchanged.");
  transportEvents = [unboundLegacy];
  const originalDateNow = Date.now;
  let dayAlone;
  try {
    const afterCacheExpiry = Date.now() + 61_000;
    Date.now = () => afterCacheExpiry;
    dayAlone = await loadPublicCalendarEventsWindow({ fromDate: "2026-11-05", beforeDate: "2026-11-06" });
  } finally {
    Date.now = originalDateNow;
  }
  assert.equal(dayAlone.error, undefined);
  assert.deepEqual(dayAlone.events, [dayWithNeighbor.events.find((event) => event._id === unboundLegacy._id)], "Calendar source identity must be identical alone, with same-day neighbors, and in a full month.");
  assert.deepEqual(transportEvents[0], unboundLegacySnapshot, "Read projections must never mutate legacy source data.");
  transportEvents = structuredClone(originalFixtures);

  const auditFlag = process.argv.indexOf("--audit-directory");
  if (auditFlag !== -1) {
    const auditDirectory = process.argv[auditFlag + 1];
    assert.ok(auditDirectory, "--audit-directory requires a path.");
    transportEvents = JSON.parse(readFileSync(path.join(auditDirectory, "events.json"), "utf8"));
    transportVenues = JSON.parse(readFileSync(path.join(auditDirectory, "venues.json"), "utf8"));
    const snapshot = structuredClone(transportEvents);
    const liveProjection = await loadPublicCalendarEventsWindow({ fromDate: "2026-10-01", beforeDate: "2026-12-01" });
    assert.equal(liveProjection.error, undefined);
    assert.equal(liveProjection.events.length, snapshot.length);
    const sourceById = new Map(snapshot.map((event) => [event._id, event]));
    const venueById = new Map(transportVenues.map((venue) => [venue._id, venue]));
    const liveOptions = buildPublicEventVenueFilterOptions(liveProjection.events);
    for (const event of liveProjection.events) {
      const source = sourceById.get(event._id);
      for (const field of ["_id", "title", "date", "artists", "status", "ticketPrice", "instagramPostUrl"]) {
        assert.deepEqual(event[field], source[field], `Public projection must preserve ${field}: ${event._id}`);
      }
      const venue = venueById.get(source.venueId);
      if (venue) {
        assert.equal(event.venue, venue.name);
        assert.equal(event.venueId, source.venueId);
        assert.equal(matchesPublicEventVenueFilter(event, `id:${venue._id}`), true);
        assert.equal(matchesPublicEventVenueFilter(event, source.venue), true);
        assert.equal(resolvePublicEventVenueFilter(source.venue, liveOptions) === `id:${venue._id}` || resolvePublicEventVenueFilter(source.venue, liveOptions) === source.venue, true);
      }
    }
    assert.deepEqual(transportEvents, snapshot, "Real saved public records must remain unchanged.");
    const concert = liveProjection.events.find((event) => event._id === "j57eqdppv8z500ypnnjz32md558d1ygy");
    if (concert) {
      for (const name of ["Zappa Baza", "ZAPPA BAZA"]) {
        assert.equal(matchesPublicEventVenueFilter(concert, resolvePublicEventVenueFilter(name, liveOptions)), true);
      }
    }
    console.log(`Real public snapshot passed: ${snapshot.length} events, ${transportVenues.length} venues; IDs, dates, titles, lineups, prices and sources preserved.`);
  }
  assert.ok(queries.length > 0);
  console.log("Public venue identity QA passed: bounded real loaders, curated labels, old links, aliases, branches, hidden venues and source preservation.");
} finally {
  ConvexHttpClient.prototype.query = originalQuery;
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_CONVEX_URL;
  else process.env.NEXT_PUBLIC_CONVEX_URL = originalUrl;
}
