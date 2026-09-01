import assert from "node:assert/strict";
import {
  getPublicApprovedEvent,
  listPublicEventsWindow,
  setEventStatuses,
} from "../convex/events.ts";
import { isCanonicallyGroundedApprovedEvent } from "../convex/publicEventGrounding.ts";
import {
  hasCompleteSourceGroundingAttestation,
  hasHumanReviewedLegacySourceAttestation,
  hasHumanReviewedStructuredSourceAttestation,
  hasHumanReviewableLegacySourceAttestation,
  hasHumanReviewableStructuredSourceAttestation,
} from "../lib/events/event-update-precondition.ts";

process.env.ADMIN_CLERK_USER_IDS = "qa-owner";

const fixturePostedAt = "2026-07-15T12:00:00.000Z";
const fixtureCaption =
  "Nastupa Concert one 1. avgusta u 20:00 @ Shared Venue uz Artist one; Nastupa Different billed concert 1. avgusta u 22:00 @ Shared Venue uz Artist two";
const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);
const futureBeforeDate = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);

function groundingJson(item) {
  return JSON.stringify({
    title: item.title,
    time: item.time,
    artists: item.artists,
    sourceOccurrenceKey: item.sourceOccurrenceKey,
    sourceGroundingSourceKind: "caption",
    sourceGroundingSourceCaption: item.sourceCaption,
    sourceGroundingInstagramPostId: item.instagramPostId,
    sourceGroundingInstagramPostUrl: item.instagramPostUrl,
    sourceGroundingInstagramHandle: item.venueInstagramHandle,
    sourceGroundingVersion: 4,
    sourceGroundingEvidence: "instagram_caption",
    approvalTitleSensible: true,
    approvalCaptionSourceCoherent: true,
    sourceGroundingVerified: true,
    sourceGroundingTitleVerified: true,
    sourceGroundingDateVerified: true,
    sourceGroundingIdentityVerified: true,
    sourceGroundingIdentityContextVerified: true,
    sourceGroundingTimeVerified: true,
    sourceGroundingArtistsVerified: true,
    sourceGroundingRowVerified: true,
    moderationAutoApproved: false,
    moderationPendingReasons: ["human_review"],
    moderationSignals: [],
    moderationConfidenceScore: 0.5,
    normalizedDate: item.date,
    normalizedVenue: item.venue,
    normalizedIsValid: true,
    titleUsedFallback: false,
    dateSuspiciousYear: false,
    dateConfidence: "high",
    missingImage: false,
    moderationAllowMissingImage: false,
  });
}

function event(id, overrides = {}) {
  const base = {
    _id: id,
    _creationTime: 1,
    title: `Concert ${id}`,
    date: "2026-08-01",
    time: "20:00",
    venue: "Shared Venue",
    venueInstagramHandle: "qa_venue",
    artists: [`Artist ${id}`],
    eventType: "music",
    imageUrl: "https://example.com/event.jpg",
    status: "pending",
    createdAt: 1,
    updatedAt: 1,
    instagramPostId: `post-${id}`,
    instagramPostUrl: `https://www.instagram.com/p/post-${id}/`,
    sourceCaption: fixtureCaption,
    sourcePostedAt: fixturePostedAt,
    sourceOccurrenceKey: `occ-${id}`,
  };
  const merged = { ...base, ...overrides };
  return {
    ...merged,
    normalizedFieldsJson: overrides.normalizedFieldsJson ?? groundingJson(merged),
  };
}

function makeCtx(initialEvents, initialVenues = []) {
  const events = new Map(initialEvents.map((item) => [item._id, structuredClone(item)]));
  const venues = new Map(initialVenues.map((item) => [item._id, structuredClone(item)]));
  const posts = new Map(
    initialEvents.map((item) => [
      `${item.venueInstagramHandle}:${item.instagramPostId}`,
      {
        handle: item.venueInstagramHandle,
        username: item.venueInstagramHandle,
        postId: item.instagramPostId,
        instagramPostUrl: item.instagramPostUrl,
        caption: item.sourceCaption,
        postedAt: item.sourcePostedAt,
        ...(item.rawExtractionJson
          ? {
              analysisResultJson: item.rawExtractionJson,
              analysisRevision: 1,
              sourceRevision: 1,
              analysisContractVersion: "event_evidence_v2",
              analysisIsEvent: true,
              analysisModel: "gpt-5-mini-2025-08-07",
            }
          : {}),
      },
    ]),
  );
  const audits = [];
  const filterRows = (rows, filters) =>
    rows.filter((row) =>
      filters.every(({ field, operator, value }) => {
        if (operator === "eq") return row[field] === value;
        if (operator === "gte") return row[field] >= value;
        if (operator === "lt") return row[field] < value;
        return false;
      }),
    );
  const query = (table) => {
    const rows = () =>
      table === "events"
        ? [...events.values()]
        : table === "scrapedPosts"
          ? [...posts.values()]
          : table === "venues"
            ? [...venues.values()]
          : [];
    return {
      async collect() {
        return rows();
      },
      async take(limit) {
        return rows().slice(0, limit);
      },
      withIndex(_name, applyIndex) {
        const filters = [];
        const chain = {
          eq(field, value) {
            filters.push({ field, operator: "eq", value });
            return chain;
          },
          gte(field, value) {
            filters.push({ field, operator: "gte", value });
            return chain;
          },
          lt(field, value) {
            filters.push({ field, operator: "lt", value });
            return chain;
          },
        };
        applyIndex(chain);
        return {
          async collect() {
            return filterRows(rows(), filters);
          },
          async first() {
            return filterRows(rows(), filters)[0] ?? null;
          },
          async take(limit) {
            return filterRows(rows(), filters).slice(0, limit);
          },
          async paginate() {
            return {
              page: filterRows(rows(), filters),
              isDone: true,
              continueCursor: "",
            };
          },
        };
      },
    };
  };
  return {
    ctx: {
      auth: {
        async getUserIdentity() {
          return { subject: "qa-owner" };
        },
      },
      db: {
        normalizeId(table, id) {
          return table === "events" && events.has(id) ? id : null;
        },
        async get(id) {
          return events.get(id) ?? null;
        },
        query,
        async patch(id, patch) {
          const current = events.get(id);
          if (!current) throw new Error(`missing event ${id}`);
          events.set(id, { ...current, ...patch });
        },
        async insert(table, value) {
          assert.equal(table, "eventAuditLog");
          audits.push(value);
          return `audit-${audits.length}`;
        },
      },
    },
    events,
    venues,
    posts,
    audits,
  };
}

async function moderate(initialEvents, args, initialVenues = []) {
  const state = makeCtx(initialEvents, initialVenues);
  const result = await setEventStatuses._handler(state.ctx, {
    reviewedBy: "QA owner",
    moderationNote: "source-reviewed distinct occurrences",
    ...args,
  });
  return { ...state, result };
}

const pair = [
  event("one", {
    instagramPostId: "shared-post",
    instagramPostUrl: "https://www.instagram.com/p/shared-post/",
    sourceOccurrenceKey: "shared-occurrence-one",
  }),
  event("two", {
    title: "Different billed concert",
    time: "22:00",
    instagramPostId: "shared-post",
    instagramPostUrl: "https://www.instagram.com/p/shared-post/",
    sourceOccurrenceKey: "shared-occurrence-two",
  }),
];

const defaultBatch = await moderate(pair, {
  ids: ["one", "two"],
  status: "approved",
});
assert.deepEqual(defaultBatch.result, { updatedCount: 2, skippedCount: 0 });
assert.equal(defaultBatch.events.get("one").status, "approved");
assert.equal(defaultBatch.events.get("two").status, "approved");

const distinctBatch = await moderate(pair, {
  ids: ["one", "two"],
  status: "approved",
  approveAsDistinctSameVenueDateBatch: true,
});
assert.deepEqual(distinctBatch.result, { updatedCount: 2, skippedCount: 0 });
assert.deepEqual(
  [distinctBatch.events.get("one").status, distinctBatch.events.get("two").status],
  ["approved", "approved"],
);
assert.equal(distinctBatch.audits.length, 2);
const manuallyApprovedRow = distinctBatch.events.get("one");
assert.equal(
  hasCompleteSourceGroundingAttestation(manuallyApprovedRow.normalizedFieldsJson, manuallyApprovedRow),
  true,
  "Human approval fixture must retain a complete bound source attestation.",
);
assert.equal(
  await isCanonicallyGroundedApprovedEvent(distinctBatch.ctx, manuallyApprovedRow),
  true,
  "Authenticated human review plus canonical persisted source must authorize visibility.",
);
const manuallyApprovedPublicEvent = await getPublicApprovedEvent._handler(distinctBatch.ctx, {
  id: "one",
});
assert.equal(
  manuallyApprovedPublicEvent?._id,
  "one",
  "A canonically grounded human approval must be public without machine auto-approval.",
);
assert.equal(distinctBatch.events.get("one").reviewedBy, "QA owner");

const legacyHumanEvent = event("legacy-human", {
  title: "Legacy source-reviewed event",
  date: futureDate,
  time: "TBD",
  artists: [],
});
legacyHumanEvent.normalizedFieldsJson = JSON.stringify({
  title: legacyHumanEvent.title,
  time: legacyHumanEvent.time,
  artists: legacyHumanEvent.artists,
  sourceGroundingSourceKind: "caption",
  sourceGroundingSourceCaption: legacyHumanEvent.sourceCaption,
  sourceGroundingInstagramPostId: legacyHumanEvent.instagramPostId,
  sourceGroundingInstagramPostUrl: legacyHumanEvent.instagramPostUrl,
  sourceGroundingInstagramHandle: legacyHumanEvent.venueInstagramHandle,
  sourceGroundingVersion: 4,
  sourceGroundingEvidence: "instagram_caption",
  sourceGroundingVerified: false,
  approvalCaptionSourceCoherent: false,
  moderationPendingReasons: [
    "requires_human_approval",
    "unverified_core_event_source",
    "caption_source_event_mismatch",
  ],
  normalizedDate: legacyHumanEvent.date,
  normalizedVenue: legacyHumanEvent.venue,
  normalizedIsValid: true,
  titleUsedFallback: false,
  dateSuspiciousYear: false,
});
assert.equal(
  hasHumanReviewableLegacySourceAttestation(
    legacyHumanEvent.normalizedFieldsJson,
    legacyHumanEvent,
  ),
  true,
  "A future, source-bound legacy row must be eligible for explicit human review.",
);
const legacyHumanApproval = await moderate([legacyHumanEvent], {
  ids: ["legacy-human"],
  status: "approved",
});
assert.deepEqual(legacyHumanApproval.result, { updatedCount: 1, skippedCount: 0 });
const approvedLegacyHuman = legacyHumanApproval.events.get("legacy-human");
assert.equal(approvedLegacyHuman.status, "approved");
const approvedLegacyNormalizedFieldsJson = approvedLegacyHuman.normalizedFieldsJson;
assert.equal(
  approvedLegacyHuman.humanReviewedLegacySourcePolicyVersion,
  1,
  "The admin mutation must persist a schema-level policy marker as well as JSON evidence.",
);
assert.equal(
  hasHumanReviewedLegacySourceAttestation(
    approvedLegacyHuman.normalizedFieldsJson,
    approvedLegacyHuman,
  ),
  true,
  "The admin mutation must mark the exact human-review policy used for public revalidation.",
);
assert.equal(
  await isCanonicallyGroundedApprovedEvent(legacyHumanApproval.ctx, approvedLegacyHuman),
  true,
  "Explicit human review plus exact persisted legacy source must authorize visibility.",
);
const publicLegacyPage = await listPublicEventsWindow._handler(legacyHumanApproval.ctx, {
  fromDate: futureDate,
  beforeDate: futureBeforeDate,
  paginationOpts: { numItems: 10, cursor: null },
});
assert.deepEqual(
  publicLegacyPage.page.map((item) => item._id),
  ["legacy-human"],
  "Marked human-reviewed legacy events must pass the real public list path.",
);
legacyHumanApproval.posts.get("qa_venue:post-legacy-human").caption =
  "The persisted source changed after approval.";
const hiddenAfterSourceChange = await listPublicEventsWindow._handler(
  legacyHumanApproval.ctx,
  {
    fromDate: futureDate,
    beforeDate: futureBeforeDate,
    paginationOpts: { numItems: 10, cursor: null },
  },
);
assert.deepEqual(
  hiddenAfterSourceChange.page,
  [],
  "Marked legacy approvals must fail closed when the persisted source changes.",
);
legacyHumanApproval.posts.get("qa_venue:post-legacy-human").caption = fixtureCaption;
legacyHumanApproval.events.get("legacy-human").title = "Tampered public title";
const hiddenAfterEventTamper = await listPublicEventsWindow._handler(
  legacyHumanApproval.ctx,
  {
    fromDate: futureDate,
    beforeDate: futureBeforeDate,
    paginationOpts: { numItems: 10, cursor: null },
  },
);
assert.deepEqual(
  hiddenAfterEventTamper.page,
  [],
  "A marked legacy event must not bypass canonical checks after its own fields change.",
);
legacyHumanApproval.events.get("legacy-human").title = legacyHumanEvent.title;
legacyHumanApproval.events.get("legacy-human").normalizedFieldsJson = "{corrupted";
const hiddenAfterJsonCorruption = await listPublicEventsWindow._handler(
  legacyHumanApproval.ctx,
  {
    fromDate: futureDate,
    beforeDate: futureBeforeDate,
    paginationOpts: { numItems: 10, cursor: null },
  },
);
assert.deepEqual(
  hiddenAfterJsonCorruption.page,
  [],
  "The durable schema marker must force canonical checks when normalized evidence is corrupted.",
);
legacyHumanApproval.events.get("legacy-human").normalizedFieldsJson =
  approvedLegacyNormalizedFieldsJson;
delete legacyHumanApproval.events.get("legacy-human")
  .humanReviewedLegacySourcePolicyVersion;
const hiddenAfterSchemaMarkerRemoval = await listPublicEventsWindow._handler(
  legacyHumanApproval.ctx,
  {
    fromDate: futureDate,
    beforeDate: futureBeforeDate,
    paginationOpts: { numItems: 10, cursor: null },
  },
);
assert.deepEqual(
  hiddenAfterSchemaMarkerRemoval.page,
  [],
  "A JSON-only legacy review marker must fail closed when its durable schema marker is missing.",
);
const corruptedV5Event = event("corrupted-v5", {
  date: futureDate,
  status: "approved",
});
corruptedV5Event.normalizedFieldsJson = JSON.stringify({
  ...JSON.parse(corruptedV5Event.normalizedFieldsJson),
  extractionContractVersion: undefined,
  sourceGroundingVersion: 5,
  sourceGroundingEvidence: "persisted_openai_event_evidence_v2",
});
const corruptedV5State = makeCtx([corruptedV5Event]);
const corruptedV5PublicPage = await listPublicEventsWindow._handler(corruptedV5State.ctx, {
  fromDate: futureDate,
  beforeDate: futureBeforeDate,
  paginationOpts: { numItems: 10, cursor: null },
});
assert.deepEqual(
  corruptedV5PublicPage.page,
  [],
  "Any v5 source marker must force canonical structured-evidence revalidation.",
);
await assert.rejects(
  setEventStatuses._handler(makeCtx([legacyHumanEvent]).ctx, {
    ids: ["legacy-human"],
    status: "approved",
    moderationNote: "too short",
  }),
  /substantive moderation note/i,
);
const pastLegacyHuman = {
  ...legacyHumanEvent,
  date: "2000-01-01",
};
pastLegacyHuman.normalizedFieldsJson = JSON.stringify({
  ...JSON.parse(legacyHumanEvent.normalizedFieldsJson),
  normalizedDate: pastLegacyHuman.date,
});
assert.equal(
  hasHumanReviewableLegacySourceAttestation(
    pastLegacyHuman.normalizedFieldsJson,
    pastLegacyHuman,
  ),
  false,
  "Human review must not make an expired legacy event public.",
);
assert.equal(
  hasHumanReviewableLegacySourceAttestation(
    JSON.stringify({
      ...JSON.parse(legacyHumanEvent.normalizedFieldsJson),
      normalizedDate: "2026-02-31",
    }),
    { ...legacyHumanEvent, date: "2026-02-31" },
  ),
  false,
  "Human review must reject impossible calendar dates.",
);
assert.equal(
  hasHumanReviewableLegacySourceAttestation(
    JSON.stringify({
      ...JSON.parse(legacyHumanEvent.normalizedFieldsJson),
      sourceGroundingVersion: 5,
      sourceGroundingEvidence: "persisted_openai_event_evidence_v2",
    }),
    legacyHumanEvent,
  ),
  false,
  "Structured v2 rows must remain on the exact v2 evidence path.",
);

const structuredRawExtractionJson = JSON.stringify({
  extraction_contract_version: "event_evidence_v2",
  is_event: true,
});
const structuredHumanEvent = event("structured-human", {
  title: "I Bog stvori trans",
  date: futureDate,
  time: "20:00",
  venue: "Baza Kulturnih Zbivanja",
  artists: ["Simiona Rakića"],
  rawExtractionJson: structuredRawExtractionJson,
});
structuredHumanEvent.normalizedFieldsJson = JSON.stringify({
  extractionContractVersion: "event_evidence_v2",
  extractionIsEvent: true,
  sourceGroundingVersion: 5,
  sourceGroundingEvidence: "persisted_openai_event_evidence_v2",
  sourceGroundingSourceCaption: structuredHumanEvent.sourceCaption,
  sourceGroundingInstagramPostId: structuredHumanEvent.instagramPostId,
  sourceGroundingInstagramPostUrl: structuredHumanEvent.instagramPostUrl,
  sourceGroundingInstagramHandle: structuredHumanEvent.venueInstagramHandle,
  sourceOccurrenceKey: structuredHumanEvent.sourceOccurrenceKey,
  sourceOccurrenceSourceFingerprint: "instagram-source-v2:qa",
  title: structuredHumanEvent.title,
  normalizedDate: structuredHumanEvent.date,
  time: structuredHumanEvent.time,
  normalizedVenue: structuredHumanEvent.venue,
  artists: structuredHumanEvent.artists,
  normalizedIsValid: true,
  dateSuspiciousYear: false,
  moderationPendingReasons: ["requires_human_approval", "unusable_event_title"],
});
assert.equal(
  hasHumanReviewableStructuredSourceAttestation(
    structuredHumanEvent.normalizedFieldsJson,
    structuredHumanEvent,
  ),
  true,
  "A current, exact v2 source row must be eligible for explicit human review.",
);
const structuredHumanApproval = await moderate([structuredHumanEvent], {
  ids: ["structured-human"],
  status: "approved",
});
assert.deepEqual(structuredHumanApproval.result, { updatedCount: 1, skippedCount: 0 });
const approvedStructuredHuman = structuredHumanApproval.events.get("structured-human");
assert.equal(approvedStructuredHuman.status, "approved");
assert.equal(
  approvedStructuredHuman.humanReviewedStructuredSourcePolicyVersion,
  1,
  "Structured human approval must persist its durable schema marker.",
);
assert.equal(
  hasHumanReviewedStructuredSourceAttestation(
    approvedStructuredHuman.normalizedFieldsJson,
    approvedStructuredHuman,
  ),
  true,
  "Structured human approval must bind the marker to the exact public fields.",
);
assert.equal(
  await isCanonicallyGroundedApprovedEvent(
    structuredHumanApproval.ctx,
    approvedStructuredHuman,
  ),
  true,
  "Human-reviewed v2 evidence must remain bound to the persisted GPT source revision.",
);
structuredHumanApproval.posts.get("qa_venue:post-structured-human").analysisResultJson =
  "{\"extraction_contract_version\":\"event_evidence_v2\",\"is_event\":false}";
assert.equal(
  await isCanonicallyGroundedApprovedEvent(
    structuredHumanApproval.ctx,
    approvedStructuredHuman,
  ),
  false,
  "A reviewed v2 event must fail closed if the persisted analysis revision changes.",
);

const canonicalizedStructuredHumanEvent = event("structured-canonical-venue", {
  title: "Saturday Night at Kuma Lounge Bar",
  date: futureDate,
  time: "22:00",
  venue: "Kuma Lounge Bar",
  venueInstagramHandle: "kumabelgrade",
  artists: [],
  rawExtractionJson: structuredRawExtractionJson,
});
canonicalizedStructuredHumanEvent.normalizedFieldsJson = JSON.stringify({
  extractionContractVersion: "event_evidence_v2",
  extractionIsEvent: true,
  sourceGroundingVersion: 5,
  sourceGroundingEvidence: "persisted_openai_event_evidence_v2",
  sourceGroundingSourceCaption: canonicalizedStructuredHumanEvent.sourceCaption,
  sourceGroundingInstagramPostId: canonicalizedStructuredHumanEvent.instagramPostId,
  sourceGroundingInstagramPostUrl: canonicalizedStructuredHumanEvent.instagramPostUrl,
  sourceGroundingInstagramHandle: canonicalizedStructuredHumanEvent.venueInstagramHandle,
  sourceOccurrenceKey: canonicalizedStructuredHumanEvent.sourceOccurrenceKey,
  sourceOccurrenceSourceFingerprint: "instagram-source-v2:canonical-venue",
  title: canonicalizedStructuredHumanEvent.title,
  normalizedDate: canonicalizedStructuredHumanEvent.date,
  time: canonicalizedStructuredHumanEvent.time,
  normalizedVenue: canonicalizedStructuredHumanEvent.venue,
  artists: canonicalizedStructuredHumanEvent.artists,
  normalizedIsValid: true,
  dateSuspiciousYear: false,
  moderationPendingReasons: ["requires_human_approval", "invalid_identity_evidence"],
});
const canonicalVenue = {
  _id: "venue-kuma",
  _creationTime: 1,
  name: "KÚMA Lounge bar & Events",
  instagramHandle: "kumabelgrade",
  category: "bar",
  publicStatus: "published",
  scrapeActive: true,
  createdAt: 1,
  updatedAt: 1,
};
const canonicalizedStructuredApproval = await moderate(
  [canonicalizedStructuredHumanEvent],
  { ids: ["structured-canonical-venue"], status: "approved" },
  [canonicalVenue],
);
assert.deepEqual(canonicalizedStructuredApproval.result, {
  updatedCount: 1,
  skippedCount: 0,
});
const approvedCanonicalizedStructured =
  canonicalizedStructuredApproval.events.get("structured-canonical-venue");
const canonicalizedNormalizedFields = JSON.parse(
  approvedCanonicalizedStructured.normalizedFieldsJson,
);
assert.equal(approvedCanonicalizedStructured.venue, canonicalVenue.name);
assert.equal(approvedCanonicalizedStructured.venueId, canonicalVenue._id);
assert.equal(canonicalizedNormalizedFields.normalizedVenue, canonicalVenue.name);
assert.equal(
  canonicalizedNormalizedFields.humanReviewedVenueCanonicalizationPolicyVersion,
  1,
  "Human review must audit a canonical venue name rebound after source validation.",
);
assert.equal(
  hasHumanReviewedStructuredSourceAttestation(
    approvedCanonicalizedStructured.normalizedFieldsJson,
    approvedCanonicalizedStructured,
  ),
  true,
  "Canonical venue rebinding must remain exact for public structured-source validation.",
);
assert.equal(
  await isCanonicallyGroundedApprovedEvent(
    canonicalizedStructuredApproval.ctx,
    approvedCanonicalizedStructured,
  ),
  true,
  "A reviewed handle-mapped venue must remain publicly grounded after canonicalization.",
);

const outsideConflict = event("outside", {
  title: "Already approved outside event",
  time: undefined,
  status: "approved",
});
const blockedByOutside = await moderate([...pair, outsideConflict], {
  ids: ["one", "two"],
  status: "approved",
  approveAsDistinctSameVenueDateBatch: true,
});
assert.deepEqual(blockedByOutside.result, { updatedCount: 0, skippedCount: 2 });
assert.equal(blockedByOutside.events.get("one").status, "pending");
assert.equal(blockedByOutside.events.get("two").status, "pending");
assert.equal(blockedByOutside.audits.length, 0);

await assert.rejects(
  moderate(
    [
      event("duplicate-one", {
        title: "Concert one",
        artists: ["Artist one"],
        instagramPostId: "shared-post",
        instagramPostUrl: "https://www.instagram.com/p/shared-post/",
        sourceOccurrenceKey: "same-occurrence",
      }),
      event("duplicate-two", {
        title: "Different billed concert",
        artists: ["Artist two"],
        time: "22:00",
        instagramPostId: "shared-post",
        instagramPostUrl: "https://www.instagram.com/p/shared-post/",
        sourceOccurrenceKey: "same-occurrence",
      }),
    ],
    {
      ids: ["duplicate-one", "duplicate-two"],
      status: "approved",
      approveAsDistinctSameVenueDateBatch: true,
    },
  ),
  /every pair to be proven distinct/i,
);

await assert.rejects(
  moderate(pair, {
    ids: ["one"],
    status: "approved",
    approveAsDistinctSameVenueDateBatch: true,
  }),
  /requires at least two approved event IDs/i,
);
await assert.rejects(
  moderate(pair, {
    ids: ["one", "two"],
    status: "rejected",
    approveAsDistinctSameVenueDateBatch: true,
  }),
  /requires at least two approved event IDs/i,
);

console.log("Moderation distinct same-venue/date batch QA passed.");
