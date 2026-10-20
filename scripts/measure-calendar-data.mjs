// Public read-only transport comparison on a frozen public data snapshot.
// This measures JSON response bytes and request counts, not production latency.
// Run with the repository TS loader and --conditions=react-server.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { buildPublicCalendarOverviewPage } from "../lib/events/public-calendar-overview-types.ts";
import { projectPublicEventVenueDisplay } from "../lib/events/public-event-venue-fields.ts";

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...value] = arg.replace(/^--/, "").split("=");
  return [key, value.join("=")];
}));
const fixturePath = resolve(args.fixture || ".seo-cache/performance/date-followup-public-fixture.json");
const outputPath = resolve(args.output || ".seo-cache/performance/date-followup-data.json");
let fixture;
if (args.capture === "true") {
  const client = new ConvexHttpClient(args.convex || "https://convex-events.ineedtofeedmyrabbit.com");
  const pages = [];
  let cursor = null;
  do {
    const page = await client.query("events:listPublicCalendarEventsWindowPaginated", {
      fromDate: "2026-10-01", beforeDate: "2026-11-01", cursor,
    });
    pages.push(page);
    if (page.isDone) break;
    if (!page.continueCursor || page.continueCursor === cursor) throw new Error("Non-advancing calendar cursor.");
    cursor = page.continueCursor;
  } while (true);
  const venues = await client.query("venues:listPublicVenueFields", {});
  fixture = { capturedAt: new Date().toISOString(), pages, venues };
  mkdirSync(dirname(fixturePath), { recursive: true });
  writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));
} else fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

const events = fixture.pages.flatMap((page) => page.page);
const venuesById = new Map(fixture.venues.map((venue) => [venue._id, venue]));
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const selectedDate = args.date || "2026-10-20";
const weekStart = args.week || "2026-10-19";
const weekEnd = new Date(Date.parse(`${weekStart}T12:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
const dayEvents = events.filter((event) => event.date === selectedDate);
const weekEvents = events.filter((event) => event.date >= weekStart && event.date < weekEnd);
// Exact public DTO keys from venues:listPublicVenueFieldsByIds. The directory
// additionally carries cache metadata and updatedAt that the ID query omits.
const venueFieldKeys = ["_id", "aliases", "category", "hoursJson", "hoursSource", "hoursTimezone",
  "instagramFollowerCount", "instagramFollowerCountUpdatedAt", "instagramHandle", "instagramProfileUrl",
  "latitude", "location", "longitude", "name", "neighborhood"];
const venueFields = (venue) => Object.fromEntries(venueFieldKeys.filter((key) => Object.hasOwn(venue, key)).map((key) => [key, venue[key]]));
function pagesFor(rows) {
  const pages = [];
  for (let offset = 0; offset < Math.max(1, rows.length); offset += 50) {
    pages.push({ page: rows.slice(offset, offset + 50), continueCursor: "fixture", isDone: offset + 50 >= rows.length,
      rawPageCount: 1, scanLimitReached: false });
  }
  return pages;
}
function venueReads(rows) {
  const ids = [...new Set(rows.flatMap((event) => event.venueId ? [event.venueId] : []))];
  return Array.from({ length: Math.ceil(ids.length / 100) }, (_, index) =>
    ids.slice(index * 100, index * 100 + 100).flatMap((id) => venuesById.has(id) ? [venueFields(venuesById.get(id))] : []));
}
function overviewPages(pages) {
  return pages.map((page) => ({ ...page, ...buildPublicCalendarOverviewPage(page.page.map((event) =>
    projectPublicEventVenueDisplay(event, venuesById.get(event.venueId)),
  )) }));
}
function summarize(responses, detailedEvents, extra = {}) {
  return { detailedEvents, responses: responses.length, jsonResponseBytes: responses.reduce((sum, response) => sum + bytes(response), 0), ...extra };
}
const dayPages = pagesFor(dayEvents);
const dayVenueReads = venueReads(dayEvents);
const monthOverviews = overviewPages(fixture.pages);
const weekPages = pagesFor(weekEvents);
const result = {
  measuredAt: new Date().toISOString(), fixtureCapturedAt: fixture.capturedAt, selectedDate, weekStart, weekEnd,
  caveat: "Frozen public snapshot; after overview uses the actual pure projection after the existing publication boundary. JSON bytes exclude HTTP envelopes/compression and real cursor length. No before/after latency claim; query runtime and private DB reads require a deployed backend.",
  home: {
    before: summarize([...fixture.pages, ...venueReads(events)], events.length),
    after: summarize([...monthOverviews, ...dayPages, ...dayVenueReads], dayEvents.length),
  },
  map: {
    before: summarize([...weekPages, ...venueReads(weekEvents), fixture.venues], weekEvents.length, { directoryVenues: fixture.venues.length }),
    after: summarize([...overviewPages(weekPages), ...dayPages, ...dayVenueReads], dayEvents.length, { directoryVenues: 0 }),
  },
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
