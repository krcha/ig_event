import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireAdminOrServiceSecret } from "./authz";

const MAX_HANDLES_PER_CHUNK = 500;
const MAX_HANDLES_PER_RUN = 2_000;
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

    // Daily and catch-up must never overlap. The two indexed reads are bounded
    // and make a second paid run an explicit operator decision instead of a
    // hidden double-spend race.
    const active = (await Promise.all(
      (["queued", "running"] as const).map((status) =>
        ctx.db
          .query("ingestionRuns")
          .withIndex("by_status_createdAt", (q) => q.eq("status", status))
          .order("desc")
          .take(2),
      ),
    )).flat();
    if (active.length > 0) {
      const existingDaily = active.length === 1 && active[0].mode === "daily";
      if (args.mode === "daily" && args.resumeDaily === true && existingDaily) {
        return active[0]._id;
      }
      throw new Error("Another durable ingestion run is already active.");
    }

    const now = Date.now();
    const runId = await ctx.db.insert("ingestionRuns", {
      mode: args.mode,
      status: "queued",
      sourceSnapshotKey: args.sourceSnapshotKey.trim(),
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
    for (let start = 0, ordinal = 0; start < handles.length; start += MAX_HANDLES_PER_CHUNK, ordinal += 1) {
      const chunkHandles = handles.slice(start, start + MAX_HANDLES_PER_CHUNK);
      const chunkId = await ctx.db.insert("ingestionRunChunks", {
        runId,
        ordinal,
        handleCount: chunkHandles.length,
        terminalReceiptCount: 0,
        status: "queued",
        createdAt: now,
        updatedAt: now,
      });
      for (const handle of chunkHandles) {
        await ctx.db.insert("ingestionRunHandleReceipts", {
          runId,
          chunkId,
          handle,
        status: "queued",
        attemptCount: 0,
        providerAttemptCount: 0,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    return runId;
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
    return {
      runId: run._id,
      mode: run.mode,
      status: run.status,
      selectedHandleCount: run.selectedHandleCount,
      terminalReceiptCount: run.terminalReceiptCount,
      failedReceiptCount: run.failedReceiptCount,
      inFlightCount: run.inFlightCount,
      controls: run.controls,
      complete: run.terminalReceiptCount === run.selectedHandleCount,
    };
  },
});

export const executeNext = mutation({
  args: { runId: v.id("ingestionRuns"), workerId: v.string(), serviceSecret: v.optional(v.string()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const run = await ctx.db.get(args.runId);
    if (!run || run.status === "completed" || run.status === "failed") return null;
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
        const chunk = await ctx.db.get(expired.chunkId);
        if (!chunk) throw new Error("Expired receipt chunk not found.");
        await ctx.db.patch(expired._id, { status: "failed", terminalAt: now, leaseOwner: undefined, leaseExpiresAt: undefined, outcomeDetail: "lease_expired_retry_limit", updatedAt: now });
        const chunkTerminal = chunk.terminalReceiptCount + 1;
        await ctx.db.patch(chunk._id, { terminalReceiptCount: chunkTerminal, status: chunkTerminal === chunk.handleCount ? "completed" : "running", updatedAt: now });
        const terminalReceiptCount = run.terminalReceiptCount + 1;
        const complete = terminalReceiptCount === run.selectedHandleCount;
        await ctx.db.patch(run._id, { terminalReceiptCount, failedReceiptCount: run.failedReceiptCount + 1, inFlightCount: Math.max(0, run.inFlightCount - 1), status: complete ? "completed" : "running", ...(complete ? { finishedAt: now } : {}), updatedAt: now });
      } else {
        await ctx.db.patch(expired._id, { status: "queued", leaseOwner: undefined, leaseExpiresAt: undefined, outcomeDetail: "lease_expired_requeued", updatedAt: now });
        await ctx.db.patch(run._id, { inFlightCount: Math.max(0, run.inFlightCount - 1), updatedAt: now });
      }
      return null;
    }
    if (run.inFlightCount >= run.controls.concurrency) return null;

    let receipt = await ctx.db
      .query("ingestionRunHandleReceipts")
      .withIndex("by_run_status", (q) => q.eq("runId", args.runId).eq("status", "queued"))
      .order("asc")
      .first();
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
      const chunk = await ctx.db.get(receipt.chunkId);
      if (!chunk) throw new Error("Retry-limited receipt chunk not found.");
      await ctx.db.patch(receipt._id, { status: "failed", terminalAt: now, leaseOwner: undefined, leaseExpiresAt: undefined, outcomeDetail: "retry_limit", updatedAt: now });
      const chunkTerminal = chunk.terminalReceiptCount + 1;
      await ctx.db.patch(chunk._id, { terminalReceiptCount: chunkTerminal, status: chunkTerminal === chunk.handleCount ? "completed" : "running", updatedAt: now });
      const terminalReceiptCount = run.terminalReceiptCount + 1;
      const complete = terminalReceiptCount === run.selectedHandleCount;
      await ctx.db.patch(run._id, { terminalReceiptCount, failedReceiptCount: run.failedReceiptCount + 1, status: complete ? "completed" : "running", ...(complete ? { finishedAt: now } : {}), updatedAt: now });
      return null;
    }
    const wasRunning = receipt.status === "running";
    const reservationNeeded = receipt.reservedMicros === undefined;
    if (
      reservationNeeded &&
      run.chargedMicros + run.reservedMicros + run.controls.costPerProfileMicros > run.controls.budgetMicros
    ) {
      // A selected handle must never remain queued forever due to budget
      // exhaustion. It has not made a provider request, so mark the result
      // explicitly deferred and let the master run finish honestly.
      const terminal = run.terminalReceiptCount + 1;
      const complete = terminal === run.selectedHandleCount;
      const chunk = await ctx.db.get(receipt.chunkId);
      if (!chunk) throw new Error("Receipt chunk not found.");
      const chunkTerminal = chunk.terminalReceiptCount + 1;
      await ctx.db.patch(receipt._id, {
        status: "deferred",
        terminalAt: now,
        outcomeDetail: "budget_exhausted",
        updatedAt: now,
      });
      await ctx.db.patch(chunk._id, {
        terminalReceiptCount: chunkTerminal,
        status: chunkTerminal === chunk.handleCount ? "completed" : "running",
        updatedAt: now,
      });
      await ctx.db.patch(run._id, {
        terminalReceiptCount: terminal,
        status: complete ? "completed" : "running",
        ...(complete ? { finishedAt: now } : {}),
        updatedAt: now,
      });
      return null;
    }
    await ctx.db.patch(receipt._id, { status: "running", leaseOwner: args.workerId, leaseExpiresAt: now + LEASE_MS, attemptCount: receipt.attemptCount + 1, updatedAt: now });
    await ctx.db.patch(run._id, { status: "running", startedAt: run.startedAt ?? now, inFlightCount: run.inFlightCount + (wasRunning ? 0 : 1), reservedMicros: run.reservedMicros + (reservationNeeded ? run.controls.costPerProfileMicros : 0), updatedAt: now });
    if (reservationNeeded) await ctx.db.patch(receipt._id, { reservedMicros: run.controls.costPerProfileMicros });
    return { receiptId: receipt._id, handle: receipt.handle, controls: run.controls };
  },
});

/**
 * Cross the paid-provider boundary atomically. The first outbound attempt
 * consumes the claim-time reservation; retries consume new budget. This makes
 * crash/retry billing conservative and prevents a run from undercounting paid
 * requests while still respecting its immutable budget.
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
    const usesReservation = (receipt.reservedMicros ?? 0) > (receipt.chargedMicros ?? 0);
    // A retry has no unused reservation. Charge it only when spare run budget
    // remains after all other active claims are accounted for.
    if (!usesReservation && run.chargedMicros + run.reservedMicros + cost > run.controls.budgetMicros) {
      return { started: false, reason: "budget_exhausted" };
    }

    const now = Date.now();
    await ctx.db.patch(receipt._id, {
      providerAttemptCount: (receipt.providerAttemptCount ?? 0) + 1,
      chargedMicros: (receipt.chargedMicros ?? 0) + cost,
      updatedAt: now,
    });
    await ctx.db.patch(run._id, {
      reservedMicros: usesReservation ? Math.max(0, run.reservedMicros - cost) : run.reservedMicros,
      chargedMicros: run.chargedMicros + cost,
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
    const chunk = await ctx.db.get(receipt.chunkId);
    if (!chunk) throw new Error("Receipt chunk not found.");
    const terminal = run.terminalReceiptCount + 1;
    const failed = run.failedReceiptCount + (args.outcome === "failed" ? 1 : 0);
    const complete = terminal === run.selectedHandleCount;
    await ctx.db.patch(receipt._id, { status: args.outcome, outcomeDetail: args.detail?.slice(0, 256), terminalAt: now, leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: now });
    const chunkTerminal = chunk.terminalReceiptCount + 1;
    await ctx.db.patch(chunk._id, { terminalReceiptCount: chunkTerminal, status: chunkTerminal === chunk.handleCount ? "completed" : "running", updatedAt: now });
    await ctx.db.patch(run._id, { terminalReceiptCount: terminal, failedReceiptCount: failed, inFlightCount: Math.max(0, run.inFlightCount - 1), status: complete ? "completed" : "running", ...(complete ? { finishedAt: now } : {}), updatedAt: now });
    return { complete, terminalReceiptCount: terminal, selectedHandleCount: run.selectedHandleCount };
  },
});

export const releaseReceiptForRetry = mutation({
  args: { runId: v.id("ingestionRuns"), receiptId: v.id("ingestionRunHandleReceipts"), workerId: v.string(), reason: v.string(), serviceSecret: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const [run, receipt] = await Promise.all([ctx.db.get(args.runId), ctx.db.get(args.receiptId)]);
    if (!run || !receipt || receipt.runId !== args.runId || receipt.status !== "running" || receipt.leaseOwner !== args.workerId) throw new Error("Receipt lease mismatch.");
    const now = Date.now();
    await ctx.db.patch(receipt._id, { status: "queued", leaseOwner: undefined, leaseExpiresAt: undefined, outcomeDetail: args.reason.slice(0, 256), updatedAt: now });
    await ctx.db.patch(run._id, { inFlightCount: Math.max(0, run.inFlightCount - 1), updatedAt: now });
    return null;
  },
});
