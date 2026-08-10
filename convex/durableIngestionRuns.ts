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
const MAX_CONCURRENCY = 8;
const COST_PER_PROFILE_MICROS = 10_000;
const LEASE_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;

const modeValidator = v.union(v.literal("canary"), v.literal("catch_up"), v.literal("daily"));
const outcomeValidator = v.union(
  v.literal("fetched"),
  v.literal("no_post"),
  v.literal("deferred"),
  v.literal("failed"),
);

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

function controlsFor(mode: RunMode) {
  if (mode === "canary") {
    return {
      resultsLimit: 1,
      daysBack: 1,
      skipPinnedPosts: true,
      concurrency: MAX_CONCURRENCY,
      costPerProfileMicros: COST_PER_PROFILE_MICROS,
      budgetMicros: 16 * COST_PER_PROFILE_MICROS,
      ignoreCheckpoint: false,
      ignoreCooldown: false,
    };
  }
  if (mode === "catch_up") {
    return {
      resultsLimit: 1,
      skipPinnedPosts: true,
      concurrency: MAX_CONCURRENCY,
      costPerProfileMicros: COST_PER_PROFILE_MICROS,
      budgetMicros: 700 * COST_PER_PROFILE_MICROS,
      ignoreCheckpoint: true,
      ignoreCooldown: true,
    };
  }
  return {
    resultsLimit: 1,
    daysBack: 1,
    skipPinnedPosts: true,
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
          retryNotBeforeAt: now,
          createdAt: now,
          updatedAt: now,
      });
    }
    const complete = end === handles.length;
    await ctx.db.patch(run._id, {
      queueBuildCursor: end,
      ...(complete ? { status: "queued", queueBuildCompletedAt: now } : {}),
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
    const inFlightCount = await ctx.db
      .query("ingestionRunHandleReceipts")
      .withIndex("by_run_status", (q) => q.eq("runId", run._id).eq("status", "running"))
      .take(run.controls.concurrency + 1);
    return {
      runId: run._id,
      mode: run.mode,
      status: run.status,
      selectedHandleCount: run.selectedHandleCount,
      terminalReceiptCount: counts.terminalReceiptCount,
      failedReceiptCount: counts.failedReceiptCount,
      inFlightCount: inFlightCount.length,
      controls: run.controls,
      queueBuildCursor: run.queueBuildCursor ?? 0,
      queueReady: run.queueBuildCompletedAt !== undefined,
      complete: counts.terminalReceiptCount === run.selectedHandleCount,
    };
  },
});

// Operational escape hatch for a legacy run that was stopped before the
// sharded controller was deployed. It never changes receipts, never invokes a
// provider, and refuses to close a run that still has an active worker lease.
// This lets a corrected replacement run be queued without erasing the audit
// trail from the partial run.
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
    const activeLease = await ctx.db
      .query("ingestionRunHandleReceipts")
      .withIndex("by_run_status", (q) => q.eq("runId", args.runId).eq("status", "running"))
      .take(1);
    if (activeLease.length > 0) {
      throw new Error("Cannot abort a durable run with an active receipt lease.");
    }
    const counts = await terminalCountsForRun(ctx, run._id, run.selectedHandleCount);
    const now = Date.now();
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

// This is intentionally narrower than abortInactiveRun: it closes exactly one
// stalled catch-up selected by the durable run guard. It exists so recovery
// tooling need not enumerate production documents or guess a run id.
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
    const activeLease = await ctx.db
      .query("ingestionRunHandleReceipts")
      .withIndex("by_run_status", (q) => q.eq("runId", run._id).eq("status", "running"))
      .take(1);
    if (activeLease.length > 0) {
      throw new Error("Cannot isolate a catch-up run with an active receipt lease.");
    }
    const counts = await terminalCountsForRun(ctx, run._id, run.selectedHandleCount);
    const now = Date.now();
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

export const executeNext = mutation({
  args: { runId: v.id("ingestionRuns"), workerId: v.string(), serviceSecret: v.optional(v.string()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const run = await ctx.db.get(args.runId);
    if (!run || run.status === "building" || run.status === "completed" || run.status === "failed" || run.queueBuildCompletedAt === undefined) return null;
    const now = Date.now();
    // Recover one expired receipt before looking at the semaphore. Without
    // this a crashed set of eight workers could hold the run forever.
    const expired = await ctx.db
      .query("ingestionRunHandleReceipts")
      .withIndex("by_run_status_leaseExpiresAt", (q) =>
        q.eq("runId", args.runId).eq("status", "running").lte("leaseExpiresAt", now),
      )
      .order("asc")
      .first();
    if (expired) {
      if (expired.attemptCount >= MAX_ATTEMPTS) {
        await ctx.db.patch(expired._id, { status: "failed", terminalAt: now, leaseOwner: undefined, leaseExpiresAt: undefined, outcomeDetail: "lease_expired_retry_limit", updatedAt: now });
        await finishRunIfTerminal(ctx, run, now);
      } else {
        await ctx.db.patch(expired._id, { status: "queued", leaseOwner: undefined, leaseExpiresAt: undefined, outcomeDetail: "lease_expired_requeued", updatedAt: now });
      }
      return null;
    }
    const activeReceipts = await ctx.db
      .query("ingestionRunHandleReceipts")
      .withIndex("by_run_status", (q) => q.eq("runId", args.runId).eq("status", "running"))
      .take(run.controls.concurrency + 1);
    if (activeReceipts.length >= run.controls.concurrency) return null;

    let receipt = await ctx.db
      .query("ingestionRunHandleReceipts")
      .withIndex("by_run_status_retryNotBeforeAt", (q) =>
        q.eq("runId", args.runId).eq("status", "queued").lte("retryNotBeforeAt", now),
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
          .withIndex("by_run_status", (q) => q.eq("runId", args.runId).eq("status", "queued"))
          .take(MAX_HANDLES_PER_RUN)
      ).find((candidate) => candidate.retryNotBeforeAt === undefined) ?? null;
    }
    if (!receipt) {
      receipt = await ctx.db
        .query("ingestionRunHandleReceipts")
        .withIndex("by_run_status_leaseExpiresAt", (q) =>
          q.eq("runId", args.runId).eq("status", "running").lte("leaseExpiresAt", now),
        )
        .order("asc")
        .first();
    }
    if (!receipt) return null;
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
  returns: v.any(),
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
    serviceSecret: v.optional(v.string()),
  },
  returns: v.null(),
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
    await ctx.db.patch(receipt._id, {
      providerResultStatus: postCount > 0 ? "persisted" : "no_post",
      persistedPostCount: postCount,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Recover a legacy terminal `deferred` receipt only when its paid result is
 * already present in Convex storage. This is deliberately an operator/service
 * action, not a general retry: it never calls Apify and cannot reopen a
 * receipt unless it has crossed the saved-post boundary.
 */
export const reopenDeferredReceiptFromSavedPost = mutation({
  args: {
    runId: v.id("ingestionRuns"),
    receiptId: v.id("ingestionRunHandleReceipts"),
    serviceSecret: v.optional(v.string()),
  },
  returns: v.object({ reopened: v.boolean(), postCount: v.number() }),
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const [run, receipt] = await Promise.all([ctx.db.get(args.runId), ctx.db.get(args.receiptId)]);
    if (!run || !receipt || receipt.runId !== args.runId) {
      throw new Error("Receipt does not belong to this run.");
    }
    if (receipt.status !== "deferred" || (receipt.providerAttemptCount ?? 0) < 1) {
      throw new Error("Only a paid terminal deferred receipt can be recovered.");
    }
    if (!/saved post processing is (busy|deferred)|openai provider execution lease is busy/i.test(receipt.outcomeDetail ?? "")) {
      throw new Error("Deferred receipt is not eligible for saved-post recovery.");
    }

    // The canary stores at most one post per handle. Bound the lookup even for
    // historic handles and require a post created during this exact run.
    const savedPosts = await ctx.db
      .query("scrapedPosts")
      .withIndex("by_handle", (q) => q.eq("handle", receipt.handle))
      .take(100);
    const persistedPostCount = savedPosts.filter((post) => post.createdAt >= run.createdAt).length;
    if (persistedPostCount === 0) {
      throw new Error("No saved post from this run; refusing recovery without a durable source result.");
    }

    const chunk = await ctx.db.get(receipt.chunkId);
    if (!chunk) throw new Error("Receipt chunk not found.");
    const now = Date.now();
    await ctx.db.patch(receipt._id, {
      status: "queued",
      terminalAt: undefined,
      outcomeDetail: "saved_post_recovery_queued",
      providerResultStatus: "persisted",
      persistedPostCount,
      retryNotBeforeAt: now,
      updatedAt: now,
    });
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
    return { reopened: true, postCount: persistedPostCount };
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
