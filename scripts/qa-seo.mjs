import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { isPlausibleConvexPublicId } from "../lib/convex/public-id.ts";
import {
  SITE_NAME,
  SITE_ORIGIN,
  buildEventStructuredData,
  buildVenueStructuredData,
  serializeJsonLd,
} from "../lib/seo/site.ts";

function read(path) {
  return readFileSync(path, "utf8");
}

assert.equal(SITE_NAME, "Event Zeka");
assert.equal(SITE_ORIGIN, "https://events.ineedtofeedmyrabbit.com");
assert.equal(isPlausibleConvexPublicId("j578mw1v72asdhawga974smym989xcjj"), true);
assert.equal(isPlausibleConvexPublicId("not-an-id"), false);

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
  venueLatitude: 44.8176,
  venueLocation: "Cetinjska 15, Belgrade",
  venueLongitude: 20.4633,
});
assert.equal(eventJsonLd["@context"], "https://schema.org");
assert.equal(eventJsonLd["@type"], "Event");
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
assert.equal(venueJsonLd.url, `${SITE_ORIGIN}/venues/venue-1`);
assert.deepEqual(venueJsonLd.sameAs, ["https://www.instagram.com/testgallery/"]);
assert.deepEqual(venueJsonLd.address, {
  "@type": "PostalAddress",
  addressCountry: "RS",
  addressLocality: "Belgrade",
  addressRegion: "Dorcol",
  streetAddress: "Dorcol, Belgrade",
});

const serialized = serializeJsonLd({ text: "</script>\u2028\u2029" });
assert.equal(serialized.includes("</script>"), false);
assert.ok(serialized.includes("\\u003c/script>"));
assert.ok(serialized.includes("\\u2028"));
assert.ok(serialized.includes("\\u2029"));

const layout = read("app/layout.tsx");
const rootPage = read("app/page.tsx");
const browsePage = read("app/(main)/events-browse-page.tsx");
const eventPage = read("app/(main)/events/[eventId]/page.tsx");
const venueDirectory = read("app/(main)/venues/page.tsx");
const venuePage = read("app/(main)/venues/[venueId]/page.tsx");
const discoverPage = read("app/(main)/discover/page.tsx");
const savedPage = read("app/(main)/saved/page.tsx");
const youPage = read("app/(main)/you/page.tsx");
const adminLayout = read("app/(dashboard)/admin/layout.tsx");
const authLayout = read("app/(auth)/layout.tsx");
const robots = read("app/robots.ts");
const sitemap = read("app/sitemap.ts");
const nextConfig = read("next.config.mjs");

assert.ok(layout.includes('lang="en-RS"'));
assert.equal(layout.includes('alternateLocale: "sr_RS"'), false);
assert.ok(rootPage.includes("generateMetadata"));
assert.ok(rootPage.includes('canonical: "/"'));
assert.ok(rootPage.includes("index: !hasSearchParams"));
assert.ok(browsePage.includes("Belgrade events, nightlife & culture"));
assert.equal((browsePage.match(/<h1/g) ?? []).length, 1, "The calendar should expose one H1.");
assert.ok(browsePage.includes("Događaji u Beogradu"));
assert.ok(browsePage.includes("buildHomePageStructuredData"));

for (const [label, source] of [
  ["event detail", eventPage],
  ["venue directory", venueDirectory],
  ["venue detail", venuePage],
  ["discover", discoverPage],
]) {
  assert.ok(source.includes("canonical"), `${label} should expose a canonical URL.`);
}
assert.ok(eventPage.includes("buildEventStructuredData"));
assert.ok(eventPage.includes("generateMetadata"));
assert.ok(eventPage.includes('type: "article"'));
assert.ok(venuePage.includes("buildVenueStructuredData"));
assert.ok(venuePage.includes("robots: { index: false, follow: false }"));
assert.ok(venueDirectory.includes("buildVenueDirectoryStructuredData"));
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
assert.ok(sitemap.includes("loadPublicCalendarEventsWindow"));
assert.ok(sitemap.includes("loadPublicVenueDirectory"));
assert.ok(sitemap.includes("/discover"));
assert.ok(sitemap.includes("/venues"));
assert.ok(sitemap.includes("/events/${event._id}"));
assert.ok(sitemap.includes("/venues/${venue._id}"));
assert.equal((nextConfig.match(/permanent: true/g) ?? []).length >= 4, true);

console.log("SEO QA passed: metadata, canonicals, crawl controls, structured data, and local intent copy are present.");
