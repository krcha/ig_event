import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { getPublicDuplicateEventIds } from "../convex/events.ts";
import { projectPublicEvent } from "../convex/publicEventProjection.ts";
import { buildNormalizedEventVenueIdentity } from "../lib/events/event-venue-identity.ts";
import {
  buildPublicCalendarDateWindows,
  MAX_PUBLIC_CALENDAR_WINDOW_DAYS,
} from "../lib/events/public-calendar-windows.ts";
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
  const endIndex = end
    ? source.indexOf(end, startIndex + start.length)
    : source.length;
  assert.notEqual(endIndex, -1, `Missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

const schemaSource = read("convex/schema.ts");
const eventsSource = read("convex/events.ts");
const publicReadsSource = read("convex/eventDomain/publicReads.ts");
const eventVenueBindingMigrationSource = read(
  "convex/internal/migrations/eventVenueBindings.ts",
);
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

for (const [indexName, firstField] of [
  ["by_normalizedVenueHandle_status_date", "normalizedVenueInstagramHandle"],
  ["by_normalizedVenueIdentity_status_date", "normalizedVenueIdentity"],
]) {
  assert.match(
    schemaSource,
    new RegExp(
      `\\.index\\("${indexName}", \\[\\s*"${firstField}",\\s*"status",\\s*"date",?\\s*\\]\\)`,
      "u",
    ),
    `Legacy venue matching requires normalized identity index: ${indexName}`,
  );
}
for (const fieldName of [
  "normalizedVenueIdentity",
  "normalizedVenueInstagramHandle",
]) {
  assert.match(
    schemaSource,
    new RegExp(`${fieldName}: v\\.optional\\(v\\.string\\(\\)\\)`),
    `Event schema must persist ${fieldName} for indexed legacy matching.`,
  );
}
assert.match(
  eventsSource,
  /backfillEventVenueIdentityBatch[\s\S]*unsafe compatibility backfill is retired/,
  "The legacy event venue backfill must fail closed.",
);
assert.match(
  eventVenueBindingMigrationSource,
  /backfillEventVenueBindingsBatchHandler[\s\S]*rebindCanonicalVenue[\s\S]*event-venue-bindings-v1/,
  "The tracked venue binding migration must re-attest occurrence provenance.",
);
assert.match(
  read("scripts/backfill-event-venue-identity.mjs"),
  /is retired because it could change an event without atomically re-attesting/,
  "The obsolete operator script must explain why it is retired.",
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
  publicReadsSource,
  "export async function listPublicEventsWindowHandler",
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
  /const pagination = buildPublicPaginationOptions\(args\.paginationOpts\);[\s\S]*paginatePublicationRows\(/,
  "The compatibility events window must rebuild fixed server-owned pagination options and project one page.",
);
assert.match(
  publicEventsWindowSource,
  /projectVisible: \(events\) =>\s*projectLegacyCompatiblePublicEventPage\(ctx, events\)/,
  "The public list must revalidate each bounded raw page while preserving approved legacy rows.",
);
assert.match(
  publicEventsWindowSource,
  /loadApprovedWindowRawPage\(ctx, readMode, \{[\s\S]*cursor,[\s\S]*numItems/,
  "The visible-row paginator must control each bounded raw database read.",
);

const calendarQuerySource = section(
  publicReadsSource,
  "export async function listPublicCalendarEventsWindowPaginatedHandler",
  "export async function listApprovedUpcomingByDatePaginatedHandler",
);
const calendarQueryFacadeSource = section(
  eventsSource,
  "export const listPublicCalendarEventsWindowPaginated",
  "export const listApprovedUpcomingByDatePaginated",
);
assert.match(
  publicReadsSource,
  /const PUBLIC_EVENT_PAGE_SIZE = 50;/,
  "Public event pages must stay below the production isolate timeout threshold.",
);
assert.match(
  calendarQueryFacadeSource,
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
  /paginatePublicationRows\(\{[\s\S]*numItems: PUBLIC_EVENT_PAGE_SIZE/,
  "Compact calendar reads must use a fixed server-owned raw page size.",
);
assert.match(
  calendarQuerySource,
  /projectLegacyCompatiblePublicEventPage\(ctx, events\)/,
  "The public calendar must revalidate each bounded raw page while preserving approved legacy rows.",
);
assert.doesNotMatch(
  calendarQuerySource,
  /paginationOptsValidator|args\.paginationOpts|\.collect\(\)/,
);
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
const venueIdFixture = Array.from(
  { length: 205 },
  (_, index) => `venue-${index}`,
);
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
assert.doesNotMatch(
  carouselRouteSource,
  /events:listPublicCalendarEventsWindow"/,
);
assert.equal(MAX_PUBLIC_CALENDAR_WINDOW_DAYS, 45);
const sitemapCalendarWindows = buildPublicCalendarDateWindows(
  "2026-07-29",
  "2027-07-31",
);
assert.equal(sitemapCalendarWindows.length, 9);
assert.deepEqual(sitemapCalendarWindows[0], {
  fromDate: "2026-07-29",
  beforeDate: "2026-09-12",
});
assert.deepEqual(sitemapCalendarWindows.at(-1), {
  fromDate: "2027-07-24",
  beforeDate: "2027-07-31",
});
for (const [index, window] of sitemapCalendarWindows.entries()) {
  const spanDays =
    (Date.parse(`${window.beforeDate}T00:00:00Z`) -
      Date.parse(`${window.fromDate}T00:00:00Z`)) /
    86_400_000;
  assert.ok(spanDays >= 1 && spanDays <= MAX_PUBLIC_CALENDAR_WINDOW_DAYS);
  if (index > 0) {
    assert.equal(
      sitemapCalendarWindows[index - 1].beforeDate,
      window.fromDate,
      "Sitemap calendar windows must be contiguous without overlap or gaps.",
    );
  }
}
assert.match(
  publicEventsSource,
  /buildPublicCalendarDateWindows\(fromDate, beforeDate\)[\s\S]*window\.beforeDate[\s\S]*window\.fromDate/,
  "The public calendar loader must split long sitemap ranges into backend-safe windows.",
);
assert.match(
  reprocessSource,
  /events:listPublicCalendarEventsWindowPaginated/,
  "Operator delta verification must use the paginated calendar endpoint.",
);
assert.doesNotMatch(reprocessSource, /events:listPublicCalendarEventsWindow"/);

const maintenanceUpcomingSource = section(
  publicReadsSource,
  "export async function listApprovedUpcomingByDatePaginatedHandler",
  "function isPromotionActive",
);
const maintenanceUpcomingFacadeSource = section(
  eventsSource,
  "export const listApprovedUpcomingByDatePaginated",
  "export const getDiscoverFeed",
);
assert.match(maintenanceUpcomingSource, /requireAdminOrServiceSecret/);
assert.match(
  maintenanceUpcomingFacadeSource,
  /serviceSecret: v\.optional\(v\.string\(\)\)/,
);
assert.match(reclassifySource, /CRON_SECRET/);
assert.match(reclassifySource, /serviceSecret/);

const duplicateClassificationSource = section(
  publicReadsSource,
  "export async function getPublicDuplicateEventIds",
  "/**\n * Single public-window storage boundary.",
);
assert.match(
  duplicateClassificationSource,
  /buildApprovedEventAutoCleanupGroups\(\s*cohort\.map\(toApprovedEventDuplicateRecord\),?\s*\)/,
  "Duplicate classification must use private event records before public projection.",
);
assert.doesNotMatch(
  duplicateClassificationSource,
  /projectPublicEvent|projectCanonicallyGroundedPublicEventPage/,
  "Duplicate classification must not consume already-projected public records.",
);
assert.doesNotMatch(
  publicEventsSource,
  /normalizedFieldsJson:\s*null|filterDuplicatePublicEvents|buildApprovedEventAutoCleanupGroups/,
  "Projected events must not attempt duplicate classification after private inputs are removed.",
);

const singletonDate = "2026-07-30";
const singletonCaption =
  "Grounded Handler Event 30. jul @ Grounded Handler Venue uz Grounded Handler Artist";
const singletonPostedAt = "2026-07-01T12:00:00.000Z";
function singletonGroundingJson(postId, postUrl) {
  return JSON.stringify({
    title: "Grounded Handler Event",
    time: "TBD",
    artists: ["Grounded Handler Artist"],
    postAltText: null,
    sourceGroundingSourceKind: "caption",
    sourceGroundingSourceCaption: singletonCaption,
    sourceGroundingInstagramPostId: postId,
    sourceGroundingInstagramPostUrl: postUrl,
    sourceGroundingInstagramHandle: "qa_venue",
    sourceGroundingVersion: 4,
    sourceGroundingEvidence: "instagram_caption",
    approvalTitleSensible: true,
    approvalCaptionSourceCoherent: true,
    sourceGroundingVerified: true,
    sourceGroundingTitleVerified: true,
    sourceGroundingDateVerified: true,
    sourceGroundingIdentityVerified: true,
    sourceGroundingIdentityContextVerified: true,
    sourceGroundingTimeVerified: null,
    sourceGroundingArtistsVerified: true,
    sourceGroundingRowVerified: true,
    moderationAutoApproved: true,
    moderationAutoApproveRule: "source_grounded_core_event_fields",
    moderationPendingReasons: [],
    moderationSignals: ["time_tbd"],
    moderationConfidenceScore: 0.95,
    normalizedDate: singletonDate,
    normalizedVenue: "Grounded Handler Venue",
    rawVenue: "Grounded Handler Venue",
    sourceCaptionFromModel: singletonCaption,
    normalizedIsValid: true,
    titleUsedFallback: false,
    dateSuspiciousYear: false,
    dateConfidence: "high",
    missingImage: false,
    moderationAllowMissingImage: false,
  });
}
const singletonPrimary = {
  _id: "event-singleton-primary",
  _creationTime: 2,
  artists: ["Grounded Handler Artist"],
  createdAt: 2,
  date: singletonDate,
  description: "Grounded handler event.",
  eventType: "exhibition",
  imageUrl: "https://example.com/primary.jpg",
  instagramPostId: "singleton-primary",
  instagramPostUrl: "https://www.instagram.com/p/singleton-primary/",
  normalizedFieldsJson: singletonGroundingJson(
    "singleton-primary",
    "https://www.instagram.com/p/singleton-primary/",
  ),
  sourceCaption: singletonCaption,
  sourcePostedAt: singletonPostedAt,
  venueInstagramHandle: "qa_venue",
  venueId: "venue-singleton",
  status: "approved",
  time: "TBD",
  title: "Grounded Handler Event",
  updatedAt: 2,
  venue: "Grounded Handler Venue",
};
const singletonDuplicate = {
  ...singletonPrimary,
  _id: "event-singleton-duplicate",
  _creationTime: 1,
  createdAt: 1,
  description: undefined,
  instagramPostId: "singleton-duplicate",
  instagramPostUrl: "https://www.instagram.com/p/singleton-duplicate/",
  normalizedFieldsJson: singletonGroundingJson(
    "singleton-duplicate",
    "https://www.instagram.com/p/singleton-duplicate/",
  ),
  updatedAt: 1,
};
let singletonCohortReads = 0;
const singletonQueryBuilder = {
  eq() {
    return this;
  },
};
const singletonPostsById = new Map(
  [singletonPrimary, singletonDuplicate].map((event) => [
    event.instagramPostId,
    {
      handle: "qa_venue",
      username: "qa_venue",
      postId: event.instagramPostId,
      instagramPostUrl: event.instagramPostUrl,
      caption: singletonCaption,
      postedAt: singletonPostedAt,
    },
  ]),
);
const singletonCtx = {
  db: {
    async get(id) {
      return id === "venue-singleton"
        ? { _id: id, publicStatus: "published", scrapeActive: true }
        : null;
    },
    query(table) {
      if (table === "scrapedPosts") {
        const criteria = {};
        const sourceQueryBuilder = {
          eq(field, value) {
            criteria[field] = value;
            return this;
          },
        };
        return {
          withIndex(index, configure) {
            assert.equal(index, "by_handle_postId");
            configure(sourceQueryBuilder);
            return {
              async take(limit) {
                assert.equal(criteria.handle, "qa_venue");
                const found = singletonPostsById.get(criteria.postId);
                return found ? [found].slice(0, limit) : [];
              },
              async first() {
                assert.equal(criteria.handle, "qa_venue");
                return singletonPostsById.get(criteria.postId) ?? null;
              },
            };
          },
        };
      }
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
const originalSingletonDateNow = Date.now;
Date.now = () => Date.parse("2026-07-27T12:00:00.000Z");
const singletonHiddenIds = await getPublicDuplicateEventIds(singletonCtx, [
  singletonDuplicate,
]);
Date.now = originalSingletonDateNow;
assert.equal(
  singletonCohortReads,
  1,
  "A singleton raw page must load its same-date cohort.",
);
assert.equal(
  singletonHiddenIds.has(singletonDuplicate._id),
  true,
  "A duplicate on a singleton final page must remain suppressed before projection.",
);

assert.ok(
  existsSync(projectionPath),
  "Public event responses must use an explicit projection module.",
);
const projectionSource = read(projectionPath);
for (const privateField of [
  "rawExtractionJson",
  "normalizedFieldsJson",
  "moderationNote",
  "reviewedAt",
  "reviewedBy",
  "humanReviewedLegacySourcePolicyVersion",
  "humanReviewedStructuredSourcePolicyVersion",
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
  assert.ok(
    !serializedProjection.includes(marker),
    `Public projection leaked nested marker: ${marker}`,
  );
}
assert.ok(serializedProjection.includes("Intentionally public caption"));

const normalizedHandleFixture = buildNormalizedEventVenueIdentity({
  venue: "  KC GRAD!  ",
  venueInstagramHandle: "@MiXeD.Handle",
});
assert.equal(
  normalizedHandleFixture.normalizedVenueInstagramHandle,
  "mixed.handle",
);
assert.equal(normalizedHandleFixture.normalizedVenueIdentity, "kc grad");
assert.equal(
  buildNormalizedEventVenueIdentity({ venue: "ŠKC Novi Beograd" })
    .normalizedVenueIdentity,
  buildNormalizedEventVenueIdentity({ venue: "SKC Novi Beograd" })
    .normalizedVenueIdentity,
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
  packageJson.scripts["qa:public-query-pressure"]?.includes(
    "qa-public-query-pressure.mjs",
  ),
  "package.json must expose the public query-pressure regression gate.",
);
assert.match(
  releaseCheckSource,
  /qa:public-query-pressure/,
  "The full release gate must run the public query-pressure regression.",
);

console.log(
  "Public query-pressure QA passed: public reads are server-bounded, normalized, projected, and non-redundant.",
);
