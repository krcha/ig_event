import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireAdminOrServiceSecret } from "./authz";

// A chunk is an accounting shard, not an execution batch. Keeping one receipt
// per shard prevents eight executors from repeatedly patching the same chunk
// counter (and therefore fighting Convex's optimistic-concurrency retries).
const MAX_HANDLES_PER_CHUNK = 1;
const MAX_HANDLES_PER_RUN = 2_000;
// Convex mutations are deliberately kept small.  The HTTP route repeatedly
// calls buildQueueBatch; provider execution remains impossible until the
// frozen snapshot is fully materialized.
const QUEUE_BUILD_BATCH_SIZE = 32;
// Six independent lanes are deliberately below the VPS/provider comfort
// ceiling. More importantly, each lane owns a disjoint receipt set, so
// multiple workers never race to patch the same "first queued" receipt.
const MAX_CONCURRENCY = 6;
// Actor-side pinned filtering is advisory. Fetch this bounded window, then
// choose the newest dated non-pinned item locally in the web executor.
const SOURCE_RESULTS_LIMIT = 4;
const COST_PER_PROFILE_MICROS = 10_000;
const LEASE_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const MAX_PROCESSING_ATTEMPTS = 3;

const modeValidator = v.union(v.literal("canary"), v.literal("catch_up"), v.literal("daily"));
const outcomeValidator = v.union(
  v.literal("fetched"),
  v.literal("no_post"),
  v.literal("deferred"),
  v.literal("failed"),
);
const terminalScrapedPostOutcomes = new Set([
  "terminal_no_event",
  "terminal_permanent_failure",
  "receipt_complete",
]);

const receiptCompletionValidator = v.object({
  complete: v.boolean(),
  terminalReceiptCount: v.number(),
  selectedHandleCount: v.number(),
});
const processingReceiptCompletionValidator = v.object({
  complete: v.boolean(),
  terminalReceiptCount: v.number(),
  selectedHandleCount: v.number(),
  status: v.union(v.literal("fetched"), v.literal("failed")),
  processingOutcome: v.string(),
});

function isTerminalScrapedPost(post: any): boolean {
  return (
    post?.processingStatus === "completed" &&
    terminalScrapedPostOutcomes.has(post.processingOutcome ?? "")
  );
}

function getScrapedPostSourceRevision(post: any): number {
  return post?.sourceRevision ?? 1;
}

function receiptRevisionMatchesPost(receipt: any, post: any): boolean {
  return (
    post !== null &&
    receipt.scrapedPostSourceRevision !== undefined &&
    receipt.scrapedPostSourceRevision === getScrapedPostSourceRevision(post)
  );
}

async function getLinkedReceiptScrapedPost(ctx: { db: any }, receipt: any) {
  if (!receipt.scrapedPostId) return null;
  const linked = await ctx.db.get(receipt.scrapedPostId);
  return linked?.handle === receipt.handle ? linked : null;
}

type RunMode = "canary" | "catch_up" | "daily";

function normalizeHandle(value: string): string {
  return value.trim().replace(/^@+/, "").toLowerCase();
}

function uniqueNormalizedHandles(handles: string[]): string[] {
  const unique = new Set<string>();
  for (const raw of handles) {
    const handle = normalizeHandle(raw);
    if (!/^[a-z0-9._]{1,128}$/.test(handle)) {
      throw new Error(`Invalid Instagram handle: ${raw}`);
    }
    unique.add(handle);
  }
  return [...unique].sort((a, b) => a.localeCompare(b));
}

function stableExecutionSlot(handle: string): number {
  // A stable non-cryptographic hash is sufficient for lane distribution. It
  // must be deterministic across a restart so a receipt never changes owner.
  let hash = 0;
  for (let index = 0; index < handle.length; index += 1) {
    hash = (Math.imul(hash, 31) + handle.charCodeAt(index)) | 0;
  }
  return (hash >>> 0) % MAX_CONCURRENCY;
}

function assertExecutionSlot(value: number | undefined, fallbackKey: string): number {
  if (value === undefined) return stableExecutionSlot(fallbackKey);
  if (!Number.isInteger(value) || value < 0 || value >= MAX_CONCURRENCY) {
    throw new Error(`Worker slot must be an integer from 0 to ${MAX_CONCURRENCY - 1}.`);
  }
  return value;
}

function controlsFor(mode: RunMode) {
  if (mode === "canary") {
    return {
      resultsLimit: SOURCE_RESULTS_LIMIT,
      daysBack: 1,
      // Keep fresh pins in the bounded actor output; selection below the actor
      // only admits pins that are genuinely <=24h old for canary/daily runs.
      skipPinnedPosts: false,
      pinnedPostPolicy: "include_recent" as const,
      concurrency: MAX_CONCURRENCY,
      costPerProfileMicros: COST_PER_PROFILE_MICROS,
      budgetMicros: 16 * COST_PER_PROFILE_MICROS,
      ignoreCheckpoint: false,
      ignoreCooldown: false,
    };
  }
  if (mode === "catch_up") {
    return {
      resultsLimit: SOURCE_RESULTS_LIMIT,
      skipPinnedPosts: true,
      pinnedPostPolicy: "exclude_all" as const,
      concurrency: MAX_CONCURRENCY,
      costPerProfileMicros: COST_PER_PROFILE_MICROS,
      budgetMicros: 700 * COST_PER_PROFILE_MICROS,
      ignoreCheckpoint: true,
      ignoreCooldown: true,
    };
  }
  return {
    resultsLimit: SOURCE_RESULTS_LIMIT,
    daysBack: 1,
    skipPinnedPosts: false,
    pinnedPostPolicy: "include_recent" as const,
    concurrency: MAX_CONCURRENCY,
    costPerProfileMicros: COST_PER_PROFILE_MICROS,
    budgetMicros: 700 * COST_PER_PROFILE_MICROS,
    ignoreCheckpoint: false,
    ignoreCooldown: false,
  };
}

function assertModeScope(mode: RunMode, handles: string[], controls: ReturnType<typeof controlsFor>) {
  if (handles.length === 0) throw new Error("A durable ingestion run needs at least one profile.");
  if (handles.length > MAX_HANDLES_PER_RUN) throw new Error("Durable ingestion run exceeds the handle safety limit.");
  if (mode === "canary" && handles.length !== 16) {
    throw new Error("Canary runs must select exactly 16 profiles.");
  }
  if (mode === "catch_up" && controls.daysBack !== undefined) {
    throw new Error("Catch-up runs must not have an age cutoff.");
  }
  if (mode === "daily" && controls.daysBack !== 1) {
    throw new Error("Daily runs must have exactly a 24-hour window.");
  }
  if (handles.length * controls.costPerProfileMicros > controls.budgetMicros) {
    throw new Error("Selected profiles exceed this run's frozen budget.");
  }
}

const terminalStatuses = ["fetched", "no_post", "deferred", "failed"] as const;

async function terminalCountsForRun(ctx: { db: any }, runId: string, selectedHandleCount: number) {
  // A run is admitted only when every selected handle fits inside its frozen
  // budget, which bounds current production runs to 700 receipts. Query each
  // indexed terminal state rather than maintaining a hot master counter.
  const perState = await Promise.all(
    terminalStatuses.map((status) =>
      ctx.db
        .query("ingestionRunHandleReceipts")
        .withIndex("by_run_status", (q: any) => q.eq("runId", runId).eq("status", status))
        .take(selectedHandleCount + 1),
    ),
  );
  const terminalReceiptCount = perState.reduce((total, rows) => total + rows.length, 0);
  const failedReceiptCount = perState[terminalStatuses.indexOf("failed")].length;
  return { terminalReceiptCount, failedReceiptCount };
}

async function finishRunIfTerminal(ctx: { db: any }, run: any, now: number) {
  const counts = await terminalCountsForRun(ctx, run._id, run.selectedHandleCount);
  if (counts.terminalReceiptCount !== run.selectedHandleCount) return false;
  // This is the only executor-path write to the master run. It happens once,
  // after all receipt rows are terminal, instead of on every one of 632 jobs.
  await ctx.db.patch(run._id, {
    status: "completed",
    terminalReceiptCount: counts.terminalReceiptCount,
    failedReceiptCount: counts.failedReceiptCount,
    inFlightCount: 0,
    finishedAt: now,
    updatedAt: now,
  });
  return true;
}

async function settleReceiptAfterProviderBoundary(
  ctx: { db: any },
  run: any,
  receipt: any,
  now: number,
): Promise<boolean> {
  if (receipt.providerResultStatus === "persisted") {
    await ctx.db.patch(receipt._id, {
      status: "processing_pending",
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      retryNotBeforeAt: now,
      outcomeDetail: receipt.scrapedPostId
        ? "saved_post_processing_recovered"
        : "saved_post_identity_recovery_required",
      updatedAt: now,
    });
    return true;
  }
  if (receipt.providerResultStatus === "no_post") {
    await ctx.db.patch(receipt._id, {
      status: "no_post",
      terminalAt: now,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      retryNotBeforeAt: undefined,
      outcomeDetail: "persisted_provider_no_post",
      updatedAt: now,
    });
    await finishRunIfTerminal(ctx, run, now);
    return true;
  }
  if ((receipt.providerAttemptCount ?? 0) > 0) {
    await ctx.db.patch(receipt._id, {
      status: "deferred",
      terminalAt: now,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      retryNotBeforeAt: undefined,
      outcomeDetail: "provider_attempt_persistence_unconfirmed",
      updatedAt: now,
    });
    await finishRunIfTerminal(ctx, run, now);
    return true;
  }
  return false;
}

async function revokeReceiptScrapedPostProcessingLease(
  ctx: { db: any },
  receipt: any,
  now: number,
  outcome: string,
) {
  if (!receipt.scrapedPostId || !receipt.leaseOwner) return;
  const post = await ctx.db.get(receipt.scrapedPostId);
  if (
    !post ||
    post.handle !== receipt.handle ||
    post.processingStatus !== "processing" ||
    post.processingLeaseOwner !== receipt.leaseOwner ||
    !receiptRevisionMatchesPost(receipt, post)
  ) {
    return;
  }
  await ctx.db.patch(post._id, {
    processingStatus: "retryable_failure",
    blocksPaidFetch: false,
    processingOutcome: outcome.slice(0, 160),
    processingError: "Durable receipt ownership ended before saved-post processing completed.",
    processingLeaseOwner: undefined,
    processingLeaseExpiresAt: undefined,
    processingRetryAt: now,
    lastProcessedAt: now,
    updatedAt: now,
  });
}

async function fenceExpiredProcessingForAbort(ctx: { db: any }, run: any, now: number) {
  const [activeFetch, processing] = await Promise.all([
    ctx.db
      .query("ingestionRunHandleReceipts")
      .withIndex("by_run_status", (q: any) =>
        q.eq("runId", run._id).eq("status", "running"),
      )
      .take(1),
    ctx.db
      .query("ingestionRunHandleReceipts")
      .withIndex("by_run_status", (q: any) =>
        q.eq("runId", run._id).eq("status", "processing"),
      )
      .first(),
  ]);
  if (activeFetch.length > 0 || (processing?.leaseExpiresAt ?? 0) > now) {
    throw new Error("Cannot abort a durable run with an active receipt lease.");
  }
  if (processing) {
    // Atomically revoke an expired AI owner before failing the run. Completion
    // and release also check run status and lease expiry, so the stale worker
    // cannot commit after this operator action.
    await revokeReceiptScrapedPostProcessingLease(
      ctx,
      processing,
      now,
      "durable_run_aborted",
    );
    await ctx.db.patch(processing._id, {
      status: "processing_pending",
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      retryNotBeforeAt: undefined,
      outcomeDetail: "processing_lease_fenced_by_run_abort",
      updatedAt: now,
    });
  }
}

export const queueRun = mutation({
  args: {
    mode: modeValidator,
    sourceSnapshotKey: v.string(),
    handles: v.array(v.string()),
    // Only the host-owned daily entry point may opt into resuming a previous
    // daily run.  Canaries and catch-ups must always be explicit operations.
    resumeDaily: v.optional(v.boolean()),
    serviceSecret: v.optional(v.string()),
  },
  returns: v.id("ingestionRuns"),
  handler: async (ctx, args) => {
    const actor = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const handles = uniqueNormalizedHandles(args.handles);
    const controls = controlsFor(args.mode);
    assertModeScope(args.mode, handles, controls);
    if (!args.sourceSnapshotKey.trim()) throw new Error("A frozen source snapshot key is required.");

    // Building, daily and catch-up runs must never overlap. The indexed reads are bounded
    // and make a second paid run an explicit operator decision instead of a
    // hidden double-spend race.
    const active = (await Promise.all(
      (["building", "queued", "running"] as const).map((status) =>
        ctx.db
          .query("ingestionRuns")
          .withIndex("by_status_createdAt", (q) => q.eq("status", status))
          .order("desc")
          .take(2),
      ),
    )).flat();
    if (active.length > 0) {
      const existingDaily = active.length === 1 && active[0].mode === "daily";
      // Queue requests may be retried by the admin UI after a network error.
      // For an identical frozen canary, return the original queued run instead
      // of making the caller interpret the overlap guard as a server failure.
      // This is deliberately limited to the same snapshot and handle count;
      // a changed selection must remain an explicit new operator action.
      const existingCanary =
        active.length === 1 &&
        active[0].mode === "canary" &&
        active[0].sourceSnapshotKey === args.sourceSnapshotKey.trim() &&
        active[0].selectedHandleCount === handles.length;
      const existingEquivalent =
        active.length === 1 &&
        active[0].mode === args.mode &&
        active[0].sourceSnapshotKey === args.sourceSnapshotKey.trim() &&
        active[0].selectedHandleCount === handles.length;
      if (args.mode === "daily" && args.resumeDaily === true && existingDaily) {
        return active[0]._id;
      }
      if (args.mode === "canary" && existingCanary) {
        return active[0]._id;
      }
      // Network retries of a catch-up queue request must continue materializing
      // the same frozen run, rather than fail with an overlap error or create
      // a second snapshot.
      if (existingEquivalent) return active[0]._id;
      throw new Error("Another durable ingestion run is already active.");
    }

    const now = Date.now();
    const runId = await ctx.db.insert("ingestionRuns", {
      mode: args.mode,
      status: "building",
      sourceSnapshotKey: args.sourceSnapshotKey.trim(),
      selectedHandles: handles,
      queueBuildCursor: 0,
      selectedHandleCount: handles.length,
      terminalReceiptCount: 0,
      failedReceiptCount: 0,
      inFlightCount: 0,
      reservedMicros: 0,
      chargedMicros: 0,
      controls,
      createdBy: actor.actor,
      createdAt: now,
      updatedAt: now,
    });
    return runId;
  },
});

/**
 * Materialize one bounded slice of the already-frozen parent snapshot. This
 * is idempotent: Convex commits the receipt inserts and cursor patch together,
 * so a crash or HTTP retry either repeats no work or advances from the next
 * ordinal. Execution refuses `building` runs, therefore no provider request
 * can escape before every selected handle has an auditable receipt.
 */
export const buildQueueBatch = mutation({
  args: {
    runId: v.id("ingestionRuns"),
    serviceSecret: v.optional(v.string()),
  },
  returns: v.object({ runId: v.id("ingestionRuns"), builtCount: v.number(), selectedHandleCount: v.number(), complete: v.boolean() }),
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("Durable ingestion run not found.");
    const handles = run.selectedHandles;
    if (!handles || handles.length !== run.selectedHandleCount) {
      throw new Error("Run has no valid frozen source snapshot.");
    }
    const cursor = Math.max(0, Math.min(handles.length, Math.trunc(run.queueBuildCursor ?? 0)));
    if (run.status !== "building") {
      return { runId: run._id, builtCount: cursor, selectedHandleCount: handles.length, complete: run.queueBuildCompletedAt !== undefined };
    }
    const end = Math.min(handles.length, cursor + QUEUE_BUILD_BATCH_SIZE);
    const now = Date.now();
    for (let ordinal = cursor; ordinal < end; ordinal += 1) {
      const handle = handles[ordinal];
      const chunkId = await ctx.db.insert("ingestionRunChunks", {
        runId: run._id,
        ordinal,
        handleCount: 1,
        terminalReceiptCount: 0,
        status: "queued",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("ingestionRunHandleReceipts", {
          runId: run._id,
          chunkId,
          handle,
          status: "queued",
          attemptCount: 0,
          providerAttemptCount: 0,
          processingAttemptCount: 0,
          executionSlot: ordinal % MAX_CONCURRENCY,
          retryNotBeforeAt: now,
          createdAt: now,
          updatedAt: now,
      });
    }
    const complete = end === handles.length;
    await ctx.db.patch(run._id, {
      queueBuildCursor: end,
      ...(complete ? { status: "queued", queueBuildCompletedAt: now, dispatchReadyAt: now } : {}),
      updatedAt: now,
    });
    return { runId: run._id, builtCount: end, selectedHandleCount: handles.length, complete };
  },
});

// A probe is intentionally read-only. Hosts use it to decide whether work is
// available; only executeNext may take a paid-work lease.
export const probeRun = query({
  args: { runId: v.id("ingestionRuns"), serviceSecret: v.optional(v.string()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const run = await ctx.db.get(args.runId);
    if (!run) return null;
    const counts = await terminalCountsForRun(ctx, run._id, run.selectedHandleCount);
    const [fetchingReceipts, processingReceipts] = await Promise.all([
      ctx.db
        .query("ingestionRunHandleReceipts")
        .withIndex("by_run_status", (q) => q.eq("runId", run._id).eq("status", "running"))
        .take(run.controls.concurrency + 1),
      ctx.db
        .query("ingestionRunHandleReceipts")
        .withIndex("by_run_status", (q) => q.eq("runId", run._id).eq("status", "processing"))
        .take(2),
    ]);
    return {
      runId: run._id,
      mode: run.mode,
      status: run.status,
      selectedHandleCount: run.selectedHandleCount,
      terminalReceiptCount: counts.terminalReceiptCount,
      failedReceiptCount: counts.failedReceiptCount,
      inFlightCount: fetchingReceipts.length + processingReceipts.length,
      controls: run.controls,
      queueBuildCursor: run.queueBuildCursor ?? 0,
      queueReady: run.queueBuildCompletedAt !== undefined,
      dispatchReady: run.dispatchReadyAt !== undefined,
      complete: counts.terminalReceiptCount === run.selectedHandleCount,
    };
  },
});

// Operational escape hatch for a legacy run that was stopped before a
// controller repair was deployed. It intentionally preserves all receipts and
// refuses to close a run while a worker still owns a receipt.
export const abortInactiveRun = mutation({
  args: {
    runId: v.id("ingestionRuns"),
    reason: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  returns: v.object({
    status: v.literal("failed"),
    terminalReceiptCount: v.number(),
    failedReceiptCount: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("Durable ingestion run not found.");
    if (run.status !== "queued" && run.status !== "running") {
      throw new Error("Only an inactive queued or running durable run can be aborted.");
    }
    const now = Date.now();
    await fenceExpiredProcessingForAbort(ctx, run, now);
    const counts = await terminalCountsForRun(ctx, run._id, run.selectedHandleCount);
    await ctx.db.patch(run._id, {
      status: "failed",
      terminalReceiptCount: counts.terminalReceiptCount,
      failedReceiptCount: counts.failedReceiptCount,
      inFlightCount: 0,
      error: args.reason.slice(0, 256),
      finishedAt: now,
      updatedAt: now,
    });
    return { status: "failed" as const, ...counts };
  },
});

// A narrow operational helper for the single stalled catch-up recovery path.
// It preserves receipt history and refuses to act if a worker is still active.
export const abortOnlyInactiveCatchUpRun = mutation({
  args: {
    reason: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  returns: v.object({
    runId: v.id("ingestionRuns"),
    status: v.literal("failed"),
    selectedHandleCount: v.number(),
    terminalReceiptCount: v.number(),
    failedReceiptCount: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const active = (await Promise.all(
      (["queued", "running"] as const).map((status) =>
        ctx.db
          .query("ingestionRuns")
          .withIndex("by_status_createdAt", (q) => q.eq("status", status))
          .order("desc")
          .take(3),
      ),
    )).flat();
    const catchUps = active.filter((run) => run.mode === "catch_up");
    if (catchUps.length !== 1) {
      throw new Error("Expected exactly one active catch-up run to isolate.");
    }
    const run = catchUps[0];
    const now = Date.now();
    await fenceExpiredProcessingForAbort(ctx, run, now);
    const counts = await terminalCountsForRun(ctx, run._id, run.selectedHandleCount);
    await ctx.db.patch(run._id, {
      status: "failed",
      terminalReceiptCount: counts.terminalReceiptCount,
      failedReceiptCount: counts.failedReceiptCount,
      inFlightCount: 0,
      error: args.reason.slice(0, 256),
      finishedAt: now,
      updatedAt: now,
    });
    return {
      runId: run._id,
      status: "failed" as const,
      selectedHandleCount: run.selectedHandleCount,
      ...counts,
    };
  },
});

/**
 * Add fixed execution lanes to an already-materialized run from the preceding
 * release. This is an offline, bounded migration: execution refuses the run
 * until every receipt is slotted, so its existing paid receipts are preserved
 * and cannot be accidentally re-fetched during the upgrade.
 */
export const prepareReceiptSlotsBatch = mutation({
  args: { runId: v.id("ingestionRuns"), serviceSecret: v.optional(v.string()) },
  returns: v.object({ assignedCount: v.number(), complete: v.boolean() }),
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("Durable ingestion run not found.");
    if (run.dispatchReadyAt !== undefined) return { assignedCount: run.selectedHandleCount, complete: true };
    const rows = (await Promise.all(
      (["queued", "running", "processing_pending", "processing", "fetched", "no_post", "deferred", "failed"] as const).map((status) =>
        ctx.db.query("ingestionRunHandleReceipts")
          .withIndex("by_run_status", (q) => q.eq("runId", run._id).eq("status", status))
          .take(run.selectedHandleCount + 1),
      ),
    )).flat();
    const missing = rows.filter((receipt) => receipt.executionSlot === undefined);
    const now = Date.now();
    for (const receipt of missing.slice(0, QUEUE_BUILD_BATCH_SIZE)) {
      await ctx.db.patch(receipt._id, { executionSlot: stableExecutionSlot(receipt.handle), updatedAt: now });
    }
    if (missing.length <= QUEUE_BUILD_BATCH_SIZE) {
      await ctx.db.patch(run._id, { dispatchReadyAt: now, updatedAt: now });
      return { assignedCount: rows.length, complete: true };
    }
    return { assignedCount: rows.length - missing.length + QUEUE_BUILD_BATCH_SIZE, complete: false };
  },
});

export const executeNext = mutation({
  args: { runId: v.id("ingestionRuns"), workerId: v.string(), workerSlot: v.optional(v.number()), serviceSecret: v.optional(v.string()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const run = await ctx.db.get(args.runId);
    if (!run || run.status === "building" || run.status === "completed" || run.status === "failed" || run.queueBuildCompletedAt === undefined || run.dispatchReadyAt === undefined) return null;
    const workerSlot = assertExecutionSlot(args.workerSlot, args.workerId);
    const now = Date.now();
    // Recover one expired receipt before looking at the semaphore. Without
    // this a crashed set of eight workers could hold the run forever.
    const expired = await ctx.db
      .query("ingestionRunHandleReceipts")
      .withIndex("by_run_status_executionSlot_leaseExpiresAt", (q) =>
        q.eq("runId", args.runId).eq("status", "running").eq("executionSlot", workerSlot).lte("leaseExpiresAt", now),
      )
      .order("asc")
      .first();
    if (expired) {
      // Durable provider evidence is authoritative even on the final receipt
      // claim: persisted work goes to AI, a durable empty result is no_post,
      // and a charged-but-unconfirmed boundary is explicitly deferred.
      if (await settleReceiptAfterProviderBoundary(ctx, run, expired, now)) {
        return null;
      }
      if (expired.attemptCount >= MAX_ATTEMPTS) {
        await ctx.db.patch(expired._id, { status: "failed", terminalAt: now, leaseOwner: undefined, leaseExpiresAt: undefined, outcomeDetail: "lease_expired_retry_limit", updatedAt: now });
        await finishRunIfTerminal(ctx, run, now);
      } else {
        await ctx.db.patch(expired._id, { status: "queued", leaseOwner: undefined, leaseExpiresAt: undefined, outcomeDetail: "lease_expired_requeued", updatedAt: now });
      }
      return null;
    }
    // Migrate one already-live queued receipt that has a persisted provider
    // result. Keeping this state out of the fetch selector is the no-refetch
    // fence during an additive web/Convex rollout.
    const legacyProviderBoundary = (
      await ctx.db
        .query("ingestionRunHandleReceipts")
        .withIndex("by_run_status_executionSlot", (q) =>
          q.eq("runId", args.runId).eq("status", "queued").eq("executionSlot", workerSlot),
        )
        .take(MAX_HANDLES_PER_RUN)
    ).find(
      (candidate) =>
        candidate.providerResultStatus !== undefined ||
        (candidate.providerAttemptCount ?? 0) > 0,
    );
    if (
      legacyProviderBoundary &&
      (await settleReceiptAfterProviderBoundary(ctx, run, legacyProviderBoundary, now))
    ) {
      return null;
    }
    // A fixed host worker owns at most one receipt at a time. Without this
    // guard, a duplicate/restarted worker for the same slot could claim a
    // second queued receipt in that lane while the first one is still running.
    // That reintroduces the shared-run concurrency we deliberately removed.
    const activeInLane = await ctx.db
      .query("ingestionRunHandleReceipts")
      .withIndex("by_run_status_executionSlot", (q) =>
        q.eq("runId", args.runId).eq("status", "running").eq("executionSlot", workerSlot),
      )
      .first();
    if (activeInLane) return null;
    let receipt = await ctx.db
      .query("ingestionRunHandleReceipts")
      .withIndex("by_run_status_executionSlot_retryNotBeforeAt", (q) =>
        q.eq("runId", args.runId).eq("status", "queued").eq("executionSlot", workerSlot).lte("retryNotBeforeAt", now),
      )
      .order("asc")
      .first();
    if (!receipt) {
      // Runs queued by the immediately preceding release do not have the new
      // optional retry timestamp. Resume those bounded existing receipts
      // instead of forcing a second paid canary after deployment.
      receipt = (
        await ctx.db
          .query("ingestionRunHandleReceipts")
          .withIndex("by_run_status_executionSlot", (q) => q.eq("runId", args.runId).eq("status", "queued").eq("executionSlot", workerSlot))
          .take(MAX_HANDLES_PER_RUN)
      ).find((candidate) => candidate.retryNotBeforeAt === undefined) ?? null;
    }
    if (!receipt) {
      receipt = await ctx.db
        .query("ingestionRunHandleReceipts")
        .withIndex("by_run_status_executionSlot_leaseExpiresAt", (q) =>
          q.eq("runId", args.runId).eq("status", "running").eq("executionSlot", workerSlot).lte("leaseExpiresAt", now),
        )
        .order("asc")
        .first();
    }
    if (!receipt) return null;
    if (await settleReceiptAfterProviderBoundary(ctx, run, receipt, now)) return null;
    if (receipt.attemptCount >= MAX_ATTEMPTS) {
      await ctx.db.patch(receipt._id, { status: "failed", terminalAt: now, leaseOwner: undefined, leaseExpiresAt: undefined, outcomeDetail: "retry_limit", updatedAt: now });
      await finishRunIfTerminal(ctx, run, now);
      return null;
    }
    await ctx.db.patch(receipt._id, { status: "running", leaseOwner: args.workerId, leaseExpiresAt: now + LEASE_MS, retryNotBeforeAt: undefined, attemptCount: receipt.attemptCount + 1, updatedAt: now });
    // Admission proved the frozen snapshot fits the immutable run budget.
    // Keep reservation/charge accounting on this receipt, not the hot run row.
    if (receipt.reservedMicros === undefined) {
      await ctx.db.patch(receipt._id, { reservedMicros: run.controls.costPerProfileMicros, updatedAt: now });
    }
    return {
      receiptId: receipt._id,
      handle: receipt.handle,
      controls: run.controls,
      // Once the provider boundary has been crossed, retries must resume from
      // the persisted post. Re-fetching would double-charge the same profile.
      providerAttemptCount: receipt.providerAttemptCount ?? 0,
      providerResultStatus: receipt.providerResultStatus,
    };
  },
});

/**
 * Cross the paid-provider boundary atomically. The first outbound attempt
 * consumes the claim-time reservation. Admission already proves the frozen
 * snapshot fits the run budget, and the executor never re-fetches a charged
 * receipt automatically, so this mutation must not update a shared run
 * counter that eight workers would contend on.
 */
export const markReceiptProviderAttemptStarted = mutation({
  args: {
    runId: v.id("ingestionRuns"),
    receiptId: v.id("ingestionRunHandleReceipts"),
    workerId: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  returns: v.object({ started: v.boolean(), reason: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const [run, receipt] = await Promise.all([ctx.db.get(args.runId), ctx.db.get(args.receiptId)]);
    if (!run || !receipt || receipt.runId !== args.runId) throw new Error("Receipt does not belong to this run.");
    if (receipt.status !== "running" || receipt.leaseOwner !== args.workerId) throw new Error("Receipt lease mismatch.");

    const cost = run.controls.costPerProfileMicros;
    if ((receipt.providerAttemptCount ?? 0) > 0) {
      return { started: false, reason: "provider_attempt_already_recorded" };
    }
    const now = Date.now();
    await ctx.db.patch(receipt._id, {
      providerAttemptCount: (receipt.providerAttemptCount ?? 0) + 1,
      chargedMicros: (receipt.chargedMicros ?? 0) + cost,
      updatedAt: now,
    });
    return { started: true };
  },
});

export const completeReceipt = mutation({
  args: { runId: v.id("ingestionRuns"), receiptId: v.id("ingestionRunHandleReceipts"), workerId: v.string(), outcome: outcomeValidator, detail: v.optional(v.string()), serviceSecret: v.optional(v.string()) },
  returns: receiptCompletionValidator,
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const [run, receipt] = await Promise.all([ctx.db.get(args.runId), ctx.db.get(args.receiptId)]);
    if (!run || !receipt || receipt.runId !== args.runId) throw new Error("Receipt does not belong to this run.");
    if (receipt.status !== "running" || receipt.leaseOwner !== args.workerId) throw new Error("Receipt lease mismatch.");
    const now = Date.now();
    await ctx.db.patch(receipt._id, { status: args.outcome, outcomeDetail: args.detail?.slice(0, 256), terminalAt: now, leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: now });
    const complete = await finishRunIfTerminal(ctx, run, now);
    const counts = await terminalCountsForRun(ctx, run._id, run.selectedHandleCount);
    return { complete, terminalReceiptCount: counts.terminalReceiptCount, selectedHandleCount: run.selectedHandleCount };
  },
});

/**
 * Record the durable boundary after `scrapedPosts:upsertManyByHandle` succeeds.
 * It is deliberately separate from charging the provider: if a process dies
 * between those two operations, the receipt remains explicitly unconfirmed
 * instead of being allowed to report a fictitious fetched result.
 */
export const markReceiptPostsPersisted = mutation({
  args: {
    runId: v.id("ingestionRuns"),
    receiptId: v.id("ingestionRunHandleReceipts"),
    workerId: v.string(),
    postCount: v.number(),
    scrapedPostId: v.optional(v.id("scrapedPosts")),
    scrapedPostSourceRevision: v.optional(v.number()),
    postId: v.optional(v.string()),
    instagramPostUrl: v.optional(v.string()),
    processingProtocolVersion: v.optional(v.literal(1)),
    serviceSecret: v.optional(v.string()),
  },
  returns: v.object({
    processingPending: v.boolean(),
    scrapedPostId: v.optional(v.id("scrapedPosts")),
  }),
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const receipt = await ctx.db.get(args.receiptId);
    if (
      !receipt ||
      receipt.runId !== args.runId ||
      receipt.status !== "running" ||
      receipt.leaseOwner !== args.workerId ||
      (receipt.providerAttemptCount ?? 0) < 1
    ) {
      throw new Error("Receipt persistence fence mismatch.");
    }
    const postCount = Math.max(0, Math.trunc(args.postCount));
    if (postCount > 1) {
      throw new Error("A durable receipt may persist at most one selected post.");
    }
    if (
      args.processingProtocolVersion === 1 &&
      postCount === 1 &&
      (!args.scrapedPostId ||
        args.scrapedPostSourceRevision === undefined ||
        !Number.isSafeInteger(args.scrapedPostSourceRevision) ||
        args.scrapedPostSourceRevision < 1)
    ) {
      throw new Error(
        "Processing protocol 1 requires an exact saved-post ID and positive source revision.",
      );
    }
    let scrapedPost = null;
    if (postCount === 1 && (args.scrapedPostId || args.postId || args.instagramPostUrl)) {
      const exactPost = args.scrapedPostId ? await ctx.db.get(args.scrapedPostId) : null;
      if (
        args.scrapedPostId &&
        (!exactPost ||
          exactPost.handle !== receipt.handle ||
          (args.postId && exactPost.postId !== args.postId) ||
          (args.instagramPostUrl && exactPost.instagramPostUrl !== args.instagramPostUrl) ||
          (args.scrapedPostSourceRevision !== undefined &&
            getScrapedPostSourceRevision(exactPost) !== args.scrapedPostSourceRevision))
      ) {
        throw new Error("Persisted receipt exact post identity mismatch.");
      }
      const byPostId = !exactPost && args.postId
        ? await ctx.db
            .query("scrapedPosts")
            .withIndex("by_handle_postId", (q) =>
              q.eq("handle", receipt.handle).eq("postId", args.postId as string),
            )
            .first()
        : null;
      scrapedPost =
        exactPost ??
        byPostId ??
        (!exactPost && args.instagramPostUrl
          ? await ctx.db
              .query("scrapedPosts")
              .withIndex("by_handle_postUrl", (q) =>
                q
                  .eq("handle", receipt.handle)
                  .eq("instagramPostUrl", args.instagramPostUrl as string),
              )
              .first()
          : null);
      if (!scrapedPost) {
        throw new Error("Persisted receipt post could not be linked to durable storage.");
      }
    }
    const now = Date.now();
    const processingPending =
      args.processingProtocolVersion === 1 &&
      postCount === 1 &&
      scrapedPost !== null;
    await ctx.db.patch(receipt._id, {
      providerResultStatus: postCount > 0 ? "persisted" : "no_post",
      persistedPostCount: postCount,
      ...(scrapedPost
        ? {
            scrapedPostId: scrapedPost._id,
            scrapedPostSourceRevision: scrapedPost.sourceRevision ?? 1,
          }
        : {}),
      ...(processingPending
        ? {
            status: "processing_pending" as const,
            leaseOwner: undefined,
            leaseExpiresAt: undefined,
            retryNotBeforeAt: now,
            outcomeDetail: "saved_post_processing_pending",
          }
        : {}),
      updatedAt: now,
    });
    return {
      processingPending,
      ...(scrapedPost ? { scrapedPostId: scrapedPost._id } : {}),
    };
  },
});

/**
 * Claim exactly one persisted post for the shared AI lane. Fetch workers call
 * this before asking for another paid receipt, so the current six-process host
 * runner also acts as a durable consumer without a seventh process or restart.
 */
export const claimNextProcessingReceipt = mutation({
  args: {
    runId: v.id("ingestionRuns"),
    workerId: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  returns: v.union(
    v.null(),
    v.object({
      receiptId: v.id("ingestionRunHandleReceipts"),
      handle: v.string(),
      scrapedPostId: v.id("scrapedPosts"),
      scrapedPostSourceRevision: v.number(),
      processingAttemptCount: v.number(),
      providerAttemptCount: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const run = await ctx.db.get(args.runId);
    if (
      !run ||
      run.status === "building" ||
      run.status === "completed" ||
      run.status === "failed" ||
      run.queueBuildCompletedAt === undefined ||
      run.dispatchReadyAt === undefined
    ) {
      return null;
    }
    const now = Date.now();

    const rejectChangedRevision = async (receipt: any, post: any) => {
      if (receiptRevisionMatchesPost(receipt, post)) return false;
      if (receipt.status !== "deferred") {
        await ctx.db.patch(receipt._id, {
          status: "processing_pending",
          leaseOwner: undefined,
          leaseExpiresAt: undefined,
          retryNotBeforeAt: now + 6 * 60 * 60_000,
          outcomeDetail: "saved_post_revision_changed_recovery_required",
          updatedAt: now,
        });
      }
      return true;
    };

    const expired = await ctx.db
      .query("ingestionRunHandleReceipts")
      .withIndex("by_run_status_leaseExpiresAt", (q) =>
        q.eq("runId", args.runId).eq("status", "processing").lte("leaseExpiresAt", now),
      )
      .order("asc")
      .first();
    if (expired) {
      await revokeReceiptScrapedPostProcessingLease(
        ctx,
        expired,
        now,
        "processing_receipt_lease_expired",
      );
      const post = await getLinkedReceiptScrapedPost(ctx, expired);
      if (await rejectChangedRevision(expired, post)) return null;
      if (
        !isTerminalScrapedPost(post) &&
        (expired.processingAttemptCount ?? 0) >= MAX_PROCESSING_ATTEMPTS
      ) {
        await ctx.db.patch(expired._id, {
          status: "failed",
          terminalAt: now,
          leaseOwner: undefined,
          leaseExpiresAt: undefined,
          outcomeDetail: "processing_lease_expired_retry_limit",
          updatedAt: now,
        });
        await finishRunIfTerminal(ctx, run, now);
      } else {
        await ctx.db.patch(expired._id, {
          status: "processing_pending",
          leaseOwner: undefined,
          leaseExpiresAt: undefined,
          retryNotBeforeAt: now,
          outcomeDetail: "processing_lease_expired_requeued",
          updatedAt: now,
        });
      }
      return null;
    }

    // This indexed guard is the global one-worker semaphore for the run. A
    // duplicate host request can continue fetching, but cannot own a second AI
    // receipt while the first lease is valid.
    const active = await ctx.db
      .query("ingestionRunHandleReceipts")
      .withIndex("by_run_status", (q) =>
        q.eq("runId", args.runId).eq("status", "processing"),
      )
      .first();
    if (active) return null;

    const pendingCandidates = await ctx.db
      .query("ingestionRunHandleReceipts")
      .withIndex("by_run_status_retryNotBeforeAt", (q) =>
        q
          .eq("runId", args.runId)
          .eq("status", "processing_pending")
          .lte("retryNotBeforeAt", now),
      )
      .order("asc")
      .take(run.selectedHandleCount + 1);
    let receipt = null;
    let scrapedPost = null;
    for (const candidate of pendingCandidates) {
      if (!candidate.scrapedPostId) continue;
      const linkedPost = await getLinkedReceiptScrapedPost(ctx, candidate);
      if (!linkedPost) {
        // A deleted or mismatched explicit link is an operator-recovery state,
        // never evidence that the paid receipt failed. Delay this row so it
        // cannot starve other valid processing receipts.
        await ctx.db.patch(candidate._id, {
          retryNotBeforeAt: now + 6 * 60 * 60_000,
          outcomeDetail: "persisted_post_link_invalid_recovery_required",
          updatedAt: now,
        });
        return null;
      }
      if (await rejectChangedRevision(candidate, linkedPost)) return null;
      receipt = candidate;
      scrapedPost = linkedPost;
      break;
    }

    if (!receipt) {
      // Additive rollout compatibility: older web executors left paid,
      // persisted receipts queued. Only a receipt carrying an immutable post
      // ID may enter the AI lane; unlinked paid rows remain fenced from Apify
      // until the authenticated recovery mutation supplies the exact ID.
      const queuedCandidates = await ctx.db
        .query("ingestionRunHandleReceipts")
        .withIndex("by_run_status_providerResultStatus", (q) =>
          q
            .eq("runId", args.runId)
            .eq("status", "queued")
            .eq("providerResultStatus", "persisted"),
        )
        .take(run.selectedHandleCount + 1);
      for (const candidate of queuedCandidates) {
        if (!candidate.scrapedPostId || (candidate.retryNotBeforeAt ?? 0) > now) continue;
        const linkedPost = await getLinkedReceiptScrapedPost(ctx, candidate);
        if (!linkedPost) continue;
        if (await rejectChangedRevision(candidate, linkedPost)) return null;
        receipt = candidate;
        scrapedPost = linkedPost;
        break;
      }
    }
    if (!receipt) {
      // The previous web release could terminalize AI contention as deferred
      // after the post was already saved. Automatically recover only the
      // narrow signature that already carries an immutable post ID. Unlinked
      // historical receipts require an explicit authenticated recovery call.
      const deferredCandidates = await ctx.db
        .query("ingestionRunHandleReceipts")
        .withIndex("by_run_status", (q) =>
          q.eq("runId", args.runId).eq("status", "deferred"),
        )
        .take(run.selectedHandleCount + 1);
      for (const candidate of deferredCandidates) {
        if (
          !candidate.scrapedPostId ||
          (candidate.providerAttemptCount ?? 0) < 1 ||
          !/saved post processing is (busy|deferred)|openai provider execution lease (is busy|could not be acquired)/i.test(
            candidate.outcomeDetail ?? "",
          )
        ) {
          continue;
        }
        const candidatePost = await getLinkedReceiptScrapedPost(ctx, candidate);
        if (candidatePost && !(await rejectChangedRevision(candidate, candidatePost))) {
          receipt = candidate;
          scrapedPost = candidatePost;
          break;
        }
      }
    }
    if (!receipt || !scrapedPost) return null;

    if (receipt.status === "deferred") {
      const chunk = await ctx.db.get(receipt.chunkId);
      if (!chunk) throw new Error("Receipt chunk not found.");
      await ctx.db.patch(chunk._id, {
        terminalReceiptCount: Math.max(0, chunk.terminalReceiptCount - 1),
        status: "running",
        updatedAt: now,
      });
      await ctx.db.patch(run._id, {
        status: "running",
        terminalReceiptCount: Math.max(0, run.terminalReceiptCount - 1),
        finishedAt: undefined,
        updatedAt: now,
      });
    }

    const scrapedPostSourceRevision = receipt.scrapedPostSourceRevision;
    if (scrapedPostSourceRevision === undefined) return null;
    const processingAttemptCount = (receipt.processingAttemptCount ?? 0) + 1;
    await ctx.db.patch(receipt._id, {
      status: "processing",
      scrapedPostId: scrapedPost._id,
      processingAttemptCount,
      leaseOwner: args.workerId,
      leaseExpiresAt: now + LEASE_MS,
      retryNotBeforeAt: undefined,
      outcomeDetail: "saved_post_processing_claimed",
      updatedAt: now,
    });
    return {
      receiptId: receipt._id,
      handle: receipt.handle,
      scrapedPostId: scrapedPost._id,
      scrapedPostSourceRevision,
      processingAttemptCount,
      providerAttemptCount: receipt.providerAttemptCount ?? 0,
    };
  },
});

export const releaseProcessingReceiptForRetry = mutation({
  args: {
    runId: v.id("ingestionRuns"),
    receiptId: v.id("ingestionRunHandleReceipts"),
    workerId: v.string(),
    reason: v.string(),
    retryAfterMs: v.optional(v.number()),
    preserveAttempt: v.optional(v.boolean()),
    serviceSecret: v.optional(v.string()),
  },
  returns: v.object({
    terminal: v.boolean(),
    status: v.union(
      v.literal("processing_pending"),
      v.literal("fetched"),
      v.literal("no_post"),
      v.literal("deferred"),
      v.literal("failed"),
    ),
  }),
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const [run, receipt] = await Promise.all([ctx.db.get(args.runId), ctx.db.get(args.receiptId)]);
    if (!run || !receipt || receipt.runId !== args.runId) {
      throw new Error("Processing receipt does not belong to this run.");
    }
    if (run.status === "failed") {
      throw new Error("Processing receipt belongs to a failed run.");
    }
    if (terminalStatuses.includes(receipt.status as (typeof terminalStatuses)[number])) {
      return {
        terminal: true,
        status: receipt.status as "fetched" | "no_post" | "deferred" | "failed",
      };
    }
    // A mutation can commit even when its HTTP acknowledgement is lost. The
    // route retries this release from its catch path, so make that replay
    // read-only and successful once the exact receipt is already pending.
    // Active receipts still require the original live owner below.
    if (receipt.status === "processing_pending") {
      return { terminal: false, status: "processing_pending" as const };
    }
    const now = Date.now();
    if (
      receipt.status !== "processing" ||
      receipt.leaseOwner !== args.workerId ||
      (receipt.leaseExpiresAt ?? 0) <= now
    ) {
      throw new Error("Processing receipt lease mismatch.");
    }
    // The scraped-post lease may outlive this shorter receipt lease. Revoke
    // the exact owner/revision before either requeueing or terminalizing so a
    // worker that resumes after this mutation cannot still write events/media.
    await revokeReceiptScrapedPostProcessingLease(
      ctx,
      receipt,
      now,
      "processing_receipt_released",
    );
    const attemptCount = Math.max(
      0,
      (receipt.processingAttemptCount ?? 1) - (args.preserveAttempt ? 1 : 0),
    );
    if (!args.preserveAttempt && attemptCount >= MAX_PROCESSING_ATTEMPTS) {
      await ctx.db.patch(receipt._id, {
        status: "failed",
        processingAttemptCount: attemptCount,
        terminalAt: now,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        outcomeDetail: args.reason.slice(0, 256),
        updatedAt: now,
      });
      await finishRunIfTerminal(ctx, run, now);
      return { terminal: true, status: "failed" as const };
    }
    const retryAfterMs = Math.max(
      1_000,
      Math.min(6 * 60 * 60_000, Math.trunc(args.retryAfterMs ?? 30_000)),
    );
    await ctx.db.patch(receipt._id, {
      status: "processing_pending",
      processingAttemptCount: attemptCount,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      retryNotBeforeAt: now + retryAfterMs,
      outcomeDetail: args.reason.slice(0, 256),
      updatedAt: now,
    });
    return { terminal: false, status: "processing_pending" as const };
  },
});

export const completeProcessingReceipt = mutation({
  args: {
    runId: v.id("ingestionRuns"),
    receiptId: v.id("ingestionRunHandleReceipts"),
    workerId: v.string(),
    detail: v.optional(v.string()),
    serviceSecret: v.optional(v.string()),
  },
  returns: processingReceiptCompletionValidator,
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const [run, receipt] = await Promise.all([ctx.db.get(args.runId), ctx.db.get(args.receiptId)]);
    if (!run || !receipt || receipt.runId !== args.runId) {
      throw new Error("Receipt does not belong to this run.");
    }
    const now = Date.now();
    if (run.status === "failed") {
      throw new Error("Processing receipt belongs to a failed run.");
    }
    if (
      receipt.status !== "processing" ||
      receipt.leaseOwner !== args.workerId ||
      (receipt.leaseExpiresAt ?? 0) <= now
    ) {
      throw new Error("Processing receipt lease mismatch.");
    }
    const scrapedPost = await getLinkedReceiptScrapedPost(ctx, receipt);
    if (!receiptRevisionMatchesPost(receipt, scrapedPost)) {
      throw new Error("Cannot complete a receipt after its saved-post source revision changed.");
    }
    if (!isTerminalScrapedPost(scrapedPost)) {
      throw new Error("Cannot complete a receipt before its selected saved post is terminal.");
    }
    const detail =
      args.detail?.slice(0, 256) ??
      `saved_post:${scrapedPost._id};${scrapedPost.processingOutcome}`;
    // A processed non-event is a truthful successful skip of a fetched post;
    // a permanent extraction/media failure must remain visible in run failure
    // accounting instead of being flattened into the same receipt status.
    const status =
      scrapedPost.processingOutcome === "terminal_permanent_failure"
        ? ("failed" as const)
        : ("fetched" as const);
    await ctx.db.patch(receipt._id, {
      status,
      outcomeDetail: detail,
      terminalAt: now,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      retryNotBeforeAt: undefined,
      updatedAt: now,
    });
    const complete = await finishRunIfTerminal(ctx, run, now);
    const counts = await terminalCountsForRun(ctx, run._id, run.selectedHandleCount);
    return {
      complete,
      terminalReceiptCount: counts.terminalReceiptCount,
      selectedHandleCount: run.selectedHandleCount,
      status,
      processingOutcome: scrapedPost.processingOutcome,
    };
  },
});

const recoveredReceiptValidator = v.object({
  linked: v.boolean(),
  reopened: v.boolean(),
  status: v.literal("processing_pending"),
  scrapedPostId: v.id("scrapedPosts"),
});

async function linkPersistedReceiptPostForRecoveryHandler(
  ctx: { db: any },
  args: { runId: any; receiptId: any; scrapedPostId: any },
  deferredOnly: boolean,
) {
  const [run, receipt, savedPost] = await Promise.all([
    ctx.db.get(args.runId),
    ctx.db.get(args.receiptId),
    ctx.db.get(args.scrapedPostId),
  ]);
  if (!run || !receipt || receipt.runId !== args.runId) {
    throw new Error("Receipt does not belong to this run.");
  }
  if (run.status === "building" || run.status === "failed") {
    throw new Error("This durable run cannot accept saved-post recovery.");
  }
  const isUnconfirmedPersistenceBoundary =
    receipt.status === "deferred" &&
    receipt.providerResultStatus === undefined &&
    receipt.outcomeDetail === "provider_attempt_persistence_unconfirmed";
  const hasPersistedResult =
    receipt.providerResultStatus === "persisted" &&
    (receipt.persistedPostCount === undefined || receipt.persistedPostCount === 1);
  if ((receipt.providerAttemptCount ?? 0) < 1 || (!hasPersistedResult && !isUnconfirmedPersistenceBoundary)) {
    throw new Error("Only a paid receipt with one persisted result can be recovered.");
  }
  if (!savedPost || savedPost.handle !== receipt.handle) {
    throw new Error("Recovery post must exist and match the receipt handle exactly.");
  }
  if (receipt.scrapedPostId && receipt.scrapedPostId !== savedPost._id) {
    throw new Error("Receipt already has a different immutable saved-post link.");
  }
  const persistenceUpperBound = receipt.terminalAt ?? receipt.updatedAt;
  if (
    !Number.isFinite(savedPost.updatedAt) ||
    savedPost.updatedAt < run.createdAt ||
    savedPost.updatedAt > persistenceUpperBound
  ) {
    throw new Error("Recovery post was not durably updated inside the receipt's fetch window.");
  }

  const alreadyRecovered =
    receipt.status === "processing_pending" &&
    receipt.scrapedPostId === savedPost._id &&
    receipt.outcomeDetail === "saved_post_processing_recovered" &&
    receiptRevisionMatchesPost(receipt, savedPost);
  if (alreadyRecovered) {
    return {
      linked: true,
      reopened: false,
      status: "processing_pending" as const,
      scrapedPostId: savedPost._id,
    };
  }

  const wasDeferred = receipt.status === "deferred";
  if (deferredOnly && !wasDeferred) {
    throw new Error("Only a terminal deferred receipt can be reopened.");
  }
  if (
    wasDeferred &&
    !isUnconfirmedPersistenceBoundary &&
    !/saved post processing is (busy|deferred)|openai provider execution lease (is busy|could not be acquired)/i.test(
      receipt.outcomeDetail ?? "",
    )
  ) {
    throw new Error("Deferred receipt is not eligible for saved-post recovery.");
  }
  if (!wasDeferred && receipt.status !== "queued" && receipt.status !== "processing_pending") {
    throw new Error("Receipt has an active or terminal lease and cannot be relinked.");
  }

  if (wasDeferred && run.status === "completed") {
    // Reopening a completed run is admission, not merely a row repair. Apply
    // the same indexed overlap fence as queueRun in this transaction so an
    // operator cannot resurrect paid work beside a newer active snapshot.
    const otherActiveRuns = (await Promise.all(
      (["building", "queued", "running"] as const).map((status) =>
        ctx.db
          .query("ingestionRuns")
          .withIndex("by_status_createdAt", (q: any) => q.eq("status", status))
          .order("desc")
          .take(2),
      ),
    ))
      .flat()
      .filter((activeRun: any) => activeRun._id !== run._id);
    if (otherActiveRuns.length > 0) {
      throw new Error(
        "Another durable ingestion run is already active; completed-run recovery cannot overlap it.",
      );
    }
  }

  const chunk = wasDeferred ? await ctx.db.get(receipt.chunkId) : null;
  if (wasDeferred && !chunk) throw new Error("Receipt chunk not found.");
  const now = Date.now();
  await ctx.db.patch(receipt._id, {
    status: "processing_pending",
    terminalAt: undefined,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    outcomeDetail: "saved_post_processing_recovered",
    providerResultStatus: "persisted",
    persistedPostCount: 1,
    scrapedPostId: savedPost._id,
    scrapedPostSourceRevision: savedPost.sourceRevision ?? 1,
    retryNotBeforeAt: now,
    updatedAt: now,
  });
  if (wasDeferred) {
    await ctx.db.patch(chunk._id, {
      terminalReceiptCount: Math.max(0, chunk.terminalReceiptCount - 1),
      status: "running",
      updatedAt: now,
    });
    await ctx.db.patch(run._id, {
      status: "queued",
      terminalReceiptCount: Math.max(0, run.terminalReceiptCount - 1),
      finishedAt: undefined,
      updatedAt: now,
    });
  }
  return {
    linked: true,
    reopened: wasDeferred,
    status: "processing_pending" as const,
    scrapedPostId: savedPost._id,
  };
}

/**
 * Link an already-paid legacy receipt to the exact selected scraped-post row.
 * This explicit operator/service action is the only migration path for old
 * receipts that predate `scrapedPostId`; timestamp proximity is never treated
 * as identity, and this mutation never calls the paid provider.
 */
export const linkPersistedReceiptPostForRecovery = mutation({
  args: {
    runId: v.id("ingestionRuns"),
    receiptId: v.id("ingestionRunHandleReceipts"),
    scrapedPostId: v.id("scrapedPosts"),
    serviceSecret: v.optional(v.string()),
  },
  returns: recoveredReceiptValidator,
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    return linkPersistedReceiptPostForRecoveryHandler(ctx, args, false);
  },
});

/**
 * Backward-compatible operator entry point for the narrower terminal deferred
 * case. It now requires the same exact immutable post ID as general recovery.
 */
export const reopenDeferredReceiptFromSavedPost = mutation({
  args: {
    runId: v.id("ingestionRuns"),
    receiptId: v.id("ingestionRunHandleReceipts"),
    scrapedPostId: v.id("scrapedPosts"),
    serviceSecret: v.optional(v.string()),
  },
  returns: v.object({ reopened: v.boolean(), postCount: v.number() }),
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const recovered = await linkPersistedReceiptPostForRecoveryHandler(ctx, args, true);
    return { reopened: recovered.reopened, postCount: 1 };
  },
});

export const releaseReceiptForRetry = mutation({
  args: {
    runId: v.id("ingestionRuns"),
    receiptId: v.id("ingestionRunHandleReceipts"),
    workerId: v.string(),
    reason: v.string(),
    retryAfterMs: v.optional(v.number()),
    // Waiting for another AI worker is not a failed provider attempt. Do not
    // burn this receipt's retry limit while preserving its paid-fetch record.
    preserveAttempt: v.optional(v.boolean()),
    serviceSecret: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const [run, receipt] = await Promise.all([ctx.db.get(args.runId), ctx.db.get(args.receiptId)]);
    if (!run || !receipt || receipt.runId !== args.runId || receipt.status !== "running" || receipt.leaseOwner !== args.workerId) throw new Error("Receipt lease mismatch.");
    const now = Date.now();
    const retryAfterMs = Math.max(0, Math.min(15 * 60_000, Math.trunc(args.retryAfterMs ?? 0)));
    await ctx.db.patch(receipt._id, {
      status: "queued",
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      retryNotBeforeAt: now + retryAfterMs,
      ...(args.preserveAttempt ? { attemptCount: Math.max(0, receipt.attemptCount - 1) } : {}),
      outcomeDetail: args.reason.slice(0, 256),
      updatedAt: now,
    });
    return null;
  },
});
