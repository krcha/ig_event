import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  deleteApprovedEvent,
  mergeApprovedEvents,
  setEventStatus,
  setEventStatuses,
  updateEvent,
} from "../convex/events.ts";
import { claimAndAttach, removeMissingAsset } from "../convex/mediaAssets.ts";
import {
  assertExpectedEventUpdatedAt,
  nextEventUpdatedAt,
} from "../lib/events/event-update-precondition.ts";
import { readIngestionArchitectureSource } from "./qa-support/ingestion-architecture-source.mjs";

process.env.ADMIN_CLERK_USER_IDS = "qa-owner";

function event(id, overrides = {}) {
  return {
    _id: id,
    _creationTime: 1,
    title: `Concert ${id}`,
    date: "2026-08-01",
    time: "20:00",
    venue: "QA Venue",
    artists: [`Artist ${id}`],
    eventType: "music",
    status: "pending",
    createdAt: 1,
    updatedAt: 100,
    instagramPostId: `post-${id}`,
    instagramPostUrl: `https://www.instagram.com/p/${id}/`,
    ...overrides,
  };
}

function makeCtx(initialEvent, options = {}) {
  const initialEvents = Array.isArray(initialEvent) ? initialEvent : [initialEvent];
  const events = new Map(initialEvents.map((item) => [item._id, structuredClone(item)]));
  const sourceLinks = new Map(
    (options.sourceBoundEventIds ?? []).map((eventId) => [
      `source-link-${eventId}`,
      {
        _id: `source-link-${eventId}`,
        eventId,
      },
    ]),
  );
  const sourceOccurrences = new Map();
  const topologyEpochs = new Map([
    [
      "source-occurrence-topology-epoch",
      {
        _id: "source-occurrence-topology-epoch",
        key: "source-occurrence-topology-v1",
        currentEpoch: 10,
        verifiedEpoch: 10,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  ]);
  const audits = [];
  const patches = [];
  return {
    ctx: {
      auth: {
        async getUserIdentity() {
          return { subject: "qa-owner" };
        },
      },
      db: {
        query(table) {
          const filters = {};
          const tableRows =
            table === "instagramEventSources"
              ? sourceLinks
              : table === "sourceOccurrences"
                ? sourceOccurrences
                : table === "sourceOccurrenceTopologyEpoch"
                  ? topologyEpochs
                  : new Map();
          const chain = {
            withIndex(_index, configure) {
              const builder = {
                eq(field, value) {
                  filters[field] = value;
                  return builder;
                },
              };
              configure(builder);
              return chain;
            },
            async take(limit) {
              return [...tableRows.values()]
                .filter((row) =>
                  Object.entries(filters).every(
                    ([field, value]) => row[field] === value,
                  ),
                )
                .slice(0, limit);
            },
          };
          return chain;
        },
        async get(id) {
          return events.get(id) ?? topologyEpochs.get(id) ?? null;
        },
        async patch(id, patch) {
          const target = events.has(id) ? events : topologyEpochs;
          const current = target.get(id);
          if (!current) throw new Error(`missing record ${id}`);
          patches.push({ id, patch: structuredClone(patch) });
          target.set(id, { ...current, ...patch });
        },
        async insert(table, value) {
          if (table === "eventAuditLog") {
            audits.push(structuredClone(value));
            return `audit-${audits.length}`;
          }
          assert.equal(table, "sourceOccurrenceTopologyEpoch");
          const id = `topology-epoch-${topologyEpochs.size + 1}`;
          topologyEpochs.set(id, { _id: id, ...structuredClone(value) });
          return id;
        },
      },
    },
    events,
    audits,
    patches,
    topologyEpochs,
  };
}

function makeMediaCtx(initialEvent, initialAsset) {
  const events = new Map([[initialEvent._id, structuredClone(initialEvent)]]);
  const assets = new Map([[initialAsset._id, structuredClone(initialAsset)]]);
  const audits = [];
  const patches = [];
  return {
    ctx: {
      db: {
        query(table) {
          if (table === "events") {
            return {
              withIndex: () => ({
                take: async (limit) => [...events.values()].slice(0, limit),
              }),
            };
          }
          if (table === "scrapedPosts") {
            return {
              withIndex: () => ({ take: async () => [] }),
            };
          }
          if (table === "mediaAssets") {
            return {
              withIndex: () => ({
                take: async (limit) => [...assets.values()].slice(0, limit),
              }),
            };
          }
          if (table === "sourceOccurrences") {
            return {
              withIndex: () => ({ take: async () => [] }),
            };
          }
          throw new Error(`unexpected table ${table}`);
        },
        async get(id) {
          return events.get(id) ?? assets.get(id) ?? null;
        },
        async patch(id, patch) {
          const current = events.get(id) ?? assets.get(id);
          if (!current) throw new Error(`missing record ${id}`);
          patches.push({ id, patch: structuredClone(patch) });
          if (events.has(id)) events.set(id, { ...current, ...patch });
          else assets.set(id, { ...current, ...patch });
        },
        async insert(table, value) {
          assert.equal(table, "eventAuditLog");
          audits.push(structuredClone(value));
          return `media-audit-${audits.length}`;
        },
        async delete(id) {
          assets.delete(id);
        },
      },
    },
    events,
    assets,
    audits,
    patches,
  };
}

assert.doesNotThrow(() => assertExpectedEventUpdatedAt(100, undefined));
assert.doesNotThrow(() => assertExpectedEventUpdatedAt(100, 100));
assert.throws(() => assertExpectedEventUpdatedAt(100, 99), /reviewed version/i);
assert.throws(() => assertExpectedEventUpdatedAt(100, 100.5), /safe integer/i);
assert.equal(nextEventUpdatedAt(100, 100), 101);
assert.equal(nextEventUpdatedAt(100, 99), 101);
assert.equal(nextEventUpdatedAt(100, 200), 200);
assert.throws(() => nextEventUpdatedAt(Number.MAX_SAFE_INTEGER, 200), /cannot be advanced safely/i);

const originalDateNow = Date.now;
try {
  Date.now = () => 100;
  const mediaEvent = event("media-attach", {
    imageStorageId: undefined,
    imageUrl: undefined,
    updatedAt: 100,
  });
  const mediaAsset = {
    _id: "media-asset",
    _creationTime: 1,
    sourceKey: "instagram-post:post-media-attach",
    sourceKind: "instagram_post",
    instagramPostId: "post-media-attach",
    storageId: "storage-media-attach",
    url: "https://convex.example/api/storage/storage-media-attach",
    upstreamUrl: "https://images.apifyusercontent.com/media-attach.jpg",
    mimeType: "image/jpeg",
    byteLength: 100,
    checksumSha256: "a".repeat(64),
    createdAt: 1,
    updatedAt: 100,
    lastAttachedAt: 100,
  };
  const mediaAttach = makeMediaCtx(mediaEvent, mediaAsset);
  await claimAndAttach._handler(mediaAttach.ctx, {
    postId: "post-media-attach",
    storageId: mediaAsset.storageId,
    url: mediaAsset.url,
    upstreamUrl: mediaAsset.upstreamUrl,
    mimeType: mediaAsset.mimeType,
    byteLength: mediaAsset.byteLength,
    checksumSha256: mediaAsset.checksumSha256,
    actor: "qa-media",
  });
  assert.equal(mediaAttach.events.get(mediaEvent._id).updatedAt, 101);
  assert.equal(mediaAttach.events.get(mediaEvent._id).imageStorageId, mediaAsset.storageId);

  const raceWinner = {
    ...mediaAsset,
    _id: "media-race-winner",
    storageId: "storage-race-winner",
    checksumSha256: "b".repeat(64),
  };
  const mediaRace = makeMediaCtx(
    { ...mediaEvent, imageStorageId: undefined, imageUrl: undefined },
    raceWinner,
  );
  await assert.rejects(
    claimAndAttach._handler(mediaRace.ctx, {
      postId: "post-media-attach",
      storageId: "storage-provisional-exact",
      url: "https://convex.example/api/storage/storage-provisional-exact",
      upstreamUrl: mediaAsset.upstreamUrl,
      mimeType: mediaAsset.mimeType,
      byteLength: mediaAsset.byteLength,
      checksumSha256: "a".repeat(64),
      expectedChecksumSha256: "a".repeat(64),
      actor: "qa-media",
    }),
    /checksum does not match/i,
    "a concurrent media winner with different bytes must be rejected before attachment",
  );
  assert.equal(mediaRace.events.get(mediaEvent._id).imageStorageId, undefined);
  assert.equal(mediaRace.audits.length, 0);

  const mediaRemove = makeMediaCtx(
    { ...mediaEvent, imageStorageId: mediaAsset.storageId, imageUrl: mediaAsset.url },
    mediaAsset,
  );
  await removeMissingAsset._handler(mediaRemove.ctx, {
    postId: "post-media-attach",
    assetId: mediaAsset._id,
    expectedStorageId: mediaAsset.storageId,
    actor: "qa-media",
  });
  assert.equal(mediaRemove.events.get(mediaEvent._id).updatedAt, 101);
  assert.equal(mediaRemove.events.get(mediaEvent._id).imageStorageId, undefined);
  assert.equal(mediaRemove.assets.has(mediaAsset._id), false);
} finally {
  Date.now = originalDateNow;
}

const updateMatch = makeCtx(event("update-match"));
const updateResult = await updateEvent._handler(updateMatch.ctx, {
  id: "update-match",
  patch: { description: "source-reviewed repair" },
  expectedStatus: "pending",
  expectedUpdatedAt: 100,
});
assert.equal(updateMatch.events.get("update-match").description, "source-reviewed repair");
assert.ok(updateMatch.events.get("update-match").updatedAt > 100);
assert.equal(updateResult.updatedAt, updateMatch.events.get("update-match").updatedAt);
assert.equal(updateMatch.patches.length, 1);
assert.equal(updateMatch.audits.length, 1);

const updateStale = makeCtx(event("update-stale"));
await assert.rejects(
  updateEvent._handler(updateStale.ctx, {
    id: "update-stale",
    patch: { description: "must not commit" },
    expectedStatus: "pending",
    expectedUpdatedAt: 99,
  }),
  /reviewed version/i,
);
assert.equal(updateStale.events.get("update-stale").description, undefined);
assert.equal(updateStale.patches.length, 0);
assert.equal(updateStale.audits.length, 0);

const updateInvalid = makeCtx(event("update-invalid"));
await assert.rejects(
  updateEvent._handler(updateInvalid.ctx, {
    id: "update-invalid",
    patch: { description: "must not commit" },
    expectedStatus: "pending",
    expectedUpdatedAt: 100.5,
  }),
  /safe integer/i,
);
assert.equal(updateInvalid.patches.length, 0);
assert.equal(updateInvalid.audits.length, 0);

const statusMatch = makeCtx(event("status-match"));
await setEventStatus._handler(statusMatch.ctx, {
  id: "status-match",
  status: "rejected",
  reviewedBy: "QA owner",
  moderationNote: "source-reviewed invalid event",
  expectedUpdatedAt: 100,
});
assert.equal(statusMatch.events.get("status-match").status, "rejected");
assert.ok(statusMatch.events.get("status-match").updatedAt > 100);
assert.ok(
  statusMatch.patches.length >= 1,
  "Status mutation may also refresh materialized derived state in the same transaction.",
);
assert.equal(statusMatch.audits.length, 1);

const sourceBoundStatus = makeCtx(event("status-source-bound"), {
  sourceBoundEventIds: ["status-source-bound"],
});
await setEventStatus._handler(sourceBoundStatus.ctx, {
  id: "status-source-bound",
  status: "rejected",
  reviewedBy: "QA owner",
  moderationNote: "source-bound rejection must invalidate topology",
  expectedUpdatedAt: 100,
});
const sourceBoundStatusEpoch = sourceBoundStatus.topologyEpochs.get(
  "source-occurrence-topology-epoch",
);
assert.equal(sourceBoundStatus.events.get("status-source-bound").status, "rejected");
assert.ok(sourceBoundStatusEpoch.currentEpoch > 10);
assert.equal(
  sourceBoundStatusEpoch.verifiedEpoch,
  10,
  "Rejecting a source-bound event must not preserve the verified topology frontier.",
);

const statusStale = makeCtx(event("status-stale"));
await assert.rejects(
  setEventStatus._handler(statusStale.ctx, {
    id: "status-stale",
    status: "rejected",
    reviewedBy: "QA owner",
    moderationNote: "must not commit",
    expectedUpdatedAt: 99,
  }),
  /reviewed version/i,
);
assert.equal(statusStale.events.get("status-stale").status, "pending");
assert.equal(statusStale.patches.length, 0);
assert.equal(statusStale.audits.length, 0);

const bulkMatch = makeCtx([event("bulk-a"), event("bulk-b", { updatedAt: 200 })]);
await setEventStatuses._handler(bulkMatch.ctx, {
  ids: ["bulk-a", "bulk-b"],
  expectedVersions: [
    { id: "bulk-a", expectedUpdatedAt: 100 },
    { id: "bulk-b", expectedUpdatedAt: 200 },
  ],
  status: "rejected",
  reviewedBy: "QA owner",
});
assert.equal(bulkMatch.events.get("bulk-a").status, "rejected");
assert.equal(bulkMatch.events.get("bulk-b").status, "rejected");
assert.equal(bulkMatch.audits.length, 2);

const sourceBoundBulk = makeCtx(
  [event("bulk-source-bound"), event("bulk-unbound", { updatedAt: 200 })],
  { sourceBoundEventIds: ["bulk-source-bound"] },
);
await setEventStatuses._handler(sourceBoundBulk.ctx, {
  ids: ["bulk-source-bound", "bulk-unbound"],
  expectedVersions: [
    { id: "bulk-source-bound", expectedUpdatedAt: 100 },
    { id: "bulk-unbound", expectedUpdatedAt: 200 },
  ],
  status: "rejected",
  reviewedBy: "QA owner",
});
const sourceBoundBulkEpoch = sourceBoundBulk.topologyEpochs.get(
  "source-occurrence-topology-epoch",
);
assert.ok(sourceBoundBulkEpoch.currentEpoch > 10);
assert.equal(
  sourceBoundBulkEpoch.verifiedEpoch,
  10,
  "A batch containing any source-bound rejection must dirty the topology epoch.",
);

const bulkStale = makeCtx([event("bulk-stale-a"), event("bulk-stale-b", { updatedAt: 200 })]);
await assert.rejects(
  setEventStatuses._handler(bulkStale.ctx, {
    ids: ["bulk-stale-a", "bulk-stale-b"],
    expectedVersions: [
      { id: "bulk-stale-a", expectedUpdatedAt: 100 },
      { id: "bulk-stale-b", expectedUpdatedAt: 199 },
    ],
    status: "rejected",
  }),
  /reviewed version/i,
);
assert.equal(bulkStale.patches.length, 0);
assert.equal(bulkStale.audits.length, 0);

const bulkIncomplete = makeCtx([event("bulk-version-a"), event("bulk-version-b")]);
await assert.rejects(
  setEventStatuses._handler(bulkIncomplete.ctx, {
    ids: ["bulk-version-a", "bulk-version-b"],
    expectedVersions: [{ id: "bulk-version-a", expectedUpdatedAt: 100 }],
    status: "rejected",
  }),
  /exactly match/i,
);
assert.equal(bulkIncomplete.patches.length, 0);
assert.equal(bulkIncomplete.audits.length, 0);

const deleteStale = makeCtx(event("delete-stale", { status: "approved" }));
await assert.rejects(
  deleteApprovedEvent._handler(deleteStale.ctx, {
    id: "delete-stale",
    expectedUpdatedAt: 99,
  }),
  /reviewed version/i,
);
assert.equal(deleteStale.patches.length, 0);
assert.equal(deleteStale.audits.length, 0);

const mergePrimaryStale = makeCtx([
  event("merge-primary-stale", { status: "approved" }),
  event("merge-duplicate", { status: "approved", updatedAt: 200 }),
]);
await assert.rejects(
  mergeApprovedEvents._handler(mergePrimaryStale.ctx, {
    primaryId: "merge-primary-stale",
    duplicateIds: ["merge-duplicate"],
    expectedPrimaryUpdatedAt: 99,
    expectedDuplicateVersions: [{ id: "merge-duplicate", expectedUpdatedAt: 200 }],
    patch: {},
  }),
  /reviewed version/i,
);
assert.equal(mergePrimaryStale.patches.length, 0);
assert.equal(mergePrimaryStale.audits.length, 0);

const mergeDuplicateStale = makeCtx([
  event("merge-primary", { status: "approved" }),
  event("merge-duplicate-stale", { status: "approved", updatedAt: 200 }),
]);
await assert.rejects(
  mergeApprovedEvents._handler(mergeDuplicateStale.ctx, {
    primaryId: "merge-primary",
    duplicateIds: ["merge-duplicate-stale"],
    expectedPrimaryUpdatedAt: 100,
    expectedDuplicateVersions: [{ id: "merge-duplicate-stale", expectedUpdatedAt: 199 }],
    patch: {},
  }),
  /reviewed version/i,
);
assert.equal(mergeDuplicateStale.patches.length, 0);
assert.equal(mergeDuplicateStale.audits.length, 0);

const updateWithoutVersion = makeCtx(event("update-legacy"));
await updateEvent._handler(updateWithoutVersion.ctx, {
  id: "update-legacy",
  patch: { description: "backward compatible" },
  expectedStatus: "pending",
});
assert.equal(updateWithoutVersion.events.get("update-legacy").description, "backward compatible");

const statusWithoutVersion = makeCtx(event("status-legacy"));
await setEventStatus._handler(statusWithoutVersion.ctx, {
  id: "status-legacy",
  status: "rejected",
});
assert.equal(statusWithoutVersion.events.get("status-legacy").status, "rejected");

const ingestionSource = readIngestionArchitectureSource();
assert.match(ingestionSource, /expectedUpdatedAt: existingMatch\.existingEvent\.updatedAt/g);
assert.match(ingestionSource, /updatedAt: persistedUpdate\.updatedAt/);
const moderationRouteSource = readFileSync("app/api/admin/events/moderate/route.ts", "utf8");
assert.match(moderationRouteSource, /expectedVersions must provide one exact reviewed version per eventId/);
assert.match(moderationRouteSource, /Approval requires a moderation note of at least 20 characters/);
assert.match(moderationRouteSource, /isVersionConflict\(error\) \? 409 : 500/);
const promotionRouteSource = readFileSync("app/api/admin/events/route.ts", "utf8");
assert.match(promotionRouteSource, /expectedUpdatedAt: body\.expectedUpdatedAt/);
assert.match(promotionRouteSource, /isVersionConflict\(error\) \? 409 : 500/);
const uniqueApprovalRouteSource = readFileSync(
  "app/api/admin/events/approve-unique/route.ts",
  "utf8",
);
assert.match(uniqueApprovalRouteSource, /expectedUpdatedAt: item\.expectedUpdatedAt/);
assert.match(uniqueApprovalRouteSource, /Number\.isSafeInteger\(item\.expectedUpdatedAt\)/);
assert.match(uniqueApprovalRouteSource, /isVersionConflict\(error\)[\s\S]*\? 409/);
const fullUniqueApprovalRouteSource = readFileSync(
  "app/api/admin/events/approve-unique-all/route.ts",
  "utf8",
);
assert.match(
  fullUniqueApprovalRouteSource,
  /_id: event\._id,\s*date: event\.date,\s*updatedAt: event\.updatedAt/,
);
assert.match(
  fullUniqueApprovalRouteSource,
  /id: event\._id,\s*expectedUpdatedAt: event\.updatedAt/,
);
assert.match(
  fullUniqueApprovalRouteSource,
  /id: item\.id,\s*expectedUpdatedAt: item\.expectedUpdatedAt/,
);
assert.match(
  fullUniqueApprovalRouteSource,
  /item\.expectedUpdatedAt !== expectedVersionById\.get\(item\.id\)/,
);
const dashboardSource = readFileSync("components/admin/moderation-dashboard.tsx", "utf8");
assert.match(dashboardSource, /expectedUpdatedAt: reviewedEvent\.updatedAt/g);
assert.match(dashboardSource, /Approval note \(required; describe the source evidence and duplicate check\)/);
assert.match(
  dashboardSource,
  /event\.pendingUniqueness\.expectedUpdatedAt === event\.updatedAt/,
);
assert.match(dashboardSource, /expectedPrimaryUpdatedAt: primaryEvent\.updatedAt/);
assert.match(dashboardSource, /expectedDuplicateVersions:/);
assert.match(dashboardSource, /response\.status === 409/g);
const removeRouteSource = readFileSync("app/api/admin/events/remove/route.ts", "utf8");
assert.match(removeRouteSource, /expectedUpdatedAt: body\.expectedUpdatedAt/);
assert.match(removeRouteSource, /isVersionConflict\(error\) \? 409 : 500/);
const masterApplyRouteSource = readFileSync(
  "app/api/admin/events/master-review/apply/route.ts",
  "utf8",
);
assert.match(masterApplyRouteSource, /expectedPrimaryUpdatedAt: body\.expectedPrimaryUpdatedAt/);
assert.match(masterApplyRouteSource, /expectedDuplicateVersions,/);
assert.match(masterApplyRouteSource, /isVersionConflict\(error\) \? 409 : 500/);

console.log("Event updatedAt precondition QA passed.");
