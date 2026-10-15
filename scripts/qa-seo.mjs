import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { isPlausibleConvexPublicId } from "../lib/convex/public-id.ts";
import { getDiscoverPageCopy } from "../lib/discover/page-copy.ts";
import {
  projectPublicEventVenueDisplay,
  sanitizeVenueLinkedPublicEventFields,
} from "../lib/events/public-event-venue-fields.ts";
import {
  SITE_NAME,
  SITE_ORIGIN,
  SITE_INSTAGRAM_URL,
  buildEventStartDate,
  buildEventStructuredData,
  buildHomePageStructuredData,
  buildVenueStructuredData,
  serializeJsonLd,
} from "../lib/seo/site.ts";
import { loadValidatedSitemapPublicData } from "../lib/seo/sitemap-data.ts";

function read(path) {
  return readFileSync(path, "utf8");
}

assert.equal(SITE_NAME, "Event Zeka");
assert.equal(SITE_ORIGIN, "https://eventzeka.com");
assert.deepEqual(buildHomePageStructuredData()["@graph"][0].sameAs, [SITE_INSTAGRAM_URL]);
assert.equal(isPlausibleConvexPublicId("j578mw1v72asdhawga974smym989xcjj"), true);
assert.equal(isPlausibleConvexPublicId("not-an-id"), false);

for (const [selectedDate, when] of [
  ["2026-10-12", "tonight"],
  ["2026-10-13", "tomorrow"],
  ["2026-10-11", "on October 11, 2026"],
]) {
  const copy = getDiscoverPageCopy(selectedDate, "2026-10-12");
  assert.equal(copy.title, `Belgrade events ${when}`);
  assert.equal(
    copy.introduction,
    `Concerts, club nights, DJ sets, and culture in Belgrade ${when}.`,
  );
  assert.ok(copy.description.includes(`in Belgrade ${when}.`));
  if (selectedDate !== "2026-10-12") {
    for (const text of Object.values(copy)) {
      assert.doesNotMatch(text, /tonight/i, "A selected date must not promise tonight's listings.");
    }
  }
}

for (const [date, time, expected] of [
  ["2026-12-18", "22:30", "2026-12-18T22:30:00+01:00"],
  ["2026-07-19", "22:30", "2026-07-19T22:30:00+02:00"],
  ["2026-07-19", "0:00", "2026-07-19T00:00:00+02:00"],
  ["2026-07-19", "22:30-02:00", "2026-07-19T22:30:00+02:00"],
  ["2026-03-29", "01:30", "2026-03-29T01:30:00+01:00"],
  ["2026-03-29", "03:30", "2026-03-29T03:30:00+02:00"],
  ["2026-10-25", "01:30", "2026-10-25T01:30:00+02:00"],
  ["2026-10-25", "03:30", "2026-10-25T03:30:00+01:00"],
  ["2026-10-25", "02:30", "2026-10-25T02:30:00"],
  ["2026-03-29", "02:30", "2026-03-29"],
]) {
  assert.equal(
    buildEventStartDate(date, time),
    expected,
    `The event start must preserve the announced ${date} ${time} Belgrade clock.`,
  );
}

for (const time of [
  undefined,
  "",
  "TBD",
  "Time not announced",
  "24:00",
  "22:60",
  "22:30pm",
  "22:30 or 23:00",
  "22:30-25:00",
]) {
  assert.equal(
    buildEventStartDate("2026-07-19", time),
    "2026-07-19",
    "Missing, invalid, or unsupported times must not invent a precise start.",
  );
}

for (const [description, time, age, endDate] of [
  ["For ages 5–8; led by Marija Nikolić.", "12:00-13:30", "5-8", "2026-10-17T13:30:00+02:00"],
  ["For ages 9–14; led by Marija Nikolić.", "14:00-15:30", "9-14", "2026-10-17T15:30:00+02:00"],
  ["Nightlife event.", "22:00-03:00", undefined, "2026-10-18T03:00:00+02:00"],
  ["No announced session details.", "TBD", undefined, undefined],
  ["Two groups: ages 5–8 and ages 9–14.", "14:00", undefined, undefined],
]) {
  const session = buildEventStructuredData({
    _id: "session-qa", title: "Mali vajari boja", artists: [],
    date: "2026-10-17", eventType: "learning", venue: "Museum",
    description, time,
  });
  assert.equal(session.typicalAgeRange, age, "Age schema must describe this occurrence only.");
  assert.equal(session.endDate, endDate, "Session end must preserve the announced Belgrade clock.");
}

const eventJsonLd = buildEventStructuredData({
  _id: "event-1",
  artists: ["DJ Test"],
  date: "2026-12-18",
  description: "A verified Belgrade night.",
  eventType: "Club",
  imageUrl: "https://images.apifyusercontent.com/event.jpg",
  ticketPrice: "1.200 RSD",
  time: "22:30",
  title: "Test Night",
  venue: "Test Club",
  venueId: "venue-test-club",
  venueLatitude: 44.8176,
  venueLocation: "Cetinjska 15, Belgrade",
  venueLongitude: 20.4633,
});
assert.equal(eventJsonLd["@context"], "https://schema.org");
assert.equal(eventJsonLd["@type"], "Event");
assert.equal(eventJsonLd["@id"], `${SITE_ORIGIN}/events/event-1#event`);
assert.equal(eventJsonLd.url, `${SITE_ORIGIN}/events/event-1`);
assert.equal(eventJsonLd.startDate, "2026-12-18T22:30:00+01:00");
assert.equal(eventJsonLd.eventAttendanceMode, "https://schema.org/OfflineEventAttendanceMode");
assert.equal(eventJsonLd.eventStatus, "https://schema.org/EventScheduled");
assert.deepEqual(eventJsonLd.performer, [{ "@type": "Person", name: "DJ Test" }]);
assert.equal("offers" in eventJsonLd, false);
assert.equal("organizer" in eventJsonLd, false);
assert.equal("isAccessibleForFree" in eventJsonLd, false);
assert.deepEqual(eventJsonLd.location, {
  "@type": "Place",
  "@id": `${SITE_ORIGIN}/venues/venue-test-club#place`,
  url: `${SITE_ORIGIN}/venues/venue-test-club`,
  address: {
    "@type": "PostalAddress",
    addressCountry: "RS",
    addressLocality: "Belgrade",
    streetAddress: "Cetinjska 15, Belgrade",
  },
  geo: {
    "@type": "GeoCoordinates",
    latitude: 44.8176,
    longitude: 20.4633,
  },
  hasMap: "https://www.google.com/maps/search/?api=1&query=44.8176,20.4633",
  name: "Test Club",
});

const dateOnlyEventJsonLd = buildEventStructuredData({
  _id: "event-2",
  artists: [],
  date: "2026-07-19",
  eventType: "Culture",
  ticketPrice: "Besplatan ulaz",
  title: "Test Exhibition",
  venue: "Test Gallery",
});
assert.equal(dateOnlyEventJsonLd.startDate, "2026-07-19");
assert.equal(dateOnlyEventJsonLd.isAccessibleForFree, true);
assert.equal("offers" in dateOnlyEventJsonLd, false);
assert.equal("organizer" in dateOnlyEventJsonLd, false);
assert.equal("performer" in dateOnlyEventJsonLd, false);
assert.equal("geo" in dateOnlyEventJsonLd.location, false);
assert.equal("hasMap" in dateOnlyEventJsonLd.location, false);
assert.equal("@id" in dateOnlyEventJsonLd.location, false, "An unlinked event must not invent a venue identity.");

for (const ticketPrice of [
  "Free",
  "Free admission",
  "Entry is free.",
  "Besplatan ulaz",
  "Besplatno",
  "Slobodan ulaz",
  "Ulaz je besplatan!",
]) {
  assert.equal(
    buildEventStructuredData({
      _id: "event-free",
      artists: [],
      date: "2026-07-19",
      eventType: "Culture",
      ticketPrice,
      title: "Free exhibition",
      venue: "Test Gallery",
    }).isAccessibleForFree,
    true,
    `Explicit free admission should be reflected for '${ticketPrice}'.`,
  );
}

for (const ticketPrice of [
  undefined,
  "1.200 RSD",
  "Not free",
  "Free before midnight, then 500 RSD",
  "Free for members",
  "Free drink with ticket",
  "Besplatan ulaz do 22:00",
  "Ulaz nije besplatan",
]) {
  assert.equal(
    "isAccessibleForFree" in buildEventStructuredData({
      _id: "event-ticketed",
      artists: [],
      date: "2026-07-19",
      eventType: "Club",
      ticketPrice,
      title: "Test Night",
      venue: "Test Club",
    }),
    false,
    `Conditional, negated, or unknown price '${ticketPrice}' must not make the whole event free.`,
  );
}

const venueJsonLd = buildVenueStructuredData({
  _id: "venue-1",
  category: "Gallery",
  instagramHandle: "testgallery",
  instagramProfileUrl: "https://www.instagram.com/testgallery/",
  latitude: 44.81,
  location: "Dorcol, Belgrade",
  longitude: 20.46,
  name: "Test Gallery",
  neighborhood: "Dorcol",
});
assert.equal(venueJsonLd["@type"], "LocalBusiness");
assert.equal(venueJsonLd["@id"], `${SITE_ORIGIN}/venues/venue-1#place`);
assert.equal(venueJsonLd.url, `${SITE_ORIGIN}/venues/venue-1`);
assert.equal(venueJsonLd.hasMap, "https://www.google.com/maps/search/?api=1&query=44.81,20.46");
assert.deepEqual(venueJsonLd.sameAs, ["https://www.instagram.com/testgallery/"]);
assert.deepEqual(venueJsonLd.address, {
  "@type": "PostalAddress",
  addressCountry: "RS",
  addressLocality: "Belgrade",
  addressRegion: "Dorcol",
  streetAddress: "Dorcol, Belgrade",
});

const updatedVenue = {
  _id: "venue-updated-location",
  instagramHandle: "updated_venue",
  latitude: 44.8231676,
  location: "Current Street 22, Beograd",
  longitude: 20.472113,
  name: "Current Venue Name",
};
const savedSourceEvent = {
  _id: "event-updated-location",
  artists: [],
  date: "2026-10-17",
  eventType: "Club",
  sourceCaption: "Exact original source at the old named venue.",
  instagramPostUrl: "https://www.instagram.com/p/QA_Current_Location/",
  title: "Announced Event",
  venue: "Old Venue Name",
  venueId: updatedVenue._id,
  venueLatitude: 45.25,
  venueLocation: "Former Street 99",
  venueLongitude: 19.84,
};
const savedSourceSnapshot = structuredClone(savedSourceEvent);
const currentEvent = projectPublicEventVenueDisplay(savedSourceEvent, updatedVenue);
const currentEventJsonLd = buildEventStructuredData(currentEvent);
const currentVenueJsonLd = buildVenueStructuredData(updatedVenue);
assert.deepEqual(currentEventJsonLd.location.address, currentVenueJsonLd.address, "Event and venue schema must use the same current address.");
assert.deepEqual(currentEventJsonLd.location.geo, currentVenueJsonLd.geo, "Event and venue schema must use the same current coordinate pair.");
assert.equal(currentEventJsonLd.location.address.streetAddress, updatedVenue.location);
assert.equal(currentEventJsonLd.location.geo.latitude, updatedVenue.latitude);
assert.equal(currentEventJsonLd.location.geo.longitude, updatedVenue.longitude);
assert.equal(currentEventJsonLd.location["@id"], currentVenueJsonLd["@id"]);
assert.equal(currentEventJsonLd.location.url, currentVenueJsonLd.url);
assert.equal(currentEventJsonLd.location.hasMap, currentVenueJsonLd.hasMap);
assert.equal(currentEventJsonLd.location.name, updatedVenue.name);
assert.equal(currentEventJsonLd.startDate, savedSourceEvent.date, "A location refresh must not invent an event start from venue hours.");
assert.equal(currentEvent.sourceCaption, savedSourceEvent.sourceCaption);
assert.equal(currentEvent.instagramPostUrl, savedSourceEvent.instagramPostUrl);
assert.deepEqual(savedSourceEvent, savedSourceSnapshot, "Schema generation and projection must leave stored source fields untouched.");

const hiddenEventJsonLd = buildEventStructuredData(sanitizeVenueLinkedPublicEventFields(savedSourceEvent, false));
for (const field of ["@id", "url", "hasMap", "geo"]) {
  assert.equal(field in hiddenEventJsonLd.location, false, `A hidden venue must not expose location ${field}.`);
}
assert.equal("streetAddress" in hiddenEventJsonLd.location.address, false);

for (const [latitude, longitude] of [
  [undefined, undefined], [44.81, undefined], [undefined, 20.46],
  [null, 20.46], [44.81, null], [NaN, 20.46], [44.81, NaN],
  [Infinity, 20.46], [44.81, -Infinity], [90.01, 20.46], [-90.01, 20.46],
  [44.81, 180.01], [44.81, -180.01], [0, 0],
]) {
  const invalidEvent = buildEventStructuredData({
    ...savedSourceEvent,
    venueLatitude: latitude,
    venueLongitude: longitude,
  });
  const invalidVenue = buildVenueStructuredData({ ...updatedVenue, latitude, longitude });
  assert.equal("geo" in invalidEvent.location, false, "Invalid or partial coordinates must not produce Event geo.");
  assert.equal("hasMap" in invalidEvent.location, false);
  assert.equal("geo" in invalidVenue, false, "Invalid or partial coordinates must not produce venue geo.");
  assert.equal(invalidVenue.hasMap, `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${updatedVenue.name} ${updatedVenue.location}`)}`);
  const clearedEvent = projectPublicEventVenueDisplay(savedSourceEvent, {
    ...updatedVenue, latitude, longitude, location: null,
  });
  const clearedJsonLd = buildEventStructuredData(clearedEvent);
  assert.equal("geo" in clearedJsonLd.location, false, "Removing current coordinates must never restore the old event pair.");
  assert.equal("streetAddress" in clearedJsonLd.location.address, false, "Removing a current address must never restore the old event address.");
  assert.doesNotMatch(serializeJsonLd(clearedJsonLd), /Former Street|45\.25|19\.84|NaN|Infinity/);
}

for (const [latitude, longitude] of [[90, 180], [-90, -180], [0, 20.46], [44.81, 0]]) {
  const boundaryVenue = buildVenueStructuredData({ ...updatedVenue, latitude, longitude });
  assert.deepEqual(boundaryVenue.geo, { "@type": "GeoCoordinates", latitude, longitude });
}

for (const cityOnlyLocation of [
  undefined,
  "",
  "Belgrade",
  " Beograd ",
  "Београд",
  "Belgrade, Serbia",
]) {
  const cityOnlyEvent = buildEventStructuredData({
    _id: "event-city-only",
    artists: [],
    date: "2026-07-19",
    eventType: "Club",
    title: "Test Night",
    venue: "Test Club",
    venueLocation: cityOnlyLocation,
  });
  const cityOnlyVenue = buildVenueStructuredData({
    _id: "venue-city-only",
    instagramHandle: "testclub",
    name: "Test Club",
    location: cityOnlyLocation,
  });
  for (const address of [cityOnlyEvent.location.address, cityOnlyVenue.address]) {
    assert.equal(address.addressLocality, "Belgrade");
    assert.equal(
      "streetAddress" in address,
      false,
      "A city-only location must not be presented as a street address.",
    );
  }
}

const successfulEventResult = { events: [{ _id: "event-1" }] };
const successfulVenueResult = { venues: [{ _id: "venue-1" }] };
let venueLoaderCalls = 0;
await assert.rejects(
  () =>
    loadValidatedSitemapPublicData({
      today: "2026-07-20",
      loadEvents: async () => ({ events: [], error: "events unavailable" }),
      loadVenues: async () => {
        venueLoaderCalls += 1;
        return successfulVenueResult;
      },
    }),
  /Unable to build SEO sitemap: events unavailable/,
);
assert.equal(
  venueLoaderCalls,
  0,
  "A failed event load should throw before the cached callback can return or start venue work.",
);

let eventAttempts = 0;
const retryResult = await (async () => {
  const options = {
    today: "2026-07-20",
    loadEvents: async () => {
      eventAttempts += 1;
      return eventAttempts === 1
        ? { events: [], error: "transient Convex error" }
        : successfulEventResult;
    },
    loadVenues: async () => successfulVenueResult,
  };
  await assert.rejects(
    () => loadValidatedSitemapPublicData(options),
    /Unable to build SEO sitemap: transient Convex error/,
  );
  return loadValidatedSitemapPublicData(options);
})();
assert.equal(eventAttempts, 2, "A transient failure should be retryable rather than returned as cache data.");
assert.deepEqual(retryResult, {
  eventResult: successfulEventResult,
  venueResult: successfulVenueResult,
});

await assert.rejects(
  () =>
    loadValidatedSitemapPublicData({
      today: "2026-07-20",
      loadEvents: async () => successfulEventResult,
      loadVenues: async () => ({ venues: [], error: "venues unavailable" }),
    }),
  /Unable to build SEO sitemap: venues unavailable/,
);

const serialized = serializeJsonLd({ text: "</script>\u2028\u2029" });
assert.equal(serialized.includes("</script>"), false);
assert.ok(serialized.includes("\\u003c/script>"));
assert.ok(serialized.includes("\\u2028"));
assert.ok(serialized.includes("\\u2029"));

const layout = read("app/layout.tsx");
const rootPage = read("app/page.tsx");
const browsePage = read("app/(main)/events-browse-page.tsx");
const eventPage = read("app/(main)/events/[eventId]/page.tsx");
const eventMap = read("app/(main)/map/page.tsx");
const venueDirectory = read("app/(main)/venues/directory/page.tsx");
const venuePage = read("app/(main)/venues/[venueId]/page.tsx");
const discoverPage = read("app/(main)/discover/page.tsx");
const savedPage = read("app/(main)/saved/page.tsx");
const youPage = read("app/(main)/you/page.tsx");
const adminLayout = read("app/(dashboard)/admin/layout.tsx");
const authLayout = read("app/(auth)/layout.tsx");
const robots = read("app/robots.ts");
const sitemap = read("app/sitemap.ts");
const sitemapData = read("lib/seo/sitemap-data.ts");
const nextConfig = read("next.config.mjs");
const convexEvents = read("convex/events.ts");
const convexPublicReads = read("convex/eventDomain/publicReads.ts");
const convexVenues = read("convex/venues.ts");

assert.match(convexVenues, /DEFAULT_PUBLIC_VENUE_DIRECTORY_LIMIT = 2000/);
assert.match(convexVenues, /MAX_PUBLIC_VENUE_DIRECTORY_LIMIT = 2000/);
assert.match(convexVenues, /by_normalizedVenueHandle_status_date/);
assert.match(convexVenues, /by_normalizedVenueIdentity_status_date/);
assert.doesNotMatch(
  venueDirectory,
  /upcomingEventCount|name="upcoming"/,
  "Venue directory SEO must not depend on an incomplete, query-heavy upcoming count.",
);

assert.ok(layout.includes('lang="en-RS"'));
assert.equal(layout.includes('alternateLocale: "sr_RS"'), false);
assert.ok(rootPage.includes("generateMetadata"));
assert.ok(rootPage.includes('canonical: "/"'));
assert.ok(rootPage.includes("index: !hasSearchParams"));
assert.ok(browsePage.includes("Belgrade events, nightlife & culture"));
assert.equal((browsePage.match(/<h1/g) ?? []).length, 1, "The calendar should expose one H1.");
assert.ok(browsePage.includes("Događaji u Beogradu"));
assert.ok(browsePage.includes("Šta se dešava u Beogradu danas?"));
assert.ok(!browsePage.includes("Događaji u Beogradu za sve"));
assert.ok(!browsePage.includes("Događaji u Beogradu za lokalce i posetioce"));
assert.ok(!browsePage.includes("Tonight&apos;s picks"));
assert.ok(!browsePage.includes("Belgrade venues"));
assert.ok(browsePage.includes("buildHomePageStructuredData"));

for (const [label, source] of [
  ["event detail", eventPage],
  ["venue directory", venueDirectory],
  ["event map", eventMap],
  ["venue detail", venuePage],
  ["discover", discoverPage],
]) {
  assert.ok(source.includes("canonical"), `${label} should expose a canonical URL.`);
}
assert.ok(eventPage.includes("buildEventStructuredData"));
assert.ok(eventPage.includes("generateMetadata"));
assert.ok(eventPage.includes('type: "article"'));
assert.ok(venuePage.includes("buildVenueStructuredData"));
assert.ok(venuePage.includes("const loadVenuePage = cache("));
assert.match(eventPage, /generateMetadata[\s\S]*notFound\(\)/);
assert.match(venuePage, /generateMetadata[\s\S]*notFound\(\)/);
assert.ok(venueDirectory.includes("buildVenueDirectoryStructuredData"));
assert.ok(eventMap.includes('canonical: "/map"'));
assert.ok(eventMap.includes('new URL("/map", SITE_ORIGIN)'));
assert.ok(eventMap.includes("index: !hasDateFilter"));
assert.ok(discoverPage.includes("index: !hasDateFilter"));

for (const [label, source] of [
  ["saved", savedPage],
  ["profile", youPage],
  ["admin", adminLayout],
  ["auth", authLayout],
]) {
  assert.ok(source.includes("index: false"), `${label} routes should be noindex.`);
  assert.ok(source.includes("follow: false"), `${label} routes should be nofollow.`);
}

assert.ok(robots.includes('sitemap: `${SITE_ORIGIN}/sitemap.xml`'));
assert.match(
  robots,
  /allow:\s*\["\/",\s*"\/api\/discover\/images\/"\]/,
  "Public event posters must remain crawlable within the otherwise blocked API path.",
);
for (const path of ["/admin/", "/api/"]) {
  assert.ok(robots.includes(`"${path}"`), `robots should disallow ${path}.`);
}
for (const path of ["/saved", "/you", "/sign-in", "/sign-up"]) {
  assert.equal(
    robots.includes(`"${path}"`),
    false,
    `robots should allow ${path} so crawlers can see its noindex directive.`,
  );
}
assert.equal(
  existsSync("app/(main)/events/loading.tsx"),
  false,
  "The event detail segment must not stream a 200 loading shell before notFound() can return 404.",
);
assert.equal(
  existsSync("app/loading.tsx"),
  false,
  "The root segment must not stream a 200 loading shell before dynamic notFound() responses can return 404.",
);
assert.ok(sitemap.includes("loadPublicCalendarEventsWindow"));
assert.ok(sitemap.includes("loadPublicVenueDirectory"));
assert.ok(sitemap.includes('dynamic = "force-dynamic"'));
assert.ok(sitemap.includes("unstable_cache"));
assert.ok(sitemap.includes("loadValidatedSitemapPublicData"));
assert.ok(sitemap.includes('"seo-sitemap-public-data-v2"'));
assert.ok(sitemapData.includes("limit: 2000"));
assert.ok(sitemapData.includes("addDaysToDateKey(options.today, 367)"));
assert.ok(sitemap.includes("/discover"));
assert.ok(sitemap.includes('absoluteUrl("/map")'));
assert.equal(sitemap.includes('absoluteUrl("/venues")'), false, "The redirecting legacy map URL must not appear in the sitemap.");
assert.ok(sitemap.includes("/venues/directory"));
assert.ok(sitemap.includes("/events/${event._id}"));
assert.ok(sitemap.includes("/venues/${venue._id}"));
assert.equal((nextConfig.match(/permanent: true/g) ?? []).length >= 4, true);
assert.ok(nextConfig.includes("htmlLimitedBots: /.*/"));
assert.match(
  convexEvents,
  /getPublicApprovedEvent = query[\s\S]*args: \{ id: v\.string\(\) \}[\s\S]*handler: getPublicApprovedEventHandler/,
);
assert.match(
  convexPublicReads,
  /getPublicApprovedEventHandler[\s\S]*normalizeId\("events", args\.id\)/,
);
assert.match(
  convexVenues,
  /getPublicVenuePage = query[\s\S]*id: v\.string\(\)[\s\S]*normalizeId\("venues", args\.id\)/,
);

console.log("SEO QA passed: metadata, canonicals, crawl controls, structured data, and local intent copy are present.");
