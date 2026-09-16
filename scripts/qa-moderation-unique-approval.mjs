import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  approveUniquePendingEvents,
  classifyPendingModerationUniqueness,
} from "../convex/events.ts";
import {
  DEFAULT_MODERATION_VISIBLE_LIMIT,
  MODERATION_QUEUE_FETCH_LIMIT,
  buildVerifiedApprovalNote,
  getModerationReviewDecision,
  selectVisibleModerationEvents,
} from "../lib/events/moderation-view.ts";
import { buildSameDateModerationBatches } from "../lib/events/moderation-uniqueness-batches.ts";
import { getPersistedModerationConfidenceScore } from "../lib/events/moderation-confidence.ts";

process.env.ADMIN_CLERK_USER_IDS = "qa-owner";
process.env.CRON_SECRET = "qa-service-secret";

const FUTURE_DATE = "2035-01-15";
const AS_OF_MS = Date.parse("2035-01-01T12:00:00.000Z");
const MODERATION_NOTE =
  "QA reviewed the persisted Instagram evidence and exact same-date cohort.";

assert.equal(
  getPersistedModerationConfidenceScore({
    normalizedFields: { confidence: 0.9, moderationAllowMissingImage: true },
    rawExtraction: null,
    hasImage: false,
  }),
  0.9,
);
assert.equal(
  getPersistedModerationConfidenceScore({
    normalizedFields: { confidence: 0.95 },
    rawExtraction: null,
    hasImage: false,
  }),
  0.75,
);
assert.equal(
  getPersistedModerationConfidenceScore({
    normalizedFields: null,
    rawExtraction: { confidence: 90 },
    hasImage: true,
  }),
  0.9,
);
assert.equal(
  getPersistedModerationConfidenceScore({
    normalizedFields: null,
    rawExtraction: null,
    hasImage: true,
  }),
  null,
);

const moderationViewFixture = Array.from(
  { length: MODERATION_QUEUE_FETCH_LIMIT },
  (_, index) => ({ id: index + 1, unique: index % 3 === 0 }),
);
for (const expectedLimit of [25, 50, 100, 200]) {
  const visible = selectVisibleModerationEvents(
    moderationViewFixture,
    String(expectedLimit),
  );
  assert.equal(visible.length, expectedLimit);
  assert.equal(visible.at(-1)?.id, expectedLimit);
}
assert.equal(
  selectVisibleModerationEvents(moderationViewFixture, "invalid").length,
  DEFAULT_MODERATION_VISIBLE_LIMIT,
);
assert.equal(selectVisibleModerationEvents(moderationViewFixture, 500).length, 200);
assert.equal(selectVisibleModerationEvents(moderationViewFixture, 0).length, 1);
assert.equal(
  moderationViewFixture.filter((event) => event.unique).length,
  67,
  "Full-queue action candidates must remain independent of the visible subset.",
);

const dateBoundBatches = buildSameDateModerationBatches(
  [
    { id: "late-a", date: "2035-01-03" },
    { id: "early-a", date: "2035-01-01" },
    { id: "middle", date: "2035-01-02" },
    { id: "early-b", date: "2035-01-01" },
    { id: "early-c", date: "2035-01-01" },
  ],
  2,
);
assert.deepEqual(
  dateBoundBatches.map((batch) => batch.map((item) => item.id)),
  [["early-a", "early-b"], ["early-c"], ["middle"], ["late-a"]],
);
for (const batch of dateBoundBatches) {
  assert.ok(batch.length <= 2);
  assert.equal(new Set(batch.map((item) => item.date)).size, 1);
}

function read(path) {
  return readFileSync(path, "utf8");
}

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing section start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `Missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

function makeLegacySourceFields(event, handle) {
  return JSON.stringify({
    sourceGroundingVersion: 4,
    sourceGroundingEvidence: "instagram_caption",
    sourceGroundingSourceKind: "caption",
    sourceGroundingSourceCaption: event.sourceCaption,
    sourceGroundingInstagramPostId: event.instagramPostId,
    sourceGroundingInstagramPostUrl: event.instagramPostUrl,
    sourceGroundingInstagramHandle: handle,
    normalizedIsValid: true,
    titleUsedFallback: false,
    dateSuspiciousYear: false,
    moderationPendingReasons: ["requires_human_approval"],
    title: event.title,
    normalizedDate: event.date,
    time: event.time ?? "",
  });
}

function event(id, overrides = {}) {
  const handle = overrides.sourceHandle ?? `qa_source_${id.replace(/[^a-z0-9]/giu, "_")}`;
  const postId = overrides.instagramPostId ?? `post-${id}`;
  const date = overrides.date ?? FUTURE_DATE;
  const title = overrides.title ?? `QA Showcase ${id}`;
  const venue = overrides.venue ?? "QA Hall";
  const time = Object.prototype.hasOwnProperty.call(overrides, "time")
    ? overrides.time
    : "20:00";
  const sourceCaption =
    overrides.sourceCaption ?? `${title} ${date} ${time ?? ""} ${venue}`;
  const base = {
    _id: id,
    _creationTime: 1,
    title,
    date,
    ...(time === undefined ? {} : { time }),
    venue,
    artists: overrides.artists ?? [`Artist ${id}`],
    eventType: "music",
    sourceCaption,
    sourcePostedAt: "2034-12-01T12:00:00.000Z",
    instagramPostId: postId,
    instagramPostUrl: `https://www.instagram.com/p/${postId}/`,
    sourceConflictFields: [],
    status: "pending",
    createdAt: 1,
    updatedAt: overrides.updatedAt ?? 100,
  };
  return {
    ...base,
    normalizedFieldsJson:
      overrides.normalizedFieldsJson ?? makeLegacySourceFields(base, handle),
    ...Object.fromEntries(
      Object.entries(overrides).filter(([key]) => key !== "sourceHandle"),
    ),
  };
}

function scrapedPostFor(sourceEvent) {
  const fields = JSON.parse(sourceEvent.normalizedFieldsJson);
  const handle = fields.sourceGroundingInstagramHandle;
  return {
    _id: `scraped-${sourceEvent._id}`,
    _creationTime: 1,
    handle,
    username: handle,
    postId: sourceEvent.instagramPostId,
    instagramPostUrl: sourceEvent.instagramPostUrl,
    caption: sourceEvent.sourceCaption,
    postedAt: sourceEvent.sourcePostedAt,
    sourceRevision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeVenue(index) {
  return {
    _id: `venue-${index}`,
    _creationTime: index,
    name: `Venue ${index}`,
    instagramHandle: `venue_${index}`,
    category: "club",
    publicStatus: "published",
    scrapeActive: true,
    aliases: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeCtx({
  events: eventRows,
  venues = [],
  venueIdentities = [],
  sourceEvents = eventRows,
  authenticated = true,
}) {
  const events = new Map(eventRows.map((row) => [row._id, structuredClone(row)]));
  const scrapedPosts = sourceEvents.map(scrapedPostFor);
  const patches = [];
  const audits = [];
  const reads = [];

  function indexedRows(table, indexName, filters) {
    if (table === "events") {
      return [...events.values()].filter((row) =>
        Object.entries(filters).every(([key, value]) => row[key] === value),
      );
    }
    if (table === "scrapedPosts") {
      return scrapedPosts.filter((row) =>
        Object.entries(filters).every(([key, value]) => row[key] === value),
      );
    }
    if (table === "mediaAssets") return [];
    if (table === "eventDomainMigrationState") return [];
    if (table === "instagramEventSources") return [];
    if (table === "sourceOccurrences") return [];
    if (table === "venueIdentities") {
      return venueIdentities.filter((row) =>
        Object.entries(filters).every(([key, value]) => row[key] === value),
      );
    }
    throw new Error(`Unexpected indexed QA table ${table}:${indexName}`);
  }

  const ctx = {
    auth: {
      async getUserIdentity() {
        return authenticated ? { subject: "qa-owner" } : null;
      },
    },
    db: {
      async get(id) {
        reads.push({ kind: "get", id });
        return events.get(id) ?? null;
      },
      query(table) {
        if (table === "venues") {
          return {
            async take(limit) {
              reads.push({ kind: "take", table, limit });
              return venues.slice(0, limit).map((row) => structuredClone(row));
            },
          };
        }
        return {
          withIndex(indexName, configure) {
            const filters = {};
            const q = {
              eq(field, value) {
                filters[field] = value;
                return q;
              },
            };
            configure(q);
            return {
              async take(limit) {
                reads.push({
                  kind: "indexedTake",
                  table,
                  indexName,
                  filters: structuredClone(filters),
                  limit,
                });
                return indexedRows(table, indexName, filters)
                  .slice(0, limit)
                  .map((row) => structuredClone(row));
              },
            };
          },
        };
      },
      async patch(id, patch) {
        const current = events.get(id);
        if (!current) throw new Error(`Missing QA event ${id}`);
        patches.push({ id, patch: structuredClone(patch) });
        events.set(id, { ...current, ...structuredClone(patch) });
      },
      async insert(table, value) {
        assert.equal(table, "eventAuditLog");
        audits.push(structuredClone(value));
        return `audit-${audits.length}`;
      },
    },
  };

  return { ctx, events, patches, audits, reads };
}

async function classify(fixture, items, asOfMs = AS_OF_MS) {
  return classifyPendingModerationUniqueness._handler(fixture.ctx, {
    items,
    asOfMs,
  });
}

function reviewedItem(row, expectedUpdatedAt = row.updatedAt) {
  return { id: row._id, expectedUpdatedAt };
}

// Authentication is enforced by Convex itself, not only by the Next.js route.
const unauthorizedEvent = event("unauthorized");
const unauthorized = makeCtx({ events: [unauthorizedEvent], authenticated: false });
await assert.rejects(
  classify(unauthorized, [reviewedItem(unauthorizedEvent)]),
  /authentication|unauthenticated|admin/iu,
);
assert.equal(unauthorized.reads.length, 0);
await assert.rejects(
  approveUniquePendingEvents._handler(unauthorized.ctx, {
    items: [reviewedItem(unauthorizedEvent)],
    moderationNote: MODERATION_NOTE,
  }),
  /authentication|unauthenticated|admin/iu,
);
assert.equal(unauthorized.patches.length, 0);
assert.equal(unauthorized.audits.length, 0);

// The long-running Next.js operation authenticates the admin once, then uses
// the server-only service credential so a short-lived OIDC token cannot expire
// midway through bounded classification or publication. The reviewed admin
// remains the recorded human actor.
const serviceEvent = event("service-authorized");
const serviceFixture = makeCtx({
  events: [serviceEvent],
  authenticated: false,
});
const serviceClassification =
  await classifyPendingModerationUniqueness._handler(serviceFixture.ctx, {
    items: [reviewedItem(serviceEvent)],
    asOfMs: AS_OF_MS,
    serviceSecret: "qa-service-secret",
  });
assert.equal(serviceClassification.items[0].disposition, "unique");
const serviceApproval = await approveUniquePendingEvents._handler(
  serviceFixture.ctx,
  {
    items: [reviewedItem(serviceEvent)],
    moderationNote: MODERATION_NOTE,
    reviewedBy: "qa-owner",
    serviceSecret: "qa-service-secret",
  },
);
assert.deepEqual(serviceApproval.approvedIds, [serviceEvent._id]);
assert.equal(serviceFixture.events.get(serviceEvent._id).reviewedBy, "qa-owner");
assert.equal(serviceFixture.audits[0].actor, "qa-owner");

const forgedServiceFixture = makeCtx({
  events: [event("forged-service-actor")],
  authenticated: false,
});
await assert.rejects(
  approveUniquePendingEvents._handler(forgedServiceFixture.ctx, {
    items: [reviewedItem(forgedServiceFixture.events.values().next().value)],
    moderationNote: MODERATION_NOTE,
    reviewedBy: "not-an-admin",
    serviceSecret: "qa-service-secret",
  }),
  /reviewed admin identity/iu,
);
assert.equal(forgedServiceFixture.patches.length, 0);
assert.equal(forgedServiceFixture.audits.length, 0);

// The classifier uses the caller's explicit clock, so a row can deterministically
// become ineligible without consulting wall-clock time inside the query.
const expiredEvent = event("expired", { date: "2034-12-20" });
const expired = makeCtx({ events: [expiredEvent] });
const expiredResult = await classify(expired, [reviewedItem(expiredEvent)], AS_OF_MS);
assert.deepEqual(expiredResult.items[0], {
  id: expiredEvent._id,
  expectedUpdatedAt: expiredEvent.updatedAt,
  disposition: "ineligible",
  reason: "ineligible_expired_event",
  conflictIds: [],
});

// The eligibility boundary is the current Europe/Belgrade calendar day, not
// the UTC day and not the public-feed retention grace period. In January,
// 23:00Z is midnight in Belgrade.
const belgradeDayOneEvent = event("belgrade-day-one", {
  date: "2035-01-01",
  title: "Belgrade Boundary Day One",
});
const beforeBelgradeMidnight = Date.parse("2035-01-01T22:30:00.000Z");
const afterBelgradeMidnight = Date.parse("2035-01-01T23:30:00.000Z");
const belgradeDayOneFixture = makeCtx({ events: [belgradeDayOneEvent] });
const belgradeTodayResult = await classify(
  belgradeDayOneFixture,
  [reviewedItem(belgradeDayOneEvent)],
  beforeBelgradeMidnight,
);
assert.equal(belgradeTodayResult.items[0].disposition, "unique");

const belgradeYesterdayFixture = makeCtx({ events: [belgradeDayOneEvent] });
const belgradeYesterdayResult = await classify(
  belgradeYesterdayFixture,
  [reviewedItem(belgradeDayOneEvent)],
  afterBelgradeMidnight,
);
assert.equal(belgradeYesterdayResult.items[0].disposition, "ineligible");
assert.equal(
  belgradeYesterdayResult.items[0].reason,
  "ineligible_expired_event",
);

const belgradeDayTwoEvent = event("belgrade-day-two", {
  date: "2035-01-02",
  title: "Belgrade Boundary Day Two",
});
const belgradeDayTwoFixture = makeCtx({ events: [belgradeDayTwoEvent] });
const belgradeNewTodayResult = await classify(
  belgradeDayTwoFixture,
  [reviewedItem(belgradeDayTwoEvent)],
  afterBelgradeMidnight,
);
assert.equal(belgradeNewTodayResult.items[0].disposition, "unique");

const impossibleDateEvent = event("impossible-date", { date: "2035-02-30" });
const impossibleDateFixture = makeCtx({ events: [impossibleDateEvent] });
const impossibleDateResult = await classify(impossibleDateFixture, [
  reviewedItem(impossibleDateEvent),
]);
assert.equal(impossibleDateResult.items[0].disposition, "ineligible");
assert.equal(impossibleDateResult.items[0].reason, "ineligible_invalid_date");

const invalidInputEvent = event("invalid-input");
const invalidInputFixture = makeCtx({ events: [invalidInputEvent] });
await assert.rejects(
  classify(
    invalidInputFixture,
    Array.from({ length: 11 }, (_, index) => ({
      id: `too-many-${index}`,
      expectedUpdatedAt: 100,
    })),
  ),
  /requires 1-10/iu,
);
await assert.rejects(
  classify(invalidInputFixture, [
    reviewedItem(invalidInputEvent),
    reviewedItem(invalidInputEvent),
  ]),
  /IDs must be unique/iu,
);
await assert.rejects(
  classify(invalidInputFixture, [reviewedItem(invalidInputEvent, 100.5)]),
  /safe integers/iu,
);
await assert.rejects(
  classify(invalidInputFixture, [reviewedItem(invalidInputEvent)], -1),
  /non-negative safe integer/iu,
);

// A proven approved duplicate is never relabeled unique.
const approvedDuplicateTarget = event("approved-duplicate-target", {
  title: "Neon Harbor Live",
  venue: "QA Hall",
});
const approvedDuplicate = event("approved-duplicate", {
  title: "Neon Harbor Live",
  venue: "QA Hall",
  status: "approved",
  instagramPostId: "approved-duplicate-post",
});
const approvedDuplicateFixture = makeCtx({
  events: [approvedDuplicateTarget, approvedDuplicate],
  sourceEvents: [approvedDuplicateTarget],
});
const approvedDuplicateResult = await classify(approvedDuplicateFixture, [
  reviewedItem(approvedDuplicateTarget),
]);
assert.equal(approvedDuplicateResult.items[0].disposition, "duplicate");
assert.equal(approvedDuplicateResult.items[0].reason, "duplicate_same_occurrence");
assert.deepEqual(approvedDuplicateResult.items[0].conflictIds, [approvedDuplicate._id]);

const pendingDuplicate = event("pending-duplicate", {
  title: approvedDuplicateTarget.title,
  venue: approvedDuplicateTarget.venue,
  instagramPostId: "pending-duplicate-post",
});
const pendingDuplicateFixture = makeCtx({
  events: [approvedDuplicateTarget, pendingDuplicate],
  sourceEvents: [approvedDuplicateTarget],
});
const pendingDuplicateResult = await classify(pendingDuplicateFixture, [
  reviewedItem(approvedDuplicateTarget),
]);
assert.equal(pendingDuplicateResult.items[0].disposition, "duplicate");
assert.deepEqual(pendingDuplicateResult.items[0].conflictIds, [pendingDuplicate._id]);

// Same-date/same-venue evidence that is not strong enough to prove distinct
// remains ambiguous whether the competing row is approved or pending.
const ambiguousTarget = event("ambiguous-target", {
  title: "Afterglow",
  venue: "QA Hall",
  time: undefined,
});
const approvedAmbiguous = event("approved-ambiguous", {
  title: "Nightshift",
  venue: "QA Hall",
  time: undefined,
  status: "approved",
});
const approvedAmbiguousFixture = makeCtx({
  events: [ambiguousTarget, approvedAmbiguous],
  sourceEvents: [ambiguousTarget],
});
const approvedAmbiguousResult = await classify(approvedAmbiguousFixture, [
  reviewedItem(ambiguousTarget),
]);
assert.equal(approvedAmbiguousResult.items[0].disposition, "ambiguous");
assert.deepEqual(approvedAmbiguousResult.items[0].conflictIds, [approvedAmbiguous._id]);

const pendingAmbiguous = event("pending-ambiguous", {
  title: "Nightshift",
  venue: "QA Hall",
  time: undefined,
});
const pendingAmbiguousFixture = makeCtx({
  events: [ambiguousTarget, pendingAmbiguous],
  sourceEvents: [ambiguousTarget],
});
const pendingAmbiguousResult = await classify(pendingAmbiguousFixture, [
  reviewedItem(ambiguousTarget),
]);
assert.equal(pendingAmbiguousResult.items[0].disposition, "ambiguous");
assert.deepEqual(pendingAmbiguousResult.items[0].conflictIds, [pendingAmbiguous._id]);

const provenDistinctTarget = event("proven-distinct-target", {
  title: "Shared Night Program",
  venue: "QA Hall",
  time: "19:00",
});
const provenDistinctOther = event("proven-distinct-other", {
  title: "Shared Night Program",
  venue: "QA Hall",
  time: "23:00",
});
const provenDistinctFixture = makeCtx({
  events: [provenDistinctTarget, provenDistinctOther],
  sourceEvents: [provenDistinctTarget],
});
const provenDistinctResult = await classify(provenDistinctFixture, [
  reviewedItem(provenDistinctTarget),
]);
assert.equal(provenDistinctResult.complete, true);
assert.equal(provenDistinctResult.items[0].disposition, "unique");

const ungroundedEvent = event("ungrounded", { normalizedFieldsJson: "{}" });
const ungroundedFixture = makeCtx({
  events: [ungroundedEvent],
  sourceEvents: [],
});
const ungroundedResult = await classify(ungroundedFixture, [
  reviewedItem(ungroundedEvent),
]);
assert.equal(ungroundedResult.items[0].disposition, "ineligible");
assert.equal(ungroundedResult.items[0].reason, "ineligible_source_policy");

const learnedVenue = {
  ...makeVenue("learned"),
  _id: "venue-learned",
  name: "Museum of Science and Technology",
  instagramHandle: "muzejnaukeitehnike",
  aliases: ["Old Museum Alias"],
};
const aliasTarget = event("alias-target", {
  title: "Machine Age Exhibition",
  venue: "Old Museum Alias",
});
const aliasApproved = event("alias-approved", {
  title: aliasTarget.title,
  venue: learnedVenue.name,
  status: "approved",
});
const aliasFixture = makeCtx({
  events: [aliasTarget, aliasApproved],
  venues: [learnedVenue],
  sourceEvents: [aliasTarget],
});
const aliasResult = await classify(aliasFixture, [reviewedItem(aliasTarget)]);
assert.equal(aliasResult.items[0].disposition, "duplicate");
assert.deepEqual(aliasResult.items[0].conflictIds, [aliasApproved._id]);

const identityOnlyTarget = event("identity-only-target", {
  title: "Historical Identity Exhibition",
  venue: "Former Science Hall",
});
const identityOnlyApproved = event("identity-only-approved", {
  title: identityOnlyTarget.title,
  venue: learnedVenue.name,
  status: "approved",
});
const identityOnlyFixture = makeCtx({
  events: [identityOnlyTarget, identityOnlyApproved],
  venues: [{ ...learnedVenue, aliases: [] }],
  venueIdentities: [
    {
      _id: "venue-identity-historical",
      _creationTime: 1,
      active: true,
      kind: "historical_alias",
      rawValue: "Former Science Hall",
      normalizedValue: "former science hall",
      source: "manual",
      venueId: learnedVenue._id,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  sourceEvents: [identityOnlyTarget],
});
const identityOnlyResult = await classify(identityOnlyFixture, [
  reviewedItem(identityOnlyTarget),
]);
assert.equal(
  identityOnlyResult.items[0].disposition,
  "duplicate",
  "Unique moderation must resolve first-class historical identities, not only venue aliases.",
);
assert.deepEqual(identityOnlyResult.items[0].conflictIds, [identityOnlyApproved._id]);

const providerIdentityTarget = event("provider-identity-target", {
  title: "Provider Identity Exhibition",
  venue: "Unmatched promoter wording",
  venueInstagramHandle: "former_museum",
});
const providerIdentityApproved = event("provider-identity-approved", {
  title: providerIdentityTarget.title,
  venue: learnedVenue.name,
  status: "approved",
});
const providerIdentityFixture = makeCtx({
  events: [providerIdentityTarget, providerIdentityApproved],
  venues: [{ ...learnedVenue, aliases: [] }],
  venueIdentities: [
    {
      _id: "venue-identity-provider",
      _creationTime: 1,
      active: true,
      kind: "provider_account",
      provider: "instagram",
      rawValue: "former_museum",
      normalizedValue: "former_museum",
      source: "manual",
      venueId: learnedVenue._id,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  sourceEvents: [providerIdentityTarget],
});
const providerIdentityResult = await classify(providerIdentityFixture, [
  reviewedItem(providerIdentityTarget),
]);
assert.equal(
  providerIdentityResult.items[0].disposition,
  "duplicate",
  "Unique moderation must resolve persisted secondary provider-account identities.",
);
assert.deepEqual(providerIdentityResult.items[0].conflictIds, [
  providerIdentityApproved._id,
]);

const persistedVenueTarget = event("persisted-venue-target", {
  title: "Canonical Identity Showcase",
  venue: "Promoter wording not present in aliases",
  venueId: learnedVenue._id,
  venueInstagramHandle: learnedVenue.instagramHandle,
});
const persistedVenueApproved = event("persisted-venue-approved", {
  title: persistedVenueTarget.title,
  venue: learnedVenue.name,
  venueId: learnedVenue._id,
  venueInstagramHandle: learnedVenue.instagramHandle,
  status: "approved",
});
const persistedVenueFixture = makeCtx({
  events: [persistedVenueTarget, persistedVenueApproved],
  venues: [learnedVenue],
  sourceEvents: [persistedVenueTarget],
});
const persistedVenueResult = await classify(persistedVenueFixture, [
  reviewedItem(persistedVenueTarget),
]);
assert.equal(
  persistedVenueResult.items[0].disposition,
  "duplicate",
  "Persisted canonical venueId/handle must take precedence over unmatched display text.",
);
assert.deepEqual(persistedVenueResult.items[0].conflictIds, [
  persistedVenueApproved._id,
]);

// Every bounded directory/cohort read takes one sentinel and fails closed if
// that sentinel exists.
const venueLimitTarget = event("venue-limit-target");
const venueLimitFixture = makeCtx({
  events: [venueLimitTarget],
  venues: Array.from({ length: 4_001 }, (_, index) => makeVenue(index)),
});
const venueLimitResult = await classify(venueLimitFixture, [
  reviewedItem(venueLimitTarget),
]);
assert.equal(venueLimitResult.complete, false);
assert.equal(venueLimitResult.items[0].reason, "indeterminate_venue_limit");
assert.ok(
  venueLimitFixture.reads.some(
    (item) => item.table === "venues" && item.limit === 4_001,
  ),
);

const identityLimitTarget = event("identity-limit-target");
const identityLimitVenue = makeVenue("identity-limit");
const identityLimitFixture = makeCtx({
  events: [identityLimitTarget],
  venues: [identityLimitVenue],
  venueIdentities: Array.from({ length: 4_000 }, (_, index) => ({
    _id: `identity-limit-${index}`,
    _creationTime: index,
    active: true,
    kind: "alias",
    rawValue: `Identity alias ${index}`,
    normalizedValue: `identity alias ${index}`,
    source: "manual",
    venueId: identityLimitVenue._id,
    createdAt: 1,
    updatedAt: 1,
  })),
});
const identityLimitResult = await classify(identityLimitFixture, [
  reviewedItem(identityLimitTarget),
]);
assert.equal(identityLimitResult.complete, false);
assert.equal(identityLimitResult.items[0].reason, "indeterminate_venue_limit");
assert.ok(
  identityLimitFixture.reads.some(
    (item) =>
      item.table === "venueIdentities" &&
      item.indexName === "by_active_kind" &&
      item.limit === 4_000,
    ),
);

const pendingLimitTarget = event("pending-limit-target");
const pendingLimitRows = Array.from({ length: 100 }, (_, index) =>
  event(`pending-limit-${index}`, {
    date: pendingLimitTarget.date,
    title: `Distinct Pending Candidate ${index}`,
    venue: `Distinct Pending Venue ${index}`,
  }),
);
const pendingLimitFixture = makeCtx({
  events: [pendingLimitTarget, ...pendingLimitRows],
  sourceEvents: [pendingLimitTarget],
});
const pendingLimitResult = await classify(pendingLimitFixture, [
  reviewedItem(pendingLimitTarget),
]);
assert.equal(pendingLimitResult.complete, false);
assert.equal(
  pendingLimitResult.items[0].reason,
  "indeterminate_pending_cohort_limit",
);

const approvedLimitTarget = event("approved-limit-target");
const approvedLimitRows = Array.from({ length: 101 }, (_, index) =>
  event(`approved-limit-${index}`, {
    date: approvedLimitTarget.date,
    title: `Distinct Approved Candidate ${index}`,
    venue: `Distinct Approved Venue ${index}`,
    status: "approved",
  }),
);
const approvedLimitFixture = makeCtx({
  events: [approvedLimitTarget, ...approvedLimitRows],
  sourceEvents: [approvedLimitTarget],
});
const approvedLimitResult = await classify(approvedLimitFixture, [
  reviewedItem(approvedLimitTarget),
]);
assert.equal(approvedLimitResult.complete, false);
assert.equal(
  approvedLimitResult.items[0].reason,
  "indeterminate_approved_cohort_limit",
);
assert.ok(
  approvedLimitFixture.reads.filter(
    (item) => item.indexName === "by_status_date" && item.limit === 101,
  ).length >= 2,
);

const originalDateNow = Date.now;
try {
  Date.now = () => AS_OF_MS;

  // A stale version anywhere in the requested batch rejects before the first
  // status patch or audit insert.
  const staleA = event("stale-a");
  const staleB = event("stale-b", { updatedAt: 200 });
  const staleFixture = makeCtx({ events: [staleA, staleB] });
  await assert.rejects(
    approveUniquePendingEvents._handler(staleFixture.ctx, {
      items: [reviewedItem(staleA), reviewedItem(staleB, 199)],
      moderationNote: MODERATION_NOTE,
    }),
    /changed since the reviewed version/iu,
  );
  assert.equal(staleFixture.patches.length, 0);
  assert.equal(staleFixture.audits.length, 0);

  const noLongerPending = event("no-longer-pending", { status: "approved" });
  const nonPendingPreflightFixture = makeCtx({
    events: [staleA, noLongerPending],
    sourceEvents: [staleA],
  });
  await assert.rejects(
    approveUniquePendingEvents._handler(nonPendingPreflightFixture.ctx, {
      items: [reviewedItem(staleA), reviewedItem(noLongerPending)],
      moderationNote: MODERATION_NOTE,
    }),
    /no longer pending/iu,
  );
  assert.equal(nonPendingPreflightFixture.patches.length, 0);
  assert.equal(nonPendingPreflightFixture.audits.length, 0);

  const invalidMutationFixture = makeCtx({ events: [invalidInputEvent] });
  await assert.rejects(
    approveUniquePendingEvents._handler(invalidMutationFixture.ctx, {
      items: [reviewedItem(invalidInputEvent, Number.MAX_SAFE_INTEGER + 1)],
      moderationNote: MODERATION_NOTE,
    }),
    /safe integers/iu,
  );
  assert.equal(invalidMutationFixture.patches.length, 0);
  assert.equal(invalidMutationFixture.audits.length, 0);
  await assert.rejects(
    approveUniquePendingEvents._handler(invalidMutationFixture.ctx, {
      items: [reviewedItem(invalidInputEvent), reviewedItem(invalidInputEvent)],
      moderationNote: MODERATION_NOTE,
    }),
    /IDs must be unique/iu,
  );
  await assert.rejects(
    approveUniquePendingEvents._handler(invalidMutationFixture.ctx, {
      items: Array.from({ length: 11 }, (_, index) => ({
        id: `mutation-too-many-${index}`,
        expectedUpdatedAt: 100,
      })),
      moderationNote: MODERATION_NOTE,
    }),
    /requires 1-10/iu,
  );
  await assert.rejects(
    approveUniquePendingEvents._handler(invalidMutationFixture.ctx, {
      items: [reviewedItem(invalidInputEvent)],
      moderationNote: "too short",
    }),
    /20-1000/iu,
  );
  assert.equal(invalidMutationFixture.patches.length, 0);
  assert.equal(invalidMutationFixture.audits.length, 0);

  // A safety-limit result for any item makes the whole mutation no-write.
  const incompleteFixture = makeCtx({
    events: [venueLimitTarget],
    venues: Array.from({ length: 4_001 }, (_, index) => makeVenue(index)),
  });
  const incompleteApproval = await approveUniquePendingEvents._handler(
    incompleteFixture.ctx,
    {
      items: [reviewedItem(venueLimitTarget)],
      moderationNote: MODERATION_NOTE,
    },
  );
  assert.equal(incompleteApproval.complete, false);
  assert.equal(incompleteFixture.patches.length, 0);
  assert.equal(incompleteFixture.audits.length, 0);

  for (const [label, fixture, target] of [
    ["pending", pendingLimitFixture, pendingLimitTarget],
    ["approved", approvedLimitFixture, approvedLimitTarget],
  ]) {
    const incompleteCohortApproval = await approveUniquePendingEvents._handler(
      fixture.ctx,
      {
        items: [reviewedItem(target)],
        moderationNote: MODERATION_NOTE,
      },
    );
    assert.equal(
      incompleteCohortApproval.complete,
      false,
      `${label} cohort sentinel must make the batch incomplete`,
    );
    assert.equal(fixture.patches.length, 0);
    assert.equal(fixture.audits.length, 0);
  }

  // Duplicate and ambiguous rows are classified/skipped and remain pending.
  const conflictFixture = makeCtx({
    events: [approvedDuplicateTarget, approvedDuplicate, ambiguousTarget, approvedAmbiguous],
    sourceEvents: [approvedDuplicateTarget, ambiguousTarget],
  });
  const conflictApproval = await approveUniquePendingEvents._handler(
    conflictFixture.ctx,
    {
      items: [reviewedItem(approvedDuplicateTarget), reviewedItem(ambiguousTarget)],
      moderationNote: MODERATION_NOTE,
    },
  );
  assert.equal(conflictApproval.complete, true);
  assert.deepEqual(conflictApproval.approvedIds, []);
  assert.deepEqual(
    conflictApproval.skipped.map((item) => item.disposition).sort(),
    ["ambiguous", "duplicate"],
  );
  assert.equal(conflictFixture.events.get(approvedDuplicateTarget._id).status, "pending");
  assert.equal(conflictFixture.events.get(ambiguousTarget._id).status, "pending");
  assert.equal(conflictFixture.patches.length, 0);
  assert.equal(conflictFixture.audits.length, 0);

  const pendingConflictFixture = makeCtx({
    events: [ambiguousTarget, pendingAmbiguous],
    sourceEvents: [ambiguousTarget],
  });
  const pendingConflictApproval = await approveUniquePendingEvents._handler(
    pendingConflictFixture.ctx,
    {
      items: [reviewedItem(ambiguousTarget)],
      moderationNote: MODERATION_NOTE,
    },
  );
  assert.deepEqual(pendingConflictApproval, {
    complete: true,
    approvedIds: [],
    skipped: [
      {
        id: ambiguousTarget._id,
        expectedUpdatedAt: ambiguousTarget.updatedAt,
        disposition: "ambiguous",
        reason: "ambiguous_same_date_occurrence",
        conflictIds: [pendingAmbiguous._id],
      },
    ],
  });
  assert.equal(pendingConflictFixture.events.get(ambiguousTarget._id).status, "pending");
  assert.equal(pendingConflictFixture.patches.length, 0);
  assert.equal(pendingConflictFixture.audits.length, 0);

  // The only approval path is an exact-version, source-grounded row with a
  // complete bounded cohort; it produces both the status patch and audit.
  const uniqueEvent = event("unique-source-grounded", {
    title: "Celestial Quartet",
    venue: "QA Observatory",
  });
  const uniqueFixture = makeCtx({ events: [uniqueEvent] });
  const uniqueApproval = await approveUniquePendingEvents._handler(
    uniqueFixture.ctx,
    {
      items: [reviewedItem(uniqueEvent)],
      moderationNote: MODERATION_NOTE,
    },
  );
  assert.equal(uniqueApproval.complete, true);
  assert.deepEqual(uniqueApproval.approvedIds, [uniqueEvent._id]);
  assert.deepEqual(uniqueApproval.skipped, []);
  assert.equal(uniqueFixture.events.get(uniqueEvent._id).status, "approved");
  assert.equal(
    uniqueFixture.patches.length,
    2,
    "Approval must persist moderation and refresh the derived publication state.",
  );
  assert.equal(uniqueFixture.audits.length, 1);
  assert.equal(uniqueFixture.audits[0].eventId, uniqueEvent._id);
  assert.equal(uniqueFixture.audits[0].action, "approved");
  assert.equal(uniqueFixture.audits[0].actor, "qa-owner");
  assert.equal(uniqueFixture.audits[0].note, MODERATION_NOTE);
  assert.deepEqual(JSON.parse(uniqueFixture.audits[0].patchJson), {
    status: "approved",
    policy: "unique_pending",
  });

  // A low or absent model score cannot exclude an otherwise source-confirmed
  // unique event. Exercise the registered approval mutation, including its audit.
  for (const confidence of [0, 0.2, 0.79, null]) {
    const candidate = event(
      `unique-confidence-${confidence === null ? "missing" : confidence * 100}`,
    );
    const fields = JSON.parse(candidate.normalizedFieldsJson);
    if (confidence !== null) fields.confidence = confidence;
    candidate.normalizedFieldsJson = JSON.stringify(fields);
    const fixture = makeCtx({ events: [candidate] });
    const approval = await approveUniquePendingEvents._handler(fixture.ctx, {
      items: [reviewedItem(candidate)],
      moderationNote: MODERATION_NOTE,
    });
    assert.equal(approval.complete, true);
    assert.deepEqual(approval.approvedIds, [candidate._id], JSON.stringify(approval));
    assert.deepEqual(approval.skipped, []);
    assert.equal(fixture.events.get(candidate._id).status, "approved");
    assert.equal(fixture.audits.length, 1);
    assert.equal(fixture.audits[0].action, "approved");
  }
} finally {
  Date.now = originalDateNow;
}

const eventsSource = read("convex/events.ts");
const moderationContractsSource = read("convex/eventDomain/contracts.ts");
const moderationCommandsSource = read(
  "convex/eventDomain/moderationCommands.ts",
);
const moderationReadsSource = read("convex/eventDomain/moderationReads.ts");
const moderationUniquenessSource = read(
  "convex/eventDomain/moderationUniqueness.ts",
);
const adminRouteSource = read("app/api/admin/events/route.ts");
const approvalRouteSource = read("app/api/admin/events/approve-unique/route.ts");
const fullApprovalRouteSource = read(
  "app/api/admin/events/approve-unique-all/route.ts",
);
const dashboardSource = read("components/admin/moderation-dashboard.tsx");
const authQaSource = read("scripts/qa-convex-auth-boundaries.mjs");
const packageJson = JSON.parse(read("package.json"));
const releaseCheckSource = read("scripts/release-check.mjs");

const validatorSource = section(
  moderationContractsSource,
  "export const pendingModerationUniquenessReviewItem",
  "export const promotionTier",
);
assert.match(
  validatorSource,
  /pendingModerationUniquenessReviewItem = v\.object\(\{\s*id: v\.id\("events"\),\s*expectedUpdatedAt: v\.number\(\),\s*\}\)/,
);
for (const disposition of [
  "unique",
  "duplicate",
  "ambiguous",
  "ineligible",
  "indeterminate",
]) {
  assert.match(validatorSource, new RegExp(`v\\.literal\\("${disposition}"\\)`));
}
for (const reason of [
  "unique_no_conflict",
  "duplicate_same_occurrence",
  "ambiguous_same_date_occurrence",
  "ineligible_title",
  "ineligible_invalid_date",
  "ineligible_expired_event",
  "ineligible_source_policy",
  "indeterminate_venue_limit",
  "indeterminate_pending_cohort_limit",
  "indeterminate_approved_cohort_limit",
  "indeterminate_batch_incomplete",
]) {
  assert.match(validatorSource, new RegExp(`v\\.literal\\("${reason}"\\)`));
}
assert.match(validatorSource, /complete: v\.boolean\(\)/);
assert.match(validatorSource, /approvedIds: v\.array\(v\.id\("events"\)\)/);
assert.match(validatorSource, /skipped: v\.array\(pendingModerationUniquenessClassification\)/);

const classifierSource = section(
  eventsSource,
  "export const classifyPendingModerationUniqueness",
  "export const getPublicApprovedEvent",
);
assert.match(classifierSource, /= query\(\{/);
assert.match(
  classifierSource,
  /args:\s*\{\s*items: v\.array\(pendingModerationUniquenessReviewItem\),\s*asOfMs: v\.number\(\),\s*serviceSecret: v\.optional\(v\.string\(\)\)/,
);
assert.match(classifierSource, /returns: pendingModerationUniquenessResult/);
assert.match(
  classifierSource,
  /handler: classifyPendingModerationUniquenessHandler/,
);
assert.match(
  moderationReadsSource,
  /await requireAdminOrServiceSecret\(ctx, args\.serviceSecret\)/,
);
assert.match(moderationReadsSource, /asOfMs: args\.asOfMs/);
assert.doesNotMatch(
  moderationReadsSource,
  /Date\.now\(\)/,
  "The query clock must be provided explicitly by the caller.",
);

const helperSource = moderationUniquenessSource;
assert.match(helperSource, /MAX_PENDING_MODERATION_UNIQUENESS_ITEMS/);
assert.match(helperSource, /Number\.isSafeInteger\(item\.expectedUpdatedAt\)/);
assert.match(helperSource, /Promise\.all\(items\.map\(\(item\) => ctx\.db\.get\(item\.id\)\)\)/);
assert.match(helperSource, /getBelgradeDayKey\(options\.asOfMs\)/);
assert.match(helperSource, /event\.date < currentBelgradeDay/);
assert.match(
  helperSource,
  /await loadBoundedPublicVenueResolverRows\(ctx\)/,
  "Moderation must use the same aggregate-bounded venue directory as ingestion.",
);
assert.match(
  helperSource,
  /withIndex\("by_status_date", \(q\) =>[\s\S]*?take\(MAX_PENDING_MODERATION_UNIQUENESS_DATE_COHORT_SIZE \+ 1\)/,
);
assert.match(helperSource, /indeterminate_pending_cohort_limit/);
assert.match(helperSource, /indeterminate_approved_cohort_limit/);
assert.doesNotMatch(helperSource, /\.collect\(\)/);

const approvalMutationSource = section(
  eventsSource,
  "export const approveUniquePendingEvents",
  "export const setEventStatus",
);
assert.match(approvalMutationSource, /= mutation\(\{/);
assert.match(
  approvalMutationSource,
  /args:\s*\{\s*items: v\.array\(pendingModerationUniquenessReviewItem\),\s*moderationNote: v\.string\(\),\s*reviewedBy: v\.optional\(v\.string\(\)\),\s*serviceSecret: v\.optional\(v\.string\(\)\)/,
);
assert.match(approvalMutationSource, /returns: approveUniquePendingEventsResult/);
assert.match(
  approvalMutationSource,
  /handler: approveUniquePendingEventsHandler/,
);
assert.match(
  moderationCommandsSource,
  /await requireAdminOrServiceSecret\(ctx, args\.serviceSecret\)/,
);
assert.match(moderationCommandsSource, /isAdminSubject\(reviewedBy\)/);
assert.match(moderationCommandsSource, /review\.result\.complete/);
assert.match(moderationCommandsSource, /writeEventAuditLog/);

// The admin GET route paginates at <=25 up to a hard 200, classifies in <=10,
// forwards one explicit clock, and degrades classifier failures into a visible
// incomplete queue instead of turning the entire moderation request into 500.
assert.match(adminRouteSource, /const MODERATION_PAGE_SIZE = 25/);
assert.match(adminRouteSource, /const MAX_MODERATION_EVENTS = 200/);
assert.match(
  adminRouteSource,
  /Math\.max\(1, Math\.min\(MAX_MODERATION_EVENTS, limitParam\)\)/,
);
assert.match(
  adminRouteSource,
  /const pageSize = Math\.min\(MODERATION_PAGE_SIZE, limit - events\.length\)/,
);
assert.match(adminRouteSource, /numItems: pageSize/);
assert.match(adminRouteSource, /const MAX_PENDING_UNIQUENESS_ITEMS = 10/);
assert.match(adminRouteSource, /buildSameDateModerationBatches\(/);
assert.match(adminRouteSource, /asOfMs:/);
const classificationRouteSource = section(
  adminRouteSource,
  "const pendingUniquenessById",
  "const mappedEvents",
);
assert.match(
  classificationRouteSource,
  /try\s*\{[\s\S]*classifyPendingModerationUniquenessQuery[\s\S]*\}\s*catch(?:\s*\([^)]*\))?\s*\{/,
  "Each classification chunk must degrade locally instead of reaching the outer 500 handler.",
);
assert.match(classificationRouteSource, /pendingUniquenessComplete = false/);
assert.match(adminRouteSource, /eventListComplete/);
assert.match(adminRouteSource, /pendingUniquenessComplete/);

assert.match(approvalRouteSource, /const MAX_UNIQUE_APPROVAL_ITEMS = 10/);
assert.match(approvalRouteSource, /eventId\?\.trim\(\)/);
assert.match(approvalRouteSource, /expectedUpdatedAt/);
assert.match(approvalRouteSource, /events:approveUniquePendingEvents/);
assert.match(approvalRouteSource, /isVersionConflict\(error\)[\s\S]*\? 409/);
assert.match(approvalRouteSource, /function validateApprovalResult/);
assert.match(approvalRouteSource, /approvedIds\.length \+ skipped\.length !== expectedVersionById\.size/);
assert.match(approvalRouteSource, /approvedIds\.some\(\(id\) => skippedIds\.has\(id\)\)/);
assert.match(approvalRouteSource, /item\.expectedUpdatedAt !== expectedVersionById\.get\(item\.id\)/);

// The full-queue route keeps Clerk admin identity, freezes a bounded complete
// pending snapshot, classifies every exact version before the first mutation,
// and reuses the same <=10 item authoritative mutation for publication.
assert.match(fullApprovalRouteSource, /requireAdminApiAccess\(\)/);
assert.match(fullApprovalRouteSource, /requireServiceSecret\(\)/);
assert.match(fullApprovalRouteSource, /createConvexHttpClient\(\)/);
assert.doesNotMatch(fullApprovalRouteSource, /createAuthenticatedConvexHttpClient/);
assert.match(fullApprovalRouteSource, /const PENDING_QUEUE_PAGE_SIZE = 10/);
assert.match(fullApprovalRouteSource, /const MAX_PENDING_QUEUE_ITEMS = 1_000/);
assert.match(
  fullApprovalRouteSource,
  /const MAX_UNIQUENESS_CLASSIFICATION_CHUNK_SIZE = 10/,
);
assert.match(fullApprovalRouteSource, /const UNIQUE_APPROVAL_CHUNK_SIZE = 5/);
assert.match(fullApprovalRouteSource, /minConfidence\?: number/);
assert.match(
  fullApprovalRouteSource,
  /result\.pageStatus !== undefined &&\s*result\.pageStatus !== null/,
);
assert.match(fullApprovalRouteSource, /minimumConfidence < 0/);
assert.match(fullApprovalRouteSource, /minimumConfidence > 1/);
assert.match(fullApprovalRouteSource, /const confidenceEligibleVersions =/);
assert.match(
  fullApprovalRouteSource,
  /minimumConfidence === undefined\s*\? pendingVersions/,
  "Omitting the optional confidence filter must classify every pending score, including missing scores.",
);
assert.match(fullApprovalRouteSource, /event\.confidenceScore >= minimumConfidence/);
assert.match(fullApprovalRouteSource, /buildSameDateModerationBatches\(/);
assert.match(fullApprovalRouteSource, /classificationChunks\.shift\(\)/);
assert.match(fullApprovalRouteSource, /if \(chunk\.length === 1\)/);
assert.match(fullApprovalRouteSource, /Math\.ceil\(chunk\.length \/ 2\)/);
assert.match(fullApprovalRouteSource, /classificationChunks\.unshift\(/);
assert.match(fullApprovalRouteSource, /classificationSplitCount \+= 1/);
assert.match(fullApprovalRouteSource, /events:listByStatusPaginated/);
assert.match(fullApprovalRouteSource, /events:classifyPendingModerationUniqueness/);
assert.match(fullApprovalRouteSource, /events:approveUniquePendingEvents/);
assert.match(fullApprovalRouteSource, /serviceSecret,/);
assert.match(fullApprovalRouteSource, /reviewedBy,/);
assert.match(fullApprovalRouteSource, /page\.pageStatus === "SplitRequired"/);
assert.match(fullApprovalRouteSource, /page\.continueCursor === cursor/);
assert.match(fullApprovalRouteSource, /if \(!queueComplete\)/);
assert.match(fullApprovalRouteSource, /const classificationAsOfMs = Date\.now\(\)/);
assert.match(fullApprovalRouteSource, /classification\.complete/);
assert.match(fullApprovalRouteSource, /const uniqueItems = classifications\.filter/);
assert.match(fullApprovalRouteSource, /item\.disposition === "unique"/);
assert.match(fullApprovalRouteSource, /validateApprovalResult/);
assert.doesNotMatch(fullApprovalRouteSource, /\.collect\(\)/);
const fullClassificationIndex = fullApprovalRouteSource.indexOf(
  "const classifications: PendingUniquenessItem[]",
);
const fullUniqueItemsIndex = fullApprovalRouteSource.indexOf(
  "const uniqueItems = classifications.filter",
);
const fullApprovalMutationIndex = fullApprovalRouteSource.indexOf(
  "await convex.mutation",
);
assert.ok(fullClassificationIndex >= 0);
assert.ok(fullUniqueItemsIndex > fullClassificationIndex);
assert.ok(fullApprovalMutationIndex > fullUniqueItemsIndex);

// The dashboard may display local duplicate context, but unique_pending and its
// bulk action must trust only the server disposition/version contract.
assert.match(dashboardSource, /unique_pending/);
assert.match(dashboardSource, /MODERATION_QUEUE_FETCH_LIMIT/);
assert.match(
  dashboardSource,
  /limit=\$\{MODERATION_QUEUE_FETCH_LIMIT\}/,
  "The selected visible item count must not truncate the server-verified queue load.",
);
assert.doesNotMatch(
  dashboardSource,
  /limit=\$\{visibleLimit\}/,
  "The visible item count is a presentation limit, not a queue-read limit.",
);
assert.match(
  dashboardSource,
  /const visibleEvents = useMemo\([\s\S]*selectVisibleModerationEvents\(filteredEvents, visibleLimit\)/,
);
assert.match(dashboardSource, /visibleEvents\.map\(\(event\) =>/);
assert.match(dashboardSource, /Showing \{visibleEvents\.length\} of \{filteredEvents\.length\}/);
assert.match(
  dashboardSource,
  /Filters still show the selected number[\s\S]*complete, bounded server scan/,
);
assert.match(dashboardSource, /const fetchRequestGenerationRef = useRef\(0\)/);
assert.match(dashboardSource, /new AbortController\(\)/);
assert.match(dashboardSource, /signal: requestController\.signal/);
assert.match(
  dashboardSource,
  /fetchRequestGenerationRef\.current === requestGeneration/,
);
assert.match(dashboardSource, /const \[hasLoadedQueue, setHasLoadedQueue\] = useState\(false\)/);
assert.match(
  dashboardSource,
  /setIsLoading\(true\);[\s\S]{0,200}setHasLoadedQueue\(false\);[\s\S]{0,300}setEvents\(\[\]\)/,
);
assert.match(dashboardSource, /setHasLoadedQueue\(true\)/);
assert.match(
  dashboardSource,
  /!isLoading && hasLoadedQueue && !eventListComplete/,
);
assert.match(
  dashboardSource,
  /More than \$\{MODERATION_QUEUE_FETCH_LIMIT\} \$\{status\} records exist/,
);
assert.match(dashboardSource, /limited to the safely loaded records/);
const uniqueCandidateSource = section(
  dashboardSource,
  "const uniquePendingEvents",
  "const visibleEvents",
);
assert.match(uniqueCandidateSource, /decoratedEvents\.filter/);
assert.doesNotMatch(uniqueCandidateSource, /visibleEvents/);
assert.doesNotMatch(
  uniqueCandidateSource,
  /confidenceScore|CONFIDENCE/,
  "Default unique approval candidates must not depend on a confidence score.",
);
assert.match(uniqueCandidateSource, /getModerationReviewDecision\(event\)\.group === "ready"/);
const uniqueFilterSource = section(dashboardSource, 'filterMode === "unique_pending" &&', 'if (filterMode === "issues"');
assert.match(uniqueFilterSource, /getModerationReviewDecision\(event\)\.group !== "ready"/);
assert.doesNotMatch(
  uniqueFilterSource,
  /duplicateConfidence|duplicateGroup|buildModerationDuplicateGroups|similarity/iu,
  "unique_pending must not recreate a client-authoritative uniqueness decision.",
);
assert.match(dashboardSource, /\/api\/admin\/events\/approve-unique-all/);
const bulkUiSource = section(dashboardSource, "async function approveUniquePendingEvents()", "async function approveReadyEvent");
assert.doesNotMatch(bulkUiSource, /minConfidence:|confidenceFilter|visibleEvents|filteredEvents/);
assert.match(bulkUiSource, /buildVerifiedApprovalNote\(uniqueApprovalNote\)/);
assert.doesNotMatch(bulkUiSource, /window\.confirm/);
assert.match(dashboardSource, /outside the current view and filters/);
assert.match(dashboardSource, /onClick=\{requestUniquePendingApproval\}/);
assert.match(dashboardSource, /onClick=\{cancelUniquePendingApproval\}/);
assert.match(dashboardSource, /onClick=\{\(\) => void approveUniquePendingEvents\(\)\}[\s\S]{0,100}Confirm approval/);
assert.match(dashboardSource, /actionInFlightFor !== null \|\| isUniqueApprovalConfirmationOpen/);
assert.match(dashboardSource, /Approve ready events/);
assert.match(dashboardSource, /Add an approval note \(optional\)/);
assert.match(dashboardSource, /Advanced filters and diagnostics/);
assert.match(dashboardSource, /event\.moderation\.status === "approved" \? <Link[\s\S]{0,200}href=\{`\/events\/\$\{event\.id\}`\}/);
assert.match(dashboardSource, /duplicate\.moderation\.status === "approved" \? \([\s\S]{0,220}href=\{`\/events\/\$\{duplicate\.id\}`\}/);
assert.match(
  dashboardSource,
  /useState<ConfidenceFilterMode>\("all"\)/,
);
assert.match(dashboardSource, /const HIGH_CONFIDENCE_FILTER_MIN = 0\.8/);
assert.doesNotMatch(
  dashboardSource,
  /AUTO_APPROVE_CONFIDENCE_THRESHOLD|Auto-approve strict/,
  "Optional confidence filters must not be presented as automatic approval thresholds.",
);
assert.match(dashboardSource, /HIGH_CONFIDENCE_FILTER_LABEL/);
assert.match(dashboardSource, /confidence\s+is informational/);
assert.match(dashboardSource, /Medium confidence \(0\.70-0\.79\)/);
assert.match(
  dashboardSource,
  /Duplicate, ambiguous, expired, ineligible, and indeterminate records will remain pending/,
);
assert.doesNotMatch(
  dashboardSource,
  /disabled=\{[\s\S]{0,300}!eventListComplete/,
  "An incomplete display window must not disable the separate full-queue scan.",
);
assert.doesNotMatch(
  dashboardSource,
  /disabled=\{[\s\S]{0,300}!pendingUniquenessComplete/,
  "A degraded display classification must not disable a fresh full-queue scan.",
);
assert.match(bulkUiSource, /const refreshed = await fetchEvents\(\)/);
assert.doesNotMatch(dashboardSource, /refreshed queue is authoritative/);

const responseReaderSource = ts.transpileModule(section(
  dashboardSource, "async function readModerationResponse", "export function ModerationDashboard",
), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const readModerationResponse = new Function(`${responseReaderSource}\nreturn readModerationResponse;`)();
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
const queueLoaderSource = ts.transpileModule(section(
  dashboardSource, "const fetchEvents = useCallback", "  useEffect(() => {\n    void fetchEvents();",
), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
for (const [response, expected] of [
  [jsonResponse({ events: [], eventListComplete: true, pendingUniquenessComplete: true }), true],
  [new Response("<!DOCTYPE html>", { status: 404, headers: { "content-type": "text/html" } }), false],
  [new Response("<!DOCTYPE html>", { headers: { "content-type": "application/json" } }), false],
  [{ redirected: true }, false],
  [jsonResponse({ events: null }), false],
]) {
  const states = {};
  const setters = Object.fromEntries([
    "setIsLoading", "setHasLoadedQueue", "setError", "setUniqueApprovalResult", "setEvents",
    "setEventListComplete", "setPendingUniquenessComplete", "setDuplicateContextEvents",
    "setIsDuplicateContextDegraded", "setIsDuplicateContextTruncated",
  ].map((key) => [key, (value) => { states[key] = value; }]));
  const context = {
    ...setters, useCallback: (callback) => callback, status: "pending", MODERATION_QUEUE_FETCH_LIMIT,
    fetchRequestGenerationRef: { current: 0 }, fetchAbortControllerRef: { current: null },
    readModerationResponse, fetch: async () => response,
  };
  const loader = new Function(...Object.keys(context), `${queueLoaderSource}\nreturn fetchEvents;`)(...Object.values(context));
  assert.equal(await loader(), expected, "The actual queue loader must report whether it loaded usable current data.");
  assert.equal(states.setHasLoadedQueue, expected);
  if (!expected) assert.doesNotMatch(states.setError, /DOCTYPE|Unexpected token|not valid JSON/);
}
const bulkHandlersSource = ts.transpileModule(section(
  dashboardSource, "function requestUniquePendingApproval", "async function approveReadyEvent",
), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const completeBulkResult = {
  complete: true, reviewedCount: 10, confidenceEligibleCount: 10, belowConfidenceCount: 0,
  approvedCount: 2, skippedDuringApprovalCount: 0, minimumConfidence: null,
  dispositionCounts: { unique: 2, duplicate: 3, ambiguous: 1, ineligible: 3, indeterminate: 1 },
};
function makeBulkHandlers({ response, throwTransport = false, refreshSucceeds = true, waitForTransport } = {}) {
  const calls = [];
  const states = { error: null, success: null, action: null, confirmation: false, refreshes: 0 };
  const phase = { current: "idle" };
  const context = {
    uniqueApprovalPhaseRef: phase, isAnyActionInFlight: false, actionInFlightFor: null,
    isLoading: false, hasLoadedQueue: true, status: "pending",
    // Zero ready rows in a truncated view must still permit the separate scan.
    eventListComplete: false, pendingUniquenessComplete: false, uniquePendingEvents: [],
    uniqueApprovalNote: "", UNIQUE_BULK_APPROVE_ACTION_ID: "bulk",
    buildVerifiedApprovalNote, readModerationResponse,
    setIsUniqueApprovalConfirmationOpen: (value) => { states.confirmation = value; },
    setActionInFlightFor: (value) => { states.action = value; },
    setError: (value) => { states.error = value; },
    setUniqueApprovalResult: (value) => { states.success = value; },
    fetchEvents: async () => { states.refreshes++; states.error = null; states.success = null; return refreshSucceeds; },
    fetch: async (url, options) => {
      calls.push({ url, method: options.method, redirect: options.redirect, body: JSON.parse(options.body) });
      if (waitForTransport) await waitForTransport;
      if (throwTransport) throw new TypeError("Failed to fetch");
      return response ?? jsonResponse(completeBulkResult);
    },
  };
  const handlers = new Function(...Object.keys(context), `${bulkHandlersSource}\nreturn {
    request: requestUniquePendingApproval, cancel: cancelUniquePendingApproval, confirm: approveUniquePendingEvents,
  };`)(...Object.values(context));
  return { ...handlers, calls, states, phase };
}
const cancelledBulk = makeBulkHandlers();
await cancelledBulk.confirm();
cancelledBulk.request();
cancelledBulk.request();
assert.equal(cancelledBulk.states.confirmation, true);
assert.equal(cancelledBulk.calls.length, 0, "Opening inline confirmation must not send a POST.");
cancelledBulk.cancel();
await cancelledBulk.confirm();
assert.equal(cancelledBulk.calls.length, 0, "Cancel plus a stale confirm callback must not send a POST.");
assert.equal(cancelledBulk.states.confirmation, false);

let releaseBulkTransport;
const repeatedBulk = makeBulkHandlers({ waitForTransport: new Promise((resolve) => { releaseBulkTransport = resolve; }) });
repeatedBulk.request();
const firstBulk = repeatedBulk.confirm();
await repeatedBulk.confirm();
repeatedBulk.cancel();
repeatedBulk.request();
assert.equal(repeatedBulk.phase.current, "submitting");
assert.equal(repeatedBulk.calls.length, 1, "Repeated clicks before React renders must send exactly one POST.");
releaseBulkTransport();
await firstBulk;
await repeatedBulk.confirm();
assert.deepEqual(repeatedBulk.calls, [{
  url: "/api/admin/events/approve-unique-all", method: "POST", redirect: "manual",
  body: { moderationNote: buildVerifiedApprovalNote("") },
}]);
assert.equal(repeatedBulk.states.refreshes, 1);
assert.equal(repeatedBulk.states.error, null);
assert.match(repeatedBulk.states.success, /Approved 2 server-verified unique events/);
assert.equal(repeatedBulk.phase.current, "idle");

for (const refreshSucceeds of [true, false]) {
  for (const response of [
    new Response("<!DOCTYPE html><html>Sign in</html>", { status: 404, headers: { "content-type": "text/html" } }),
    new Response("<!DOCTYPE html><html>Sign in</html>", { status: 200, headers: { "content-type": "text/html" } }),
    new Response("<!DOCTYPE html>", { status: 200, headers: { "content-type": "application/json" } }),
    { redirected: true }, { type: "opaqueredirect" },
  ]) {
    const run = makeBulkHandlers({ response, refreshSucceeds });
    run.request(); await run.confirm(); await run.confirm();
    assert.equal(run.calls.length, 1);
    assert.match(run.states.error, /Approval could not be confirmed/);
    assert.match(run.states.error, /sign in again if needed/i);
    assert.doesNotMatch(run.states.error, /DOCTYPE|Unexpected token|not valid JSON|no approvals/i);
    assert.equal(run.states.error.includes("The queue was refreshed."), refreshSucceeds);
    assert.equal(run.states.error.includes("The queue could not be refreshed."), !refreshSucceeds);
    assert.equal(run.states.success, null);
  }
}
const lostBulk = makeBulkHandlers({ throwTransport: true, refreshSucceeds: false });
lostBulk.request(); await lostBulk.confirm(); await lostBulk.confirm();
assert.equal(lostBulk.calls.length, 1);
assert.match(lostBulk.states.error, /Approval could not be confirmed/);
assert.doesNotMatch(lostBulk.states.error, /Failed to fetch|queue was refreshed/);
const completedWithoutRefresh = makeBulkHandlers({ refreshSucceeds: false });
completedWithoutRefresh.request(); await completedWithoutRefresh.confirm();
assert.match(completedWithoutRefresh.states.success, /Approved 2/);
assert.match(completedWithoutRefresh.states.error, /Approval completed, but the queue could not be refreshed/);

// Run the actual component's ready-row handler against a fake transport. This
// verifies request identity/version, refresh after uncertain writes, and no
// prompt or retry without duplicating the implementation in a test helper.
const readyHandlerSource = ts.transpileModule(section(
  dashboardSource, "async function approveReadyEvent", "async function removeApprovedEvent",
), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const readyRow = {
  id: "ready-event", title: "Source-confirmed show", updatedAt: 123,
  moderation: { status: "pending" },
  pendingUniqueness: { id: "ready-event", expectedUpdatedAt: 123, disposition: "unique", reason: "unique_same_date_cohort" },
};
async function runReadyHandler({ event = readyRow, note = "", result, response, throwTransport = false, refreshSucceeds = true, phase = "idle" } = {}) {
  const calls = [];
  const states = { error: null, success: null, action: null, refreshes: 0 };
  const handler = new Function(
    "getModerationReviewDecision", "buildVerifiedApprovalNote", "uniqueApprovalNote",
    "fetch", "fetchEvents", "setActionInFlightFor", "setError", "setUniqueApprovalResult",
    "uniqueApprovalPhaseRef", "isAnyActionInFlight", "readModerationResponse",
    `${readyHandlerSource}\nreturn approveReadyEvent;`,
  )(
    getModerationReviewDecision, buildVerifiedApprovalNote, note,
    async (url, options) => {
      calls.push({ url, method: options.method, body: JSON.parse(options.body) });
      if (throwTransport) throw new Error("Lost acknowledgement");
      return response ?? jsonResponse(result ?? { complete: true, approvedIds: [readyRow.id], skipped: [] });
    },
    async () => { states.refreshes++; states.error = null; states.success = null; return refreshSucceeds; },
    (value) => { states.action = value; },
    (value) => { states.error = value; },
    (value) => { states.success = value; },
    { current: phase }, false, readModerationResponse,
  );
  await handler(event);
  return { calls, states };
}
for (const confidenceScore of [null, 0, 0.2, 0.8, 0.95]) {
  const { calls, states } = await runReadyHandler({ event: { ...readyRow, confidenceScore } });
  assert.deepEqual(calls, [{
    url: "/api/admin/events/approve-unique", method: "POST",
    body: { items: [{ eventId: readyRow.id, expectedUpdatedAt: 123 }], moderationNote: buildVerifiedApprovalNote("") },
  }]);
  assert.match(states.success, /Approved Source-confirmed show/);
  assert.equal(states.error, null);
  assert.equal(states.refreshes, 1);
  assert.equal(states.action, null);
}
assert.equal((await runReadyHandler({ note: "Checked poster." })).calls[0].body.moderationNote, buildVerifiedApprovalNote("Checked poster."));
for (const phase of ["confirming", "submitting"]) {
  assert.equal((await runReadyHandler({ phase })).calls.length, 0,
    "A ready-row action must not race bulk confirmation or submission.");
}
for (const event of [
  { ...readyRow, updatedAt: 124 }, { ...readyRow, pendingUniqueness: null },
  { ...readyRow, pendingUniqueness: { ...readyRow.pendingUniqueness, disposition: "duplicate" } },
]) {
  assert.equal((await runReadyHandler({ event })).calls.length, 0);
}
for (const [disposition, reason] of [
  ["duplicate", "duplicate_same_occurrence"], ["ambiguous", "ambiguous_same_date_occurrence"],
  ["ineligible", "ineligible_source_policy"], ["indeterminate", "indeterminate_approved_cohort_limit"],
]) {
  const { calls, states } = await runReadyHandler({ result: {
    complete: true, approvedIds: [],
    skipped: [{ ...readyRow.pendingUniqueness, disposition, reason }],
  } });
  assert.equal(calls.length, 1);
  assert.match(states.error, /^Not approved\./);
  assert.equal(states.success, null);
  assert.equal(states.refreshes, 1);
}
for (const options of [
  { throwTransport: true },
  { result: { complete: false, approvedIds: [], skipped: [] } },
  { result: { complete: true, approvedIds: ["other-event"], skipped: [] } },
]) {
  const { calls, states } = await runReadyHandler(options);
  assert.equal(calls.length, 1, "An uncertain mutation must never be retried.");
  assert.ok(states.error);
  assert.equal(states.success, null);
  assert.equal(states.refreshes, 1, "Refresh state after a failed or uncertain response.");
  assert.equal(states.action, null);
}
for (const response of [
  new Response("<!DOCTYPE html>", { status: 404, headers: { "content-type": "text/html" } }),
  { type: "opaqueredirect" },
]) {
  const { calls, states } = await runReadyHandler({ response, refreshSucceeds: false });
  assert.equal(calls.length, 1);
  assert.match(states.error, /Approval could not be confirmed/);
  assert.match(states.error, /queue could not be refreshed/);
  assert.doesNotMatch(states.error, /DOCTYPE|Unexpected token|queue was refreshed/);
}
const manualUiSource = section(dashboardSource, "async function updateStatus", "async function copyText");
assert.match(manualUiSource, /window\.prompt/);
assert.match(manualUiSource, /moderationNote\?\.length \?\? 0\) < 20/);
assert.match(manualUiSource, /\/api\/admin\/events\/moderate/);

assert.match(authQaSource, /classifyPendingModerationUniqueness/);
assert.match(authQaSource, /approveUniquePendingEvents/);
assert.ok(
  packageJson.scripts["qa:moderation-unique-approval"]?.includes(
    "qa-moderation-unique-approval.mjs",
  ),
);
assert.match(releaseCheckSource, /qa:moderation-unique-approval/);

console.log(
  "QA passed: unique pending approval is server-authoritative, bounded, versioned, source-grounded, and fail-closed.",
);
