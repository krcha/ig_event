import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { getPublicDuplicateEventIds } from "../convex/events.ts";
import { projectPublicEvent } from "../convex/publicEventProjection.ts";
import { buildNormalizedEventVenueIdentity } from "../lib/events/event-venue-identity.ts";
import {
  chunkPublicVenueIds,
  PUBLIC_VENUE_FIELDS_BATCH_SIZE,
} from "../lib/events/public-venue-batching.ts";

function read(path) {
  return readFileSync(path, "utf8");
}

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing section start: ${start}`);
  const endIndex = end ? source.indexOf(end, startIndex + start.length) : source.length;
  assert.notEqual(endIndex, -1, `Missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

const schemaSource = read("convex/schema.ts");
const eventsSource = read("convex/events.ts");
const venuesSource = read("convex/venues.ts");
const publicEventsSource = read("lib/events/public-events.ts");
const publicVenuePagesSource = read("lib/venues/public-venue-pages.ts");
const venuesPageSource = read("app/(main)/venues/page.tsx");
const venueDetailPageSource = read("app/(main)/venues/[venueId]/page.tsx");
const carouselRouteSource = read("app/api/social/daily-carousel/route.ts");
const reclassifySource = read("scripts/reclassify-event-types.mjs");
const reprocessSource = read("scripts/reprocess-pending-source-grounding.mjs");
const sitemapSource = read("app/sitemap.ts");
const packageJson = JSON.parse(read("package.json"));
const releaseCheckSource = read("scripts/release-check.mjs");
const projectionPath = "convex/publicEventProjection.ts";

for (const indexDefinition of [
  '.index("by_normalizedVenueHandle_status_date", ["normalizedVenueInstagramHandle", "status", "date"])',
  '.index("by_normalizedVenueIdentity_status_date", ["normalizedVenueIdentity", "status", "date"])',
]) {
  assert.ok(
    schemaSource.includes(indexDefinition),
    `Legacy venue matching requires normalized identity index: ${indexDefinition}`,
  );
}
for (const fieldName of ["normalizedVenueIdentity", "normalizedVenueInstagramHandle"]) {
  assert.match(
    schemaSource,
    new RegExp(`${fieldName}: v\\.optional\\(v\\.string\\(\\)\\)`),
    `Event schema must persist ${fieldName} for indexed legacy matching.`,
  );
}
assert.match(
  eventsSource,
  /backfillEventVenueIdentityBatch[\s\S]*resolveVenueDenormalizedFieldsFromPublicVenues/,
  "The authenticated backfill must use the same canonical venue resolver as production writes.",
);
assert.match(
  read("scripts/backfill-event-venue-identity.mjs"),
  /verificationPass[\s\S]*verificationPass\.updated !== 0/,
  "The venue identity migration must finish with a zero-update idempotence pass.",
);

const venueCardsSource = section(
  venuesSource,
  "async function loadBoundedVenueEventCards",
  "function buildInstagramProfileUrl",
);
const venuePageQuerySource = section(
  venuesSource,
  "export const getPublicVenuePage",
  "export const listPublicVenueDirectory",
);
assert.doesNotMatch(
  venuePageQuerySource,
  /\.collect\(\)/,
  "Public venue pages must not collect every event or favorite to derive cards or totals.",
);
assert.match(
  venueCardsSource,
  /by_normalizedVenueHandle_status_date/,
  "Venue pages must recover mixed-case/@ legacy handles through normalized indexes.",
);
assert.match(
  venueCardsSource,
  /by_normalizedVenueIdentity_status_date/,
  "Venue pages must recover normalized legacy venue names through normalized indexes.",
);
assert.match(
  venueCardsSource,
  /\.take\(options\.limit\)/,
  "Venue event cards must be bounded at the indexed database read.",
);

const publicEventsWindowSource = section(
  eventsSource,
  "export const listPublicEventsWindow",
  "function toPublicCalendarEvent",
);
assert.match(
  publicEventsWindowSource,
  /assertPublicEventDateWindow/,
  "The public events window must enforce a server-side date-span cap.",
);
assert.doesNotMatch(
  publicEventsWindowSource,
  /\.paginate\(args\.paginationOpts\)/,
  "The public events window must not forward caller-controlled pagination objects.",
);
assert.match(
  publicEventsWindowSource,
  /paginate\(buildPublicPaginationOptions\(args\.paginationOpts\)\)/,
  "The compatibility events window must rebuild fixed server-owned pagination options.",
);

const calendarQuerySource = section(
  eventsSource,
  "export const listPublicCalendarEventsWindowPaginated",
  "export const listApprovedUpcomingByDatePaginated",
);
assert.match(
  eventsSource,
  /const PUBLIC_EVENT_PAGE_SIZE = 50;/,
  "Public event pages must stay below the production isolate timeout threshold.",
);
assert.match(
  calendarQuerySource,
  /cursor: v\.optional\(v\.union\(v\.string\(\), v\.null\(\)\)\)/,
  "The compact calendar API must expose only the supported cursor.",
);
assert.match(
  calendarQuerySource,
  /assertPublicEventDateWindow/,
  "Compact calendar reads must enforce a server-side date-span cap.",
);
assert.match(
  calendarQuerySource,
  /\.paginate\(\{[\s\S]*numItems: PUBLIC_EVENT_PAGE_SIZE/,
  "Compact calendar reads must construct a fixed server-owned page size.",
);
assert.doesNotMatch(calendarQuerySource, /paginationOptsValidator|args\.paginationOpts|\.collect\(\)/);
assert.doesNotMatch(
  eventsSource,
  /export const listPublicCalendarEventsWindow = query/,
  "The pressure-prone non-paginated calendar compatibility endpoint must be retired.",
);

assert.match(
  publicEventsSource,
  /events:listPublicCalendarEventsWindowPaginated[\s\S]*async function queryPublicCalendarEventsWindowPage/,
  "The web loader must use the bounded compact-calendar page reader.",
);
assert.match(
  publicEventsSource,
  /public-venue-batching[\s\S]*chunkPublicVenueIds\(venueIds\)/,
  "Public venue enrichment must split unique IDs into backend-compatible batches.",
);
assert.equal(PUBLIC_VENUE_FIELDS_BATCH_SIZE, 100);
assert.doesNotMatch(
  publicEventsSource,
  /Promise\.all\(\[[\s\S]*listPublicActiveVenueFieldsQuery[\s\S]*listPublicVenueFieldsByIdsQuery/,
  "Public venue enrichment batches must not run alongside the full active directory query.",
);
const venueIdFixture = Array.from({ length: 205 }, (_, index) => `venue-${index}`);
const venueIdBatches = chunkPublicVenueIds(venueIdFixture);
assert.deepEqual(
  venueIdBatches.map((batch) => batch.length),
  [100, 100, 5],
  "Venue enrichment must keep every request within the 100-ID backend limit.",
);
assert.deepEqual(
  venueIdBatches.flat(),
  venueIdFixture,
  "Venue enrichment batching must preserve every unique ID in order.",
);
assert.match(
  publicEventsSource,
  /queryPublicCalendarEventsWindowPage\([\s\S]*cursor:/,
  "The compact-calendar page reader must send only a cursor.",
);
assert.doesNotMatch(
  publicEventsSource,
  /queryPublicCalendarEventsWindowPage\([\s\S]{0,500}paginationOpts:/,
  "The compact-calendar page reader must not send caller-controlled pagination options.",
);
assert.match(
  carouselRouteSource,
  /events:listPublicCalendarEventsWindowPaginated/,
  "The daily carousel must migrate off the old compatibility endpoint.",
);
assert.doesNotMatch(carouselRouteSource, /events:listPublicCalendarEventsWindow"/);
assert.match(
  reprocessSource,
  /events:listPublicCalendarEventsWindowPaginated/,
  "Operator delta verification must use the paginated calendar endpoint.",
);
assert.doesNotMatch(reprocessSource, /events:listPublicCalendarEventsWindow"/);

const maintenanceUpcomingSource = section(
  eventsSource,
  "export const listApprovedUpcomingByDatePaginated",
  "function readDateParts",
);
assert.match(maintenanceUpcomingSource, /requireAdminOrServiceSecret/);
assert.match(maintenanceUpcomingSource, /serviceSecret: v\.optional\(v\.string\(\)\)/);
assert.match(reclassifySource, /CRON_SECRET/);
assert.match(reclassifySource, /serviceSecret/);

assert.match(
  eventsSource,
  /buildApprovedEventAutoCleanupGroups[\s\S]*projectDeduplicatedPublicEventPage/,
  "Duplicate classification must use private normalized inputs before public projection.",
);
assert.doesNotMatch(
  publicEventsSource,
  /normalizedFieldsJson:\s*null|filterDuplicatePublicEvents|buildApprovedEventAutoCleanupGroups/,
  "Projected events must not attempt duplicate classification after private inputs are removed.",
);

const singletonDate = "2030-07-25";
const singletonNormalizedFieldsJson = JSON.stringify({
  normalizedDate: singletonDate,
  normalizedVenue: "KC Grad",
  rawVenue: "Kulturni centar Grad",
  sourceCaptionFromModel: "The Weight of Light by Irena Ivanovic at KC Grad, 19:00.",
  titleUsedFallback: false,
});
const singletonPrimary = {
  _id: "event-singleton-primary",
  _creationTime: 2,
  artists: ["Irena Ivanovic"],
  createdAt: 2,
  date: singletonDate,
  description: "Opening of The Weight of Light by Irena Ivanovic.",
  eventType: "exhibition",
  imageUrl: "https://example.com/primary.jpg",
  instagramPostId: "singleton-primary-post",
  instagramPostUrl: "https://www.instagram.com/p/singleton-primary/",
  normalizedFieldsJson: singletonNormalizedFieldsJson,
  sourceCaption: "The Weight of Light by Irena Ivanovic at KC Grad, 19:00.",
  status: "approved",
  time: "19:00",
  title: "The Weight of Light",
  updatedAt: 2,
  venue: "KC Grad",
};
const singletonDuplicate = {
  ...singletonPrimary,
  _id: "event-singleton-duplicate",
  _creationTime: 1,
  createdAt: 1,
  description: undefined,
  imageUrl: undefined,
  instagramPostId: "singleton-duplicate-post",
  instagramPostUrl: "https://www.instagram.com/p/singleton-duplicate/",
  updatedAt: 1,
};
let singletonCohortReads = 0;
const singletonQueryBuilder = {
  eq() {
    return this;
  },
};
const singletonCtx = {
  db: {
    query(table) {
      assert.equal(table, "events");
      return {
        withIndex(index, configure) {
          assert.equal(index, "by_status_date");
          configure(singletonQueryBuilder);
          return {
            async take(limit) {
              singletonCohortReads += 1;
              assert.equal(limit, 26);
              return [singletonPrimary, singletonDuplicate];
            },
          };
        },
      };
    },
  },
};
const singletonHiddenIds = await getPublicDuplicateEventIds(singletonCtx, [
  singletonDuplicate,
]);
assert.equal(singletonCohortReads, 1, "A singleton raw page must load its same-date cohort.");
assert.equal(
  singletonHiddenIds.has(singletonDuplicate._id),
  true,
  "A duplicate on a singleton final page must remain suppressed before projection.",
);

assert.ok(existsSync(projectionPath), "Public event responses must use an explicit projection module.");
const projectionSource = read(projectionPath);
for (const privateField of [
  "rawExtractionJson",
  "normalizedFieldsJson",
  "moderationNote",
  "reviewedAt",
  "reviewedBy",
  "sourceOccurrenceKey",
  "reasoningNotes",
  "postAltText",
  "splitSourceLine",
  "sourceCaptionFromModel",
]) {
  assert.doesNotMatch(
    projectionSource,
    new RegExp(`\\b${privateField}\\b`),
    `Public event projections must not expose or copy ${privateField}.`,
  );
}
const privateMarkers = [
  "PRIVATE_REASONING_MARKER",
  "PRIVATE_ALT_MARKER",
  "PRIVATE_SPLIT_MARKER",
  "PRIVATE_MODEL_CAPTION_MARKER",
];
const projectedFixture = projectPublicEvent(
  {
    _id: "event_fixture",
    _creationTime: 1,
    title: "Public title",
    date: "2026-07-25",
    venue: "Public venue",
    artists: [],
    eventType: "music",
    sourceCaption: "Intentionally public caption",
    normalizedFieldsJson: JSON.stringify({
      reasoningNotes: privateMarkers[0],
      postAltText: privateMarkers[1],
      splitSourceLine: privateMarkers[2],
      sourceCaptionFromModel: privateMarkers[3],
    }),
    status: "approved",
    createdAt: 1,
    updatedAt: 1,
  },
  true,
);
const serializedProjection = JSON.stringify(projectedFixture);
for (const marker of privateMarkers) {
  assert.ok(!serializedProjection.includes(marker), `Public projection leaked nested marker: ${marker}`);
}
assert.ok(serializedProjection.includes("Intentionally public caption"));

const normalizedHandleFixture = buildNormalizedEventVenueIdentity({
  venue: "  KC GRAD!  ",
  venueInstagramHandle: "@MiXeD.Handle",
});
assert.equal(normalizedHandleFixture.normalizedVenueInstagramHandle, "mixed.handle");
assert.equal(normalizedHandleFixture.normalizedVenueIdentity, "kc grad");
assert.equal(
  buildNormalizedEventVenueIdentity({ venue: "ŠKC Novi Beograd" }).normalizedVenueIdentity,
  buildNormalizedEventVenueIdentity({ venue: "SKC Novi Beograd" }).normalizedVenueIdentity,
  "Normalized venue identity must preserve transliterated legacy matching.",
);

assert.doesNotMatch(
  publicVenuePagesSource,
  /loadPublicCalendarEventsWindow|PUBLIC_VENUE_DIRECTORY_EVENT_WINDOW_DAYS|upcomingEventCount/,
  "The venue directory must not exhaust a year of calendar pages to derive counts.",
);
assert.doesNotMatch(
  venuesPageSource,
  /upcomingEventCount|name="upcoming"|upcomingOnly/,
  "The venue directory UI must not promise an expensive/incomplete upcoming total.",
);
assert.doesNotMatch(
  venueDetailPageSource,
  /stats\?\.approvedEventCount\s*\?\?|stats\?\.approvedUpcomingCount\s*\?\?|label:\s*"posts"|label:\s*"upcoming"/,
  "Bounded venue-card lengths must not be displayed as complete counts.",
);
assert.doesNotMatch(
  sitemapSource,
  /upcomingEventCount/,
  "Sitemap priority must not depend on removed incomplete directory counts.",
);
const compatibilityDirectorySource = section(
  venuesSource,
  "export const listPublicVenueDirectory",
  "export const createVenue",
);
assert.doesNotMatch(
  compatibilityDirectorySource,
  /query\("events"\)|\.collect\(\)|\.take\(1000\)/,
  "The old venue-directory compatibility endpoint must not scan events.",
);

assert.ok(
  packageJson.scripts["qa:public-query-pressure"]?.includes("qa-public-query-pressure.mjs"),
  "package.json must expose the public query-pressure regression gate.",
);
assert.match(
  releaseCheckSource,
  /qa:public-query-pressure/,
  "The full release gate must run the public query-pressure regression.",
);

console.log("Public query-pressure QA passed: public reads are server-bounded, normalized, projected, and non-redundant.");
