import assert from "node:assert/strict";
import { getFunctionName } from "convex/server";
import crons from "../convex/crons.ts";
import {
  cleanupIngestionArtifactsUntilDone,
  cleanupOrphanedMediaAssetsUntilDone,
  deleteExpiredEventsUntilDone,
} from "../convex/maintenance.ts";

// Exercise the registered handlers with deterministic mutation results. Actual
// deletion/cursor atomicity is covered by the retention and media handler QA.
const jobs = JSON.parse(crons.export());
assert.deepEqual(Object.keys(jobs).sort(), [
  "approve server-verified unique events",
  "cleanup ingestion artifacts",
  "cleanup orphaned media assets",
  "delete expired events",
]);
assert.deepEqual(jobs["approve server-verified unique events"], {
  name: "internal/automaticUniqueApproval:sweepUntilDone",
  args: [{ maxPages: 60 }],
  schedule: { type: "interval", minutes: 1 },
});
assert.deepEqual(jobs["delete expired events"], {
  name: "maintenance:deleteExpiredEventsUntilDone",
  args: [{ batchSize: 1, maxBatches: 5 }],
  schedule: { type: "interval", minutes: 5 },
});
assert.deepEqual(jobs["cleanup orphaned media assets"], {
  name: "maintenance:cleanupOrphanedMediaAssetsUntilDone",
  args: [{ batchSize: 5, maxBatches: 5 }],
  schedule: { type: "interval", minutes: 15 },
});
assert.deepEqual(jobs["cleanup ingestion artifacts"], {
  name: "maintenance:cleanupIngestionArtifactsUntilDone",
  args: [{ batchSize: 25, maxBatches: 2 }],
  schedule: { type: "hourly", minuteUTC: 7 },
});

const eventResult = (overrides = {}) => ({
  deletedEventCount: 1,
  deletedSavedEventCount: 2,
  cutoffDate: "2026-09-15",
  cutoffTime: "18:00",
  timeZone: "Europe/Belgrade",
  hasMore: false,
  skippedSameDayEventCount: 0,
  sameDayExpiredEventCount: 0,
  retainedCampaignEventCount: 0,
  beforeDateCursor: null,
  beforeDateScanComplete: true,
  sameDayCursor: null,
  sameDayScanComplete: true,
  ...overrides,
});

function assertValidatedSummary(fn, result) {
  assert.equal(fn.isInternal, true);
  assert.equal(fn.isAction, true);
  const validator = JSON.parse(fn.exportReturns());
  assert.equal(validator.type, "object");
  assert.deepEqual(Object.keys(result).sort(), Object.keys(validator.value).sort());
  if (!result.stoppedReason.startsWith("audit_")) {
    assert.equal(result.stoppedReason, result.hasMore ? "max_batches_reached" : "complete");
  }
  assert.equal(Object.values(result).some((value) => value === undefined), false);
}

const auditFunction = "internal/retentionReceiptCoverage:auditRetentionReceiptCoverageBatch";
function withReadyAudit(ctx) {
  return {
    async runMutation(ref, args) {
      if (getFunctionName(ref) === auditFunction) {
        return { ready: true, isDone: true, scannedCount: 100, mismatchCount: 0 };
      }
      return ctx.runMutation(ref, args);
    },
  };
}

const logged = [];
const originalInfo = console.info;
console.info = (...args) => logged.push(args);
try {
  const calls = [];
  const events = await deleteExpiredEventsUntilDone._handler(withReadyAudit({
    async runMutation(ref, args) {
      assert.equal(getFunctionName(ref), "events:deleteExpiredEvents");
      calls.push(structuredClone(args));
      return calls.length === 1
        ? eventResult({
            hasMore: true,
            beforeDateCursor: "before-1",
            beforeDateScanComplete: false,
            sameDayScanComplete: false,
            retainedCampaignEventCount: 1,
          })
        : eventResult({ sameDayExpiredEventCount: 1 });
    },
  }), { beforeDate: "2026-09-15", batchSize: 500, maxBatches: 100 });
  assert.equal(events.batchSize, 1, "one candidate bounds the full campaign/saved-reference transaction");
  assert.equal(events.maxBatches, 5);
  assert.equal(events.batchesRun, 2);
  assert.equal(events.deletedEventCount, 2);
  assert.equal(events.deletedSavedEventCount, 4);
  assert.equal(events.sameDayExpiredEventCount, 1);
  assert.equal(events.retainedCampaignEventCount, 1);
  assert.equal(calls[0].beforeDateCursor, undefined, "first batch must allow durable resumption");
  assert.equal(calls[0].sameDayScanComplete, undefined);
  assert.equal(calls[1].beforeDateCursor, "before-1");
  assert.ok(calls.every((call) => call.beforeDate === "2026-09-15"));
  assertValidatedSummary(deleteExpiredEventsUntilDone, events);

  let cappedCalls = 0;
  const capped = await deleteExpiredEventsUntilDone._handler(withReadyAudit({
    async runMutation() {
      cappedCalls += 1;
      return eventResult({ hasMore: true, beforeDateCursor: `page-${cappedCalls}` });
    },
  }), {});
  assert.equal(cappedCalls, 5, "a scan with more work must yield to the next cron tick");
  assert.equal(capped.hasMore, true);
  assert.equal(capped.stoppedReason, "max_batches_reached");
  assertValidatedSummary(deleteExpiredEventsUntilDone, capped);

  let resumedFirstCall;
  await deleteExpiredEventsUntilDone._handler(withReadyAudit({
    async runMutation(_ref, args) {
      resumedFirstCall = args;
      return eventResult();
    },
  }), {});
  assert.equal(resumedFirstCall.beforeDateCursor, undefined);
  assert.equal(resumedFirstCall.beforeDateScanComplete, undefined);

  let auditCalls = 0;
  const auditPending = await deleteExpiredEventsUntilDone._handler({
    async runMutation(ref) {
      assert.equal(getFunctionName(ref), auditFunction, "no deletion before complete coverage");
      auditCalls += 1;
      return { ready: false, isDone: false, scannedCount: auditCalls * 4, mismatchCount: 0 };
    },
  }, {});
  assert.equal(auditCalls, 20);
  assert.equal(auditPending.batchesRun, 0);
  assert.equal(auditPending.deletedEventCount, 0);
  assert.equal(auditPending.auditReady, false);
  assert.equal(auditPending.auditScannedCount, 80);
  assert.equal(auditPending.stoppedReason, "audit_pending");
  assertValidatedSummary(deleteExpiredEventsUntilDone, auditPending);

  auditCalls = 0;
  const blocked = await deleteExpiredEventsUntilDone._handler({
    async runMutation(ref) {
      assert.equal(getFunctionName(ref), auditFunction);
      auditCalls += 1;
      return { ready: false, isDone: true, scannedCount: 2, mismatchCount: 1 };
    },
  }, { auditMaxBatches: 500 });
  assert.equal(auditCalls, 1);
  assert.equal(blocked.stoppedReason, "audit_blocked");
  assert.equal(blocked.deletedEventCount, 0);
  assertValidatedSummary(deleteExpiredEventsUntilDone, blocked);

  auditCalls = 0;
  const cappedAudit = await deleteExpiredEventsUntilDone._handler({
    async runMutation(ref) {
      assert.equal(getFunctionName(ref), auditFunction);
      auditCalls += 1;
      return { ready: false, isDone: false, scannedCount: auditCalls, mismatchCount: 0 };
    },
  }, { auditMaxBatches: 500 });
  assert.equal(auditCalls, 50);
  assert.equal(cappedAudit.stoppedReason, "audit_pending");

  let mediaPosition = 0;
  const pinnedCutoff = Date.UTC(2026, 8, 8);
  const mediaCalls = [];
  const mediaCtx = {
    async runMutation(ref, args) {
      assert.equal(getFunctionName(ref), "mediaAssets:deleteOrphanedPage");
      mediaCalls.push(structuredClone(args));
      // Simulate the durable mutation checkpoint, which survives a new action.
      mediaPosition += 1;
      return {
        continueCursor: `media-${mediaPosition}`,
        cutoffUpdatedAt: pinnedCutoff,
        deletedAssetCount: 1,
        deletedStorageObjectCount: 1,
        detachedScrapedPostCount: 2,
        retainedAssetCount: 4,
        scannedAssetCount: 5,
        isDone: mediaPosition === 7,
      };
    },
  };
  const mediaFirst = await cleanupOrphanedMediaAssetsUntilDone._handler(mediaCtx, {
    batchSize: 100,
    maxBatches: 100,
  });
  assert.equal(mediaFirst.batchSize, 5);
  assert.equal(mediaFirst.batchesRun, 5);
  assert.equal(mediaFirst.hasMore, true);
  assert.equal(mediaFirst.cutoffUpdatedAt, pinnedCutoff);
  assert.equal(mediaFirst.deletedStorageObjectCount, 5);
  assert.equal(mediaFirst.detachedScrapedPostCount, 10);
  assert.equal(mediaFirst.retainedAssetCount, 20);
  assert.equal(mediaCalls[1].paginationOpts.cursor, "media-1");
  assert.equal(mediaCalls[1].cutoffUpdatedAt, pinnedCutoff);
  assertValidatedSummary(cleanupOrphanedMediaAssetsUntilDone, mediaFirst);
  const mediaSecond = await cleanupOrphanedMediaAssetsUntilDone._handler(mediaCtx, {});
  assert.equal(mediaSecond.batchesRun, 2);
  assert.equal(mediaSecond.hasMore, false);
  assert.equal(mediaFirst.deletedAssetCount + mediaSecond.deletedAssetCount, 7);
  assertValidatedSummary(cleanupOrphanedMediaAssetsUntilDone, mediaSecond);

  let jobCalls = 0;
  let postCalls = 0;
  const artifactCalls = [];
  const artifacts = await cleanupIngestionArtifactsUntilDone._handler({
    async runMutation(ref, args) {
      artifactCalls.push({ name: getFunctionName(ref), ...structuredClone(args) });
      if (getFunctionName(ref) === "ingestionJobs:deleteTerminalOlderThan") {
        jobCalls += 1;
        return { deletedCount: 3, hasMore: jobCalls < 2 };
      }
      assert.equal(getFunctionName(ref), "scrapedPosts:deleteOlderThan");
      postCalls += 1;
      return {
        deletedCount: 1,
        hasMore: postCalls < 2,
        continueCursor: `posts-${postCalls}`,
        cutoffUpdatedAt: pinnedCutoff,
        retainedReferencedCount: 0,
        scannedCount: 1,
      };
    },
  }, { batchSize: 500 });
  assert.equal(artifacts.batchSize, 25);
  assert.equal(artifacts.maxBatches, 2);
  assert.equal(artifacts.deletedIngestionJobCount, 6);
  assert.equal(artifacts.deletedScrapedPostCount, 2);
  assert.equal(artifacts.scrapedPostCutoffUpdatedAt, pinnedCutoff);
  assert.equal(artifactCalls[3].cursor, "posts-1");
  assert.equal(artifactCalls[3].cutoffUpdatedAt, pinnedCutoff);
  assertValidatedSummary(cleanupIngestionArtifactsUntilDone, artifacts);

  for (const fn of [
    deleteExpiredEventsUntilDone,
    cleanupIngestionArtifactsUntilDone,
    cleanupOrphanedMediaAssetsUntilDone,
  ]) {
    const logCount = logged.length;
    await assert.rejects(fn._handler({
      async runMutation() {
        throw new Error("simulated transactional failure");
      },
    }, {}), /simulated transactional failure/);
    assert.equal(logged.length, logCount, "failed work must not log a successful completion");
  }
  assert.ok(logged.every(([label, summary]) =>
    label === "retention_cleanup" && typeof summary.batchesRun === "number"));
} finally {
  console.info = originalInfo;
}

console.log("Bounded cleanup scheduler QA passed (no network or production writes).");
