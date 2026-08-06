import assert from "node:assert/strict";
import { getPublicApprovedEvent, setEventStatuses } from "../convex/events.ts";
import { isCanonicallyGroundedApprovedEvent } from "../convex/publicEventGrounding.ts";
import { hasCompleteSourceGroundingAttestation } from "../lib/events/event-update-precondition.ts";

process.env.ADMIN_CLERK_USER_IDS = "qa-owner";

const fixturePostedAt = "2026-07-15T12:00:00.000Z";
const fixtureCaption =
  "Nastupa Concert one 1. avgusta u 20:00 @ Shared Venue uz Artist one; Nastupa Different billed concert 1. avgusta u 22:00 @ Shared Venue uz Artist two";

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

function makeCtx(initialEvents) {
  const events = new Map(initialEvents.map((item) => [item._id, structuredClone(item)]));
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
      },
    ]),
  );
  const audits = [];
  const filterRows = (rows, filters) =>
    rows.filter((row) => filters.every(([field, value]) => row[field] === value));
  const query = (table) => {
    const rows = () =>
      table === "events"
        ? [...events.values()]
        : table === "scrapedPosts"
          ? [...posts.values()]
          : [];
    return {
      async collect() {
        return rows();
      },
      withIndex(_name, applyIndex) {
        const filters = [];
        const chain = {
          eq(field, value) {
            filters.push([field, value]);
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
    audits,
  };
}

async function moderate(initialEvents, args) {
  const state = makeCtx(initialEvents);
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
