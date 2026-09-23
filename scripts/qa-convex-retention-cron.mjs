import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deleteExpiredEvents } from "../convex/events.ts";
import { deleteOlderThan as deleteOldScrapedPosts } from "../convex/scrapedPosts.ts";
import {
  getConfiguredEventTimezone,
  getEventExpiryCutoff,
} from "../lib/events/event-retention.ts";

async function runMutation(handler, ctx, args) {
  let paginatedQueryCount = 0;
  const wrapQuery = (query) => new Proxy(query, {
    get(target, property) {
      const value = target[property];
      if (typeof value !== "function") return value;
      return (...parameters) => {
        if (property === "paginate") {
          paginatedQueryCount += 1;
          assert.ok(paginatedQueryCount <= 1,
            "Convex permits only one paginated query per function invocation.");
        }
        const result = value.apply(target, parameters);
        return property === "withIndex" || property === "order" ? wrapQuery(result) : result;
      };
    },
  });
  return handler({ ...ctx, db: { ...ctx.db, query: (...parameters) => wrapQuery(ctx.db.query(...parameters)) } }, args);
}

const cronsSource = readFileSync(new URL("../convex/crons.ts", import.meta.url), "utf8");
const maintenanceSource = readFileSync(
  new URL("../convex/maintenance.ts", import.meta.url),
  "utf8",
);
const eventsSource = readFileSync(new URL("../convex/events.ts", import.meta.url), "utf8");
const eventLifecycleSource = readFileSync(
  new URL("../convex/eventDomain/lifecycleCommands.ts", import.meta.url),
  "utf8",
);
const ingestionJobsSource = readFileSync(
  new URL("../convex/ingestionJobs.ts", import.meta.url),
  "utf8",
);
const scrapedPostsSource = readFileSync(
  new URL("../convex/scrapedPosts.ts", import.meta.url),
  "utf8",
);
const schemaSource = readFileSync(new URL("../convex/schema.ts", import.meta.url), "utf8");
const retentionSource = readFileSync(
  new URL("../lib/events/event-retention.ts", import.meta.url),
  "utf8",
);

const cleanReceiptTopologyAuditState = {
  _id: "qa-retention-receipt-topology-audit",
  key: "event-retention-reverse-receipts-v1",
  phase: "retention_reference_complete",
  auditDetailsJson: JSON.stringify({ auditGeneration: 1, missingEventReferenceCount: 0, indexedReferenceCount: 0, sweptReferenceCount: 0, mismatchExamples: [] }),
  isDone: true,
  scannedCount: 0,
  updatedCount: 0,
  mismatchCount: 0,
  unchangedCount: 0,
  errorCount: 0,
  skippedCount: 0,
  quarantinedLineageMarkerCount: 0,
  topologyEpoch: 0,
  completedAt: 1,
};
const cleanSourceOccurrenceTopologyEpoch = {
  _id: "qa-retention-source-occurrence-topology-epoch",
  key: "source-occurrence-topology-v1",
  currentEpoch: 0,
  verifiedEpoch: 0,
  createdAt: 1,
  updatedAt: 1,
};

assert.match(
  retentionSource,
  /EVENT_RETENTION_DAYS\s*=\s*2/,
  "event retention should clean events older than the 2-day grace period",
);

assert.match(
  eventsSource,
  /export const deleteExpiredEvents = internalMutation/,
  "expired-event deletion should remain an internal mutation, not a public mutation",
);

assert.match(
  maintenanceSource,
  /export const deleteExpiredEventsUntilDone = internalAction/,
  "retention cron should perform bounded deletion work and return its completion state",
);
assert.match(
  maintenanceSource,
  /ctx\.runMutation\(deleteExpiredEventsMutation/,
  "retention action should run the bounded internal deletion mutation through a typed function reference",
);
assert.match(
  eventsSource,
  /beforeDate: v\.optional\(v\.string\(\)\)/,
  "operators should be able to request a strict explicit date cutoff without changing cron retention",
);
assert.match(
  eventLifecycleSource,
  /dateKeyToUtcMs\(explicitBeforeDate \?\? ""\) === null/,
  "explicit deletion cutoffs must reject invalid calendar dates",
);
assert.match(
  eventLifecycleSource,
  /shouldDeleteSameDayExpiredEvents = explicitBeforeDate === undefined/,
  "an explicit beforeDate must preserve every event on the cutoff date",
);
assert.match(
  maintenanceSource,
  /beforeDate: args\.beforeDate/,
  "the bounded all-batches action must forward the explicit strict cutoff to every mutation batch",
);
assert.match(
  maintenanceSource,
  /DEFAULT_EXPIRED_EVENT_CLEANUP_BATCH_SIZE\s*=\s*1\s*;/,
  "event cleanup must bound a transaction to one candidate or its complete campaign",
);
assert.match(
  maintenanceSource,
  /DEFAULT_EXPIRED_EVENT_CLEANUP_MAX_BATCHES\s*=\s*5/,
  "each cleanup tick must stop after five small batches and resume later",
);

assert.doesNotMatch(
  cronsSource,
  /crons\.weekly\(/,
  "two-day retention must not wait for a weekly cleanup backlog",
);
assert.match(
  cronsSource,
  /crons\.interval\(\s*["']delete expired events["'][\s\S]*?minutes:\s*5/,
  "expired-event cleanup should resume every five minutes",
);
assert.match(
  cronsSource,
  /internal\.maintenance\.deleteExpiredEventsUntilDone/,
  "cron should call the all-batches maintenance action",
);
assert.match(cronsSource, /batchSize:\s*1\s*,/, "event cron should request one-candidate deletion batches");
assert.match(cronsSource, /maxBatches:\s*5/, "cron should cap a single cleanup at five batches");

assert.match(
  scrapedPostsSource,
  /export const deleteOlderThan = internalMutation/,
  "scraped-post retention should be an internal mutation",
);
assert.match(
  scrapedPostsSource,
  /query\("scrapedPostRetentionCursors"\)[\s\S]*?\.withIndex\("by_key"[\s\S]*?\.unique\(\)/u,
  "scraped-post retention must resume from one indexed durable cursor row",
);
assert.match(
  scrapedPostsSource,
  /withIndex\("by_updatedAt",[\s\S]*?\.paginate\(\{ cursor, numItems: limit \}\)/u,
  "scraped-post retention must advance through the old-post index with a Convex cursor",
);
assert.match(
  schemaSource,
  /scrapedPostRetentionCursors: defineTable\([\s\S]*?cutoffUpdatedAt: v\.number\(\)[\s\S]*?cursor: v\.string\(\)[\s\S]*?\.index\("by_key", \["key"\]\)/u,
  "scraped-post retention cursor state must pin both the cutoff and continuation cursor",
);
assert.match(
  maintenanceSource,
  /cursor: scrapedPostCursor/u,
  "artifact cleanup must forward the scraped-post cursor to every bounded mutation",
);
assert.match(
  maintenanceSource,
  /scrapedPostCutoffUpdatedAt = scrapedPostResult\.cutoffUpdatedAt/u,
  "artifact cleanup must report and reuse the cutoff pinned by durable scraped-post state",
);
assert.match(
  eventsSource,
  /sameDayCursor: v\.optional\(v\.union\(v\.string\(\), v\.null\(\)\)\)/u,
  "event retention must expose a separate same-day cursor",
);
assert.match(
  ingestionJobsSource,
  /export const deleteTerminalOlderThan = internalMutation/,
  "terminal ingestion-job retention should be an internal mutation",
);
assert.match(
  maintenanceSource,
  /SCRAPED_POST_RETENTION_MS\s*=\s*90 \* 24 \* 60 \* 60 \* 1000/,
  "scraped posts should retain 90 days by default",
);
assert.match(
  maintenanceSource,
  /INGESTION_JOB_RETENTION_MS\s*=\s*30 \* 24 \* 60 \* 60 \* 1000/,
  "terminal ingestion jobs should retain 30 days by default",
);
assert.match(
  cronsSource,
  /crons\.hourly\(\s*["']cleanup ingestion artifacts["']/,
  "ingestion artifact cleanup should make bounded progress hourly",
);
assert.match(
  cronsSource,
  /internal\.maintenance\.cleanupIngestionArtifactsUntilDone/,
  "ingestion artifact cleanup cron should call the internal maintenance action",
);

function makeStrictCutoffCtx() {
  const events = new Map([
    ["event-before", { _id: "event-before", date: "2026-07-25", time: "23:59" }],
    ["event-cutoff", { _id: "event-cutoff", date: "2026-07-26", time: "00:00" }],
  ]);
  const saved = new Map([
    ["saved-before", { _id: "saved-before", eventId: "event-before" }],
    ["saved-cutoff", { _id: "saved-cutoff", eventId: "event-cutoff" }],
  ]);
  const legacySaved = new Map();
  const deleted = [];
  return {
    ctx: {
      db: {
        query(table) {
          return {
            withIndex(_index, buildRange) {
              let constraint;
              buildRange({
                eq(_field, value) {
                  constraint = { kind: "eq", value };
                  return this;
                },
                lt(_field, value) {
                  constraint = { kind: "lt", value };
                  return this;
                },
              });
              return {
                async paginate({ cursor, numItems }) {
                  assert.equal(table, "events");
                  assert.equal(constraint?.kind, "lt");
                  const matching = [...events.values()].filter(
                    (event) => event.date < constraint.value,
                  );
                  const start = cursor ? Number(cursor) : 0;
                  const end = Math.min(matching.length, start + numItems);
                  return {
                    page: matching.slice(start, end),
                    isDone: end >= matching.length,
                    continueCursor: end >= matching.length ? "" : String(end),
                  };
                },
                async collect() {
                  if (table === "eventDomainMigrationState") {
                    return cleanReceiptTopologyAuditState.key === constraint?.value
                      ? [cleanReceiptTopologyAuditState]
                      : [];
                  }
                  if (table === "sourceOccurrenceTopologyEpoch") {
                    return cleanSourceOccurrenceTopologyEpoch.key === constraint?.value
                      ? [cleanSourceOccurrenceTopologyEpoch]
                      : [];
                  }
                  const records = table === "savedEvents" ? saved : legacySaved;
                  return [...records.values()].filter(
                    (record) => record.eventId === constraint?.value,
                  );
                },
                async take(limit) {
                  if (table === "eventDomainMigrationState") {
                    return (
                      cleanReceiptTopologyAuditState.key === constraint?.value
                        ? [cleanReceiptTopologyAuditState]
                        : []
                    ).slice(0, limit);
                  }
                  if (table === "sourceOccurrenceTopologyEpoch") {
                    return (
                      cleanSourceOccurrenceTopologyEpoch.key === constraint?.value
                        ? [cleanSourceOccurrenceTopologyEpoch]
                        : []
                    ).slice(0, limit);
                  }
                  const records = table === "savedEvents" ? saved : legacySaved;
                  return [...records.values()]
                    .filter((record) => record.eventId === constraint?.value)
                    .slice(0, limit);
                },
              };
            },
          };
        },
        async delete(id) {
          deleted.push(id);
          events.delete(id);
          saved.delete(id);
          legacySaved.delete(id);
        },
        async insert(table, value) {
          assert.equal(table, "eventAuditLog");
          return `strict-cutoff-audit-${value.eventId}`;
        },
      },
    },
    deleted,
    events,
    saved,
  };
}

const strictCutoff = makeStrictCutoffCtx();
const strictCutoffResult = await runMutation(deleteExpiredEvents._handler, strictCutoff.ctx, {
  batchSize: 500,
  beforeDate: "2026-07-26",
});
assert.equal(strictCutoffResult.deletedEventCount, 1);
assert.equal(strictCutoffResult.deletedSavedEventCount, 1);
assert.equal(strictCutoffResult.cutoffDate, "2026-07-26");
assert.equal(strictCutoffResult.cutoffTime, "00:00");
assert.equal(strictCutoffResult.sameDayExpiredEventCount, 0);
assert.equal(strictCutoff.events.has("event-before"), false);
assert.equal(strictCutoff.events.has("event-cutoff"), true);
assert.equal(strictCutoff.saved.has("saved-before"), false);
assert.equal(strictCutoff.saved.has("saved-cutoff"), true);
assert.deepEqual(strictCutoff.deleted.sort(), ["event-before", "saved-before"]);

const expiredReviewedFold = makeStrictCutoffCtx();
expiredReviewedFold.events.get("event-before").normalizedFieldsJson = JSON.stringify({
  reviewedPromotionVariantFold: { policyVersion: 1, operationId: "historical-reviewed-fold" },
});
const reviewedFoldRetirement = await runMutation(deleteExpiredEvents._handler, expiredReviewedFold.ctx, {
  batchSize: 10, beforeDate: "2026-07-26",
});
assert.equal(reviewedFoldRetirement.deletedEventCount, 0);
assert.equal(expiredReviewedFold.events.has("event-before"), true,
  "A fold marker without its exact reviewed group must never permit partial lineage deletion.");

const invalidCutoff = makeStrictCutoffCtx();
await assert.rejects(
  runMutation(deleteExpiredEvents._handler, invalidCutoff.ctx, {
    batchSize: 500,
    beforeDate: "2026-02-30",
  }),
  /valid YYYY-MM-DD date/,
);
assert.deepEqual(invalidCutoff.deleted, []);

function makeLineageStarvationCtx() {
  const events = new Map();
  const retentionCursors = new Map();
  for (let index = 0; index < 500; index += 1) {
    const id = `retained-campaign-${String(index).padStart(3, "0")}`;
    events.set(id, {
      _id: id,
      date: "2026-07-24",
      time: "20:00",
      moderationNote: `[cross_post_campaign_variant:v1] qa-retained-${index}`,
    });
  }
  events.set("ordinary-expired-after-retained-page", {
    _id: "ordinary-expired-after-retained-page",
    date: "2026-07-25",
    time: "20:00",
  });
  const deleted = [];
  const rows = (table) =>
    table === "events"
      ? [...events.values()]
      : table === "eventRetentionCursors"
        ? [...retentionCursors.values()]
        : table === "eventDomainMigrationState"
          ? [cleanReceiptTopologyAuditState]
          : table === "sourceOccurrenceTopologyEpoch"
            ? [cleanSourceOccurrenceTopologyEpoch]
        : [];
  const queryResult = (table, filter = () => true) => ({
    async paginate({ cursor, numItems }) {
      const matching = rows(table).filter(filter);
      const start = cursor ? Number(cursor) : 0;
      const end = Math.min(matching.length, start + numItems);
      return {
        page: matching.slice(start, end),
        isDone: end >= matching.length,
        continueCursor: end >= matching.length ? "" : String(end),
      };
    },
    async collect() {
      return rows(table).filter(filter);
    },
    async take(limit) {
      return rows(table).filter(filter).slice(0, limit);
    },
    async unique() {
      const matching = rows(table).filter(filter);
      if (matching.length > 1) throw new Error("Expected one retention cursor.");
      return matching[0] ?? null;
    },
  });
  return {
    events,
    deleted,
    ctx: {
      db: {
        query(table) {
          return {
            withIndex(_index, configure) {
              let filter = () => true;
              const builder = {
                eq(field, value) {
                  filter = (row) => row[field] === value;
                  return builder;
                },
                lt(field, value) {
                  filter = (row) => row[field] < value;
                  return builder;
                },
              };
              configure(builder);
              return queryResult(table, filter);
            },
          };
        },
        async delete(id) {
          deleted.push(id);
          if (!events.delete(id)) retentionCursors.delete(id);
        },
        async insert(table, value) {
          if (table === "eventAuditLog") {
            return `retention-audit-${value.eventId}`;
          }
          assert.equal(table, "eventRetentionCursors");
          const id = "retention-cursor-state";
          retentionCursors.set(id, { _id: id, ...structuredClone(value) });
          return id;
        },
        async patch(id, patch) {
          assert.ok(retentionCursors.has(id));
          retentionCursors.set(id, {
            ...retentionCursors.get(id),
            ...structuredClone(patch),
          });
        },
      },
    },
  };
}

const lineageStarvation = makeLineageStarvationCtx();
const retainedPage = await runMutation(deleteExpiredEvents._handler, lineageStarvation.ctx, {
  batchSize: 500,
});
assert.equal(retainedPage.deletedEventCount, 0);
assert.equal(retainedPage.retainedCampaignEventCount, 1,
  "Even an oversized operator request must read at most one candidate, which may expand to eight campaign members.");
assert.equal(retainedPage.beforeDateScanComplete, false);
assert.equal(retainedPage.hasMore, true);
assert.ok(retainedPage.beforeDateCursor);
for (let index = 1; index < 500; index += 1) {
  const retainedContinuation = await runMutation(deleteExpiredEvents._handler, lineageStarvation.ctx, { batchSize: 500 });
  assert.equal(retainedContinuation.deletedEventCount, 0);
  assert.equal(retainedContinuation.retainedCampaignEventCount, 1);
  assert.equal(retainedContinuation.hasMore, true);
}
const ordinaryPage = await runMutation(deleteExpiredEvents._handler, lineageStarvation.ctx, {
  batchSize: 500,
});
assert.equal(ordinaryPage.deletedEventCount, 1);
assert.equal(ordinaryPage.beforeDateScanComplete, true);
assert.equal(ordinaryPage.hasMore, true);
const completedLineageScan = await runMutation(deleteExpiredEvents._handler, lineageStarvation.ctx, { batchSize: 500 });
assert.equal(completedLineageScan.hasMore, false);
assert.deepEqual(lineageStarvation.deleted, [
  "ordinary-expired-after-retained-page",
  "retention-cursor-state",
]);
assert.equal(lineageStarvation.events.size, 500);

function makeScrapedPostRetentionCtx() {
  const scrapedPosts = new Map(
    [
      ["old-delete-a", 10, "POST-A", "https://www.instagram.com/p/POST-A/"],
      ["old-first-class", 20, "POST-FIRST", "https://www.instagram.com/p/POST-FIRST/"],
      ["old-legacy-post-id", 30, "POST-ID", "https://www.instagram.com/p/POST-ID/"],
      ["old-legacy-post-url", 40, "POST-URL", "https://www.instagram.com/p/POST-URL/"],
      ["old-delete-b", 50, "POST-B", "https://www.instagram.com/p/POST-B/"],
      ["recent-unreferenced", 150, "POST-RECENT", "https://www.instagram.com/p/POST-RECENT/"],
    ].map(([id, updatedAt, postId, instagramPostUrl], index) => [
      id,
      {
        _id: id,
        _creationTime: index + 1,
        instagramPostUrl,
        postId,
        updatedAt,
      },
    ]),
  );
  const sourceOccurrences = new Map([
    [
      "occurrence-first-class",
      {
        _id: "occurrence-first-class",
        sourceDocumentId: "old-first-class",
        sourceOccurrenceKey: "first-class-key",
      },
    ],
  ]);
  const instagramEventSources = new Map([
    [
      "link-by-post-id",
      {
        _id: "link-by-post-id",
        instagramPostId: "POST-ID",
        instagramPostUrl: "https://www.instagram.com/p/OTHER/",
      },
    ],
    [
      "link-by-post-url",
      {
        _id: "link-by-post-url",
        instagramPostId: "OTHER-POST",
        instagramPostUrl: "https://www.instagram.com/p/POST-URL/",
      },
    ],
  ]);
  const retentionCursors = new Map();
  const deleted = [];

  const rows = (table) =>
    table === "scrapedPosts"
      ? [...scrapedPosts.values()]
      : table === "sourceOccurrences"
        ? [...sourceOccurrences.values()]
        : table === "instagramEventSources"
          ? [...instagramEventSources.values()]
          : table === "scrapedPostRetentionCursors"
            ? [...retentionCursors.values()]
            : [];
  const queryResult = (table, predicates) => ({
    async paginate({ cursor, numItems }) {
      assert.equal(table, "scrapedPosts");
      const after = cursor ? JSON.parse(cursor) : null;
      const matching = rows(table)
        .filter((row) => predicates.every((predicate) => predicate(row)))
        .sort(
          (left, right) =>
            left.updatedAt - right.updatedAt ||
            left._creationTime - right._creationTime ||
            String(left._id).localeCompare(String(right._id)),
        )
        .filter((row) =>
          !after ||
          row.updatedAt > after.updatedAt ||
          (row.updatedAt === after.updatedAt && row._creationTime > after.creationTime) ||
          (row.updatedAt === after.updatedAt &&
            row._creationTime === after.creationTime &&
            String(row._id) > after.id),
        );
      const page = matching.slice(0, numItems);
      const last = page.at(-1);
      return {
        page,
        isDone: page.length >= matching.length,
        continueCursor: last
          ? JSON.stringify({
              creationTime: last._creationTime,
              id: String(last._id),
              updatedAt: last.updatedAt,
            })
          : cursor ?? "",
      };
    },
    async take(limit) {
      return rows(table)
        .filter((row) => predicates.every((predicate) => predicate(row)))
        .slice(0, limit);
    },
    async unique() {
      const matching = rows(table).filter((row) =>
        predicates.every((predicate) => predicate(row)),
      );
      if (matching.length > 1) throw new Error("Expected one scraped-post retention cursor.");
      return matching[0] ?? null;
    },
  });

  return {
    deleted,
    instagramEventSources,
    retentionCursors,
    scrapedPosts,
    sourceOccurrences,
    ctx: {
      db: {
        query(table) {
          return {
            withIndex(_index, configure) {
              const predicates = [];
              const builder = {
                eq(field, value) {
                  predicates.push((row) => row[field] === value);
                  return builder;
                },
                lt(field, value) {
                  predicates.push((row) => row[field] < value);
                  return builder;
                },
              };
              configure(builder);
              return queryResult(table, predicates);
            },
          };
        },
        async delete(id) {
          if (scrapedPosts.delete(id)) {
            deleted.push(id);
            return;
          }
          assert.ok(retentionCursors.delete(id), `Unexpected deletion ${id}.`);
        },
        async insert(table, value) {
          assert.equal(table, "scrapedPostRetentionCursors");
          const id = "scraped-post-retention-cursor";
          assert.equal(retentionCursors.has(id), false);
          retentionCursors.set(id, { _id: id, ...structuredClone(value) });
          return id;
        },
        async patch(id, patch) {
          assert.ok(retentionCursors.has(id));
          retentionCursors.set(id, {
            ...retentionCursors.get(id),
            ...structuredClone(patch),
          });
        },
      },
    },
  };
}

const scrapedPostRetention = makeScrapedPostRetentionCtx();
const firstScrapedPage = await runMutation(deleteOldScrapedPosts._handler, scrapedPostRetention.ctx, {
  cutoffUpdatedAt: 100,
  cursor: null,
  limit: 2,
});
assert.equal(firstScrapedPage.scannedCount, 2);
assert.equal(firstScrapedPage.deletedCount, 1);
assert.equal(firstScrapedPage.retainedReferencedCount, 1);
assert.equal(firstScrapedPage.hasMore, true);
assert.ok(firstScrapedPage.continueCursor);
assert.equal(firstScrapedPage.cutoffUpdatedAt, 100);
assert.equal(scrapedPostRetention.retentionCursors.size, 1);
assert.equal(
  [...scrapedPostRetention.retentionCursors.values()][0].cutoffUpdatedAt,
  100,
);

const retainedOnlyScrapedPage = await runMutation(deleteOldScrapedPosts._handler,
  scrapedPostRetention.ctx,
  {
    cutoffUpdatedAt: 200,
    cursor: null,
    limit: 2,
  },
);
assert.equal(retainedOnlyScrapedPage.scannedCount, 2);
assert.equal(retainedOnlyScrapedPage.deletedCount, 0);
assert.equal(retainedOnlyScrapedPage.retainedReferencedCount, 2);
assert.equal(retainedOnlyScrapedPage.hasMore, true);
assert.equal(
  retainedOnlyScrapedPage.cutoffUpdatedAt,
  100,
  "A later weekly run must resume with the original pinned cutoff.",
);
assert.notEqual(
  retainedOnlyScrapedPage.continueCursor,
  firstScrapedPage.continueCursor,
  "A fully retained page must still advance the cleanup cursor.",
);

const finalScrapedPage = await runMutation(deleteOldScrapedPosts._handler, scrapedPostRetention.ctx, {
  cutoffUpdatedAt: 200,
  cursor: null,
  limit: 2,
});
assert.equal(finalScrapedPage.scannedCount, 1);
assert.equal(finalScrapedPage.deletedCount, 1);
assert.equal(finalScrapedPage.retainedReferencedCount, 0);
assert.equal(finalScrapedPage.hasMore, false);
assert.equal(finalScrapedPage.cutoffUpdatedAt, 100);
assert.equal(scrapedPostRetention.retentionCursors.size, 0);
assert.deepEqual(scrapedPostRetention.deleted, ["old-delete-a", "old-delete-b"]);
assert.deepEqual(
  [...scrapedPostRetention.scrapedPosts.keys()].sort(),
  [
    "old-first-class",
    "old-legacy-post-id",
    "old-legacy-post-url",
    "recent-unreferenced",
  ],
);

const nextCutoffScrapedPage = await runMutation(deleteOldScrapedPosts._handler,
  scrapedPostRetention.ctx,
  {
    cutoffUpdatedAt: 200,
    cursor: null,
    limit: 500,
  },
);
assert.equal(nextCutoffScrapedPage.cutoffUpdatedAt, 200);
assert.equal(nextCutoffScrapedPage.scannedCount, 4);
assert.equal(nextCutoffScrapedPage.deletedCount, 1);
assert.equal(nextCutoffScrapedPage.retainedReferencedCount, 3);
assert.equal(nextCutoffScrapedPage.hasMore, false);
assert.equal(scrapedPostRetention.retentionCursors.size, 0);
assert.deepEqual(scrapedPostRetention.deleted, [
  "old-delete-a",
  "old-delete-b",
  "recent-unreferenced",
]);
assert.deepEqual(
  [...scrapedPostRetention.scrapedPosts.keys()].sort(),
  ["old-first-class", "old-legacy-post-id", "old-legacy-post-url"],
);

const canonicalGuardRetention = makeScrapedPostRetentionCtx();
canonicalGuardRetention.scrapedPosts.clear();
canonicalGuardRetention.sourceOccurrences.clear();
canonicalGuardRetention.instagramEventSources.clear();
canonicalGuardRetention.scrapedPosts.set("old-canonical-variant", {
  _id: "old-canonical-variant",
  _creationTime: 1,
  instagramPostUrl:
    "https://m.instagram.com/reel/CANONICAL-GUARD/?igsh=tracking-query",
  postId: "UNRELATED-POST-ID",
  updatedAt: 10,
});
canonicalGuardRetention.scrapedPosts.set("old-invalid-source-url", {
  _id: "old-invalid-source-url",
  _creationTime: 2,
  instagramPostUrl: "https://example.com/not-instagram",
  postId: "INVALID-SOURCE-URL",
  updatedAt: 20,
});
canonicalGuardRetention.scrapedPosts.set("old-unreferenced-valid", {
  _id: "old-unreferenced-valid",
  _creationTime: 3,
  instagramPostUrl: "https://www.instagram.com/p/UNREFERENCED/",
  postId: "UNREFERENCED",
  updatedAt: 30,
});
canonicalGuardRetention.instagramEventSources.set("link-by-canonical-source-url", {
  _id: "link-by-canonical-source-url",
  canonicalSourceUrl: "https://www.instagram.com/p/CANONICAL-GUARD/",
  instagramPostId: "DIFFERENT-LINK-POST-ID",
  instagramPostUrl: "https://www.instagram.com/p/DIFFERENT-LINK-URL/",
});

const canonicalGuardResult = await runMutation(deleteOldScrapedPosts._handler,
  canonicalGuardRetention.ctx,
  {
    cutoffUpdatedAt: 100,
    cursor: null,
    limit: 500,
  },
);
assert.equal(canonicalGuardResult.scannedCount, 3);
assert.equal(canonicalGuardResult.deletedCount, 1);
assert.equal(canonicalGuardResult.retainedReferencedCount, 2);
assert.deepEqual(canonicalGuardRetention.deleted, ["old-unreferenced-valid"]);
assert.deepEqual(
  [...canonicalGuardRetention.scrapedPosts.keys()].sort(),
  ["old-canonical-variant", "old-invalid-source-url"],
  "Retention must preserve canonical /reel versus /p query variants and fail closed when canonicalization is unavailable.",
);

function makeSameDayCursorCtx(cutoffDate) {
  const events = new Map(
    [
      ["same-day-delete-a", undefined],
      ["same-day-retained-a", "[cross_post_campaign_variant:v1] retained-a"],
      ["same-day-delete-b", undefined],
      ["same-day-retained-b", "[cross_post_campaign_primary:v1] retained-b"],
      ["same-day-delete-c", undefined],
    ].map(([id, moderationNote], index) => [
      id,
      {
        _id: id,
        _creationTime: index + 1,
        date: cutoffDate,
        time: "00:00",
        ...(moderationNote ? { moderationNote } : {}),
      },
    ]),
  );
  const retentionCursors = new Map();
  const deleted = [];
  const rows = (table) =>
    table === "events"
      ? [...events.values()]
      : table === "eventRetentionCursors"
        ? [...retentionCursors.values()]
        : table === "eventDomainMigrationState"
          ? [cleanReceiptTopologyAuditState]
          : table === "sourceOccurrenceTopologyEpoch"
            ? [cleanSourceOccurrenceTopologyEpoch]
        : [];
  const queryResult = (table, predicates) => ({
    async paginate({ cursor, numItems }) {
      assert.equal(table, "events");
      const after = cursor ? JSON.parse(cursor) : null;
      const matching = rows(table)
        .filter((row) => predicates.every((predicate) => predicate(row)))
        .sort(
          (left, right) =>
            left.date.localeCompare(right.date) ||
            left._creationTime - right._creationTime ||
            String(left._id).localeCompare(String(right._id)),
        )
        .filter((row) =>
          !after ||
          row.date > after.date ||
          (row.date === after.date && row._creationTime > after.creationTime) ||
          (row.date === after.date &&
            row._creationTime === after.creationTime &&
            String(row._id) > after.id),
        );
      const page = matching.slice(0, numItems);
      const last = page.at(-1);
      return {
        page,
        isDone: page.length >= matching.length,
        continueCursor: last
          ? JSON.stringify({
              creationTime: last._creationTime,
              date: last.date,
              id: String(last._id),
            })
          : cursor ?? "",
      };
    },
    async take(limit) {
      return rows(table)
        .filter((row) => predicates.every((predicate) => predicate(row)))
        .slice(0, limit);
    },
    async unique() {
      const matching = rows(table).filter((row) =>
        predicates.every((predicate) => predicate(row)),
      );
      if (matching.length > 1) throw new Error("Expected one retention cursor.");
      return matching[0] ?? null;
    },
  });

  return {
    deleted,
    events,
    retentionCursors,
    ctx: {
      db: {
        query(table) {
          return {
            withIndex(_index, configure) {
              const predicates = [];
              const builder = {
                eq(field, value) {
                  predicates.push((row) => row[field] === value);
                  return builder;
                },
                lt(field, value) {
                  predicates.push((row) => row[field] < value);
                  return builder;
                },
              };
              configure(builder);
              return queryResult(table, predicates);
            },
          };
        },
        async delete(id) {
          if (events.delete(id)) {
            deleted.push(id);
            return;
          }
          assert.ok(retentionCursors.delete(id), `Unexpected deletion ${id}.`);
        },
        async insert(table, value) {
          if (table === "eventAuditLog") {
            return `same-day-audit-${value.eventId}`;
          }
          assert.equal(table, "eventRetentionCursors");
          const id = "same-day-retention-cursor";
          retentionCursors.set(id, { _id: id, ...structuredClone(value) });
          return id;
        },
        async patch(id, patch) {
          assert.ok(retentionCursors.has(id));
          retentionCursors.set(id, {
            ...retentionCursors.get(id),
            ...structuredClone(patch),
          });
        },
      },
    },
  };
}

const currentCutoff = getEventExpiryCutoff(
  new Date(),
  getConfiguredEventTimezone(),
);

// A full previous page may leave a cursor whose terminal page is empty.
// Production Convex still counts that empty page as this mutation's one query.
const emptyFinalEarlierPage = makeSameDayCursorCtx("2026-09-21");
emptyFinalEarlierPage.retentionCursors.set("resumed-retention-cursor", {
  _id: "resumed-retention-cursor",
  key: "expired-events-v1",
  cutoffDate: "2026-09-21",
  cutoffMinutesSinceMidnight: 60,
  beforeDateCursor: JSON.stringify({ date: "2026-09-20", creationTime: 99, id: "previously-deleted" }),
  beforeDateScanComplete: false,
  sameDayScanComplete: false,
  createdAt: 1,
  updatedAt: 1,
});
const resumedTransition = await runMutation(deleteExpiredEvents._handler, emptyFinalEarlierPage.ctx, { batchSize: 1 });
assert.equal(resumedTransition.deletedEventCount, 0);
assert.equal(resumedTransition.beforeDateScanComplete, true);
assert.equal(resumedTransition.sameDayScanComplete, false);
assert.equal(resumedTransition.sameDayCursor, null);
assert.equal(resumedTransition.hasMore, true);
assert.equal(emptyFinalEarlierPage.events.size, 5);
assert.equal(emptyFinalEarlierPage.retentionCursors.get("resumed-retention-cursor").beforeDateScanComplete, true);
const resumedSameDay = await runMutation(deleteExpiredEvents._handler, emptyFinalEarlierPage.ctx, { batchSize: 1 });
assert.equal(resumedSameDay.deletedEventCount, 1);
assert.equal(resumedSameDay.sameDayExpiredEventCount, 1);
assert.equal(resumedSameDay.cutoffDate, "2026-09-21");
assert.equal(resumedSameDay.cutoffTime, "01:00", "Resume must keep the original cutoff pinned.");
assert.equal(resumedSameDay.hasMore, true);

const explicitEmptyEarlierPage = makeSameDayCursorCtx("2026-09-21");
const explicitEmptyResult = await runMutation(deleteExpiredEvents._handler, explicitEmptyEarlierPage.ctx, {
  batchSize: 1, beforeDate: "2026-09-21",
});
assert.equal(explicitEmptyResult.hasMore, false, "Explicit beforeDate must not add a same-day phase.");
assert.equal(explicitEmptyResult.deletedEventCount, 0);
assert.equal(explicitEmptyEarlierPage.events.size, 5);
assert.equal(explicitEmptyEarlierPage.retentionCursors.size, 0);

const sameDayRetention = makeSameDayCursorCtx(currentCutoff.isoDate);
const initialSameDayTransition = await runMutation(deleteExpiredEvents._handler, sameDayRetention.ctx, {
  batchSize: 2,
});
assert.equal(initialSameDayTransition.beforeDateScanComplete, true);
assert.equal(initialSameDayTransition.sameDayScanComplete, false);
assert.equal(initialSameDayTransition.sameDayCursor, null);
assert.equal(initialSameDayTransition.deletedEventCount, 0,
  "An empty earlier-date scan must commit its phase transition before paginating the cutoff date.");
assert.equal(initialSameDayTransition.hasMore, true);
assert.equal(sameDayRetention.retentionCursors.size, 1);
assert.equal([...sameDayRetention.retentionCursors.values()][0].beforeDateScanComplete, true);
const firstSameDayPage = await runMutation(deleteExpiredEvents._handler, sameDayRetention.ctx, {
  batchSize: 2,
});
assert.equal(firstSameDayPage.beforeDateScanComplete, true);
assert.equal(firstSameDayPage.sameDayScanComplete, false);
assert.equal(firstSameDayPage.deletedEventCount, 1);
assert.equal(firstSameDayPage.sameDayExpiredEventCount, 1);
assert.equal(firstSameDayPage.hasMore, true);
assert.ok(firstSameDayPage.sameDayCursor);
assert.equal(sameDayRetention.retentionCursors.size, 1);

const secondSameDayPage = await runMutation(deleteExpiredEvents._handler, sameDayRetention.ctx, {
  batchSize: 2,
});
assert.equal(secondSameDayPage.sameDayScanComplete, false);
assert.equal(secondSameDayPage.deletedEventCount, 0);
assert.equal(secondSameDayPage.sameDayExpiredEventCount, 0);
assert.equal(secondSameDayPage.retainedCampaignEventCount, 1);
assert.equal(secondSameDayPage.hasMore, true);
assert.notEqual(secondSameDayPage.sameDayCursor, firstSameDayPage.sameDayCursor);

const thirdSameDayPage = await runMutation(deleteExpiredEvents._handler, sameDayRetention.ctx, { batchSize: 2 });
assert.equal(thirdSameDayPage.deletedEventCount, 1);
assert.equal(thirdSameDayPage.hasMore, true);
const fourthSameDayPage = await runMutation(deleteExpiredEvents._handler, sameDayRetention.ctx, { batchSize: 2 });
assert.equal(fourthSameDayPage.deletedEventCount, 0);
assert.equal(fourthSameDayPage.retainedCampaignEventCount, 1);
assert.equal(fourthSameDayPage.hasMore, true);

const finalSameDayPage = await runMutation(deleteExpiredEvents._handler, sameDayRetention.ctx, {
  batchSize: 2,
});
assert.equal(finalSameDayPage.sameDayScanComplete, true);
assert.equal(finalSameDayPage.sameDayCursor, null);
assert.equal(finalSameDayPage.deletedEventCount, 1);
assert.equal(finalSameDayPage.sameDayExpiredEventCount, 1);
assert.equal(finalSameDayPage.hasMore, false);
assert.equal(sameDayRetention.retentionCursors.size, 0);
assert.deepEqual(sameDayRetention.deleted, [
  "same-day-delete-a",
  "same-day-delete-b",
  "same-day-delete-c",
]);
assert.deepEqual(
  [...sameDayRetention.events.keys()].sort(),
  ["same-day-retained-a", "same-day-retained-b"],
);

console.log("Convex retention cron QA passed.");
