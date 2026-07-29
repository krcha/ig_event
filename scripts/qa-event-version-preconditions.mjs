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

function makeCtx(initialEvent) {
  const initialEvents = Array.isArray(initialEvent) ? initialEvent : [initialEvent];
  const events = new Map(initialEvents.map((item) => [item._id, structuredClone(item)]));
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
        async get(id) {
          return events.get(id) ?? null;
        },
        async patch(id, patch) {
          const current = events.get(id);
          if (!current) throw new Error(`missing event ${id}`);
          patches.push({ id, patch: structuredClone(patch) });
          events.set(id, { ...current, ...patch });
        },
        async insert(table, value) {
          assert.equal(table, "eventAuditLog");
          audits.push(structuredClone(value));
          return `audit-${audits.length}`;
        },
      },
    },
    events,
    audits,
    patches,
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
              withIndex: () => ({ collect: async () => [...events.values()] }),
            };
          }
          if (table === "scrapedPosts") {
            return {
              withIndex: () => ({ collect: async () => [] }),
            };
          }
          if (table === "mediaAssets") {
            return {
              withIndex: () => ({ first: async () => [...assets.values()][0] ?? null }),
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
assert.equal(statusMatch.patches.length, 1);
assert.equal(statusMatch.audits.length, 1);

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

const ingestionSource = readFileSync("lib/pipeline/run-instagram-ingestion.ts", "utf8");
assert.match(ingestionSource, /expectedUpdatedAt: existingMatch\.existingEvent\.updatedAt/g);
assert.match(ingestionSource, /updatedAt: persistedUpdate\.updatedAt/);
const moderationRouteSource = readFileSync("app/api/admin/events/moderate/route.ts", "utf8");
assert.match(moderationRouteSource, /expectedVersions must provide one exact reviewed version per eventId/);
assert.match(moderationRouteSource, /isVersionConflict\(error\) \? 409 : 500/);
const promotionRouteSource = readFileSync("app/api/admin/events/route.ts", "utf8");
assert.match(promotionRouteSource, /expectedUpdatedAt: body\.expectedUpdatedAt/);
assert.match(promotionRouteSource, /isVersionConflict\(error\) \? 409 : 500/);
const dashboardSource = readFileSync("components/admin/moderation-dashboard.tsx", "utf8");
assert.match(dashboardSource, /expectedUpdatedAt: reviewedEvent\.updatedAt/g);
assert.match(dashboardSource, /expectedVersions,/);
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
