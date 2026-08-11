import { v } from "convex/values";
import { getBelgradeDayKey } from "../lib/pipeline/belgrade-day-key";
import {
  DEFINITIVE_OUTPUT_RECOVERY_PROTOCOL,
  EVENT_EXTRACTION_ANALYSIS_PROTOCOL,
  LEGACY_EVENT_EXTRACTION_ANALYSIS_PROTOCOL,
  OPENAI_DEFINITIVE_OUTPUT_FAILURE_KINDS,
} from "../lib/ai/openai-analysis-protocol";
import {
  getLegacyDefinitiveOutputRecoveryEntry,
  LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_RECEIPT_IDS,
  LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_SELECTION_SHA256,
  LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_SELECTION_VERSION,
  LEGACY_DEFINITIVE_OUTPUT_RECOVERY_MANIFEST_VERSION,
  type LegacyDefinitiveOutputRecoveryEntry,
} from "./legacyDefinitiveOutputRecoveryAllowlist";
import type { Doc } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";
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
const MAX_LEGACY_DEFINITIVE_OUTPUT_RECOVERY_BATCH_SIZE = 3;
const legacyDefinitiveOutputRecoveryInitialReceiptIds = new Set<string>(
  LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_RECEIPT_IDS,
);
const definitiveOutputFailureKinds = new Set<string>(
  OPENAI_DEFINITIVE_OUTPUT_FAILURE_KINDS,
);

const modeValidator = v.union(v.literal("canary"), v.literal("catch_up"), v.literal("daily"));
const runStatusValidator = v.union(
  v.literal("building"),
  v.literal("queued"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
);
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
const dailyRunAdmissionValidator = v.object({
  runId: v.id("ingestionRuns"),
  runMode: modeValidator,
  runStatus: runStatusValidator,
  currentDayKey: v.string(),
  runDayKey: v.union(v.string(), v.null()),
  currentDayQueued: v.boolean(),
  followUpRequired: v.boolean(),
  executeRequired: v.boolean(),
  selectedHandleCount: v.number(),
  builtCount: v.number(),
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

function isDedicatedLegacyDefinitiveOutputRecoveryReceipt(
  receipt: any,
  post: any,
): boolean {
  const legacyEntry = getLegacyDefinitiveOutputRecoveryEntry(
    String(receipt?._id ?? ""),
  );
  return Boolean(
    legacyEntry &&
      post &&
      legacyEntry.runId === receipt.runId &&
      legacyEntry.savedPostId === receipt.scrapedPostId &&
      legacyEntry.savedPostId === post._id &&
      legacyEntry.sourceRevision === receipt.scrapedPostSourceRevision &&
      legacyEntry.sourceRevision === getScrapedPostSourceRevision(post) &&
      post.analysisDefinitiveOutputRecoveryRevision ===
        legacyEntry.sourceRevision &&
      post.analysisDefinitiveOutputRecoveryFromProtocol ===
        LEGACY_EVENT_EXTRACTION_ANALYSIS_PROTOCOL &&
      post.analysisDefinitiveOutputRecoveryProtocol ===
        DEFINITIVE_OUTPUT_RECOVERY_PROTOCOL &&
      Number.isFinite(post.analysisDefinitiveOutputRecoveredAt),
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
const receiptStatuses = [
  "queued",
  "running",
  "processing_pending",
  "processing",
  ...terminalStatuses,
] as const;

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

async function markReceiptChunkTerminal(
  ctx: { db: any },
  receipt: any,
  now: number,
) {
  const chunk = await ctx.db.get(receipt.chunkId);
  if (!chunk || chunk.runId !== receipt.runId) {
    throw new Error("Processing receipt chunk is missing or foreign.");
  }
  const nextTerminalReceiptCount = Math.min(
    chunk.handleCount,
    chunk.terminalReceiptCount + 1,
  );
  await ctx.db.patch(chunk._id, {
    terminalReceiptCount: nextTerminalReceiptCount,
    status:
      nextTerminalReceiptCount === chunk.handleCount
        ? "completed"
        : "running",
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

const activeRunStatuses = ["building", "queued", "running"] as const;

async function getActiveRuns(ctx: MutationCtx): Promise<Array<Doc<"ingestionRuns">>> {
  return (await Promise.all(
    activeRunStatuses.map((status) =>
      ctx.db
        .query("ingestionRuns")
        .withIndex("by_status_createdAt", (q) => q.eq("status", status))
        .order("desc")
        .take(2),
    ),
  )).flat();
}

async function getDailyRunForDay(
  ctx: MutationCtx,
  dayKey: string,
): Promise<Doc<"ingestionRuns"> | null> {
  const runs = await ctx.db
    .query("ingestionRuns")
    .withIndex("by_mode_dailyDayKey", (q) =>
      q.eq("mode", "daily").eq("dailyDayKey", dayKey),
    )
    .take(2);
  if (runs.length > 1) {
    throw new Error(`More than one daily ingestion run exists for ${dayKey}.`);
  }
  if (runs[0]) return runs[0];

  // Rollout bridge: runs created before dailyDayKey existed can still be the
  // current day's one legitimate daily run. Adopt only a bounded recent row
  // based on its immutable creation time; older completed history stays as-is.
  const recentLegacyRuns = await ctx.db
    .query("ingestionRuns")
    .withIndex("by_mode_createdAt", (q) => q.eq("mode", "daily"))
    .order("desc")
    .take(8);
  const legacyRun = recentLegacyRuns.find(
    (run) => run.dailyDayKey === undefined && getBelgradeDayKey(run.createdAt) === dayKey,
  );
  if (!legacyRun) return null;
  const now = Date.now();
  await ctx.db.patch(legacyRun._id, { dailyDayKey: dayKey, updatedAt: now });
  return { ...legacyRun, dailyDayKey: dayKey, updatedAt: now };
}

async function insertDurableRun(
  ctx: MutationCtx,
  options: {
    mode: RunMode;
    sourceSnapshotKey: string;
    handles: string[];
    controls: ReturnType<typeof controlsFor>;
    createdBy: string;
    dailyDayKey?: string;
  },
) {
  const now = Date.now();
  return ctx.db.insert("ingestionRuns", {
    mode: options.mode,
    status: "building",
    sourceSnapshotKey: options.sourceSnapshotKey,
    ...(options.dailyDayKey ? { dailyDayKey: options.dailyDayKey } : {}),
    selectedHandles: options.handles,
    queueBuildCursor: 0,
    selectedHandleCount: options.handles.length,
    terminalReceiptCount: 0,
    failedReceiptCount: 0,
    inFlightCount: 0,
    reservedMicros: 0,
    chargedMicros: 0,
    controls: options.controls,
    createdBy: options.createdBy,
    createdAt: now,
    updatedAt: now,
  });
}

function dailyAdmission(
  run: Doc<"ingestionRuns">,
  currentDayKey: string,
  currentDayQueued: boolean,
) {
  const executeRequired =
    run.status === "building" || run.status === "queued" || run.status === "running";
  return {
    runId: run._id,
    runMode: run.mode,
    runStatus: run.status,
    currentDayKey,
    runDayKey: run.dailyDayKey ?? null,
    currentDayQueued,
    followUpRequired: !currentDayQueued,
    executeRequired,
    selectedHandleCount: run.selectedHandleCount,
    builtCount: run.queueBuildCursor ?? 0,
  };
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
    const sourceSnapshotKey = args.sourceSnapshotKey.trim();
    if (!sourceSnapshotKey) throw new Error("A frozen source snapshot key is required.");
    const dailyDayKey = args.mode === "daily" ? getBelgradeDayKey() : undefined;

    // Every daily admission path shares this indexed day fence. A retry after
    // completion, an admin request, and the host timer all resolve to the same
    // immutable run for the Europe/Belgrade calendar day.
    if (dailyDayKey) {
      const existingForDay = await getDailyRunForDay(ctx, dailyDayKey);
      if (existingForDay) return existingForDay._id;
    }

    // Building, daily and catch-up runs must never overlap. The indexed reads are bounded
    // and make a second paid run an explicit operator decision instead of a
    // hidden double-spend race.
    const active = await getActiveRuns(ctx);
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
        active[0].sourceSnapshotKey === sourceSnapshotKey &&
        active[0].selectedHandleCount === handles.length;
      const existingEquivalent =
        active.length === 1 &&
        active[0].mode === args.mode &&
        active[0].sourceSnapshotKey === sourceSnapshotKey &&
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

    return insertDurableRun(ctx, {
      mode: args.mode,
      sourceSnapshotKey,
      handles,
      controls,
      createdBy: actor.actor,
      dailyDayKey,
    });
  },
});

/**
 * Persist today's frozen source snapshot before resuming older work. The host
 * launcher calls this again after each returned run; once the active run is
 * terminal, the oldest pending daily snapshot is admitted behind the same
 * global active-run fence used by every other mode.
 */
export const queueDailyRun = mutation({
  args: {
    sourceSnapshotKey: v.string(),
    handles: v.array(v.string()),
    serviceSecret: v.optional(v.string()),
  },
  returns: dailyRunAdmissionValidator,
  handler: async (ctx, args) => {
    const actor = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const currentDayKey = getBelgradeDayKey();
    let dailySnapshot = await ctx.db
      .query("ingestionDailySnapshots")
      .withIndex("by_dayKey", (q) => q.eq("dayKey", currentDayKey))
      .unique();

    if (!dailySnapshot) {
      const handles = uniqueNormalizedHandles(args.handles);
      const controls = controlsFor("daily");
      assertModeScope("daily", handles, controls);
      const sourceSnapshotKey = args.sourceSnapshotKey.trim();
      if (!sourceSnapshotKey) throw new Error("A frozen source snapshot key is required.");
      const now = Date.now();
      const snapshotId = await ctx.db.insert("ingestionDailySnapshots", {
        dayKey: currentDayKey,
        sourceSnapshotKey,
        selectedHandles: handles,
        selectedHandleCount: handles.length,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      });
      dailySnapshot = await ctx.db.get(snapshotId);
      if (!dailySnapshot) throw new Error("Daily source snapshot was not persisted.");
    }

    const [existingForCurrentDay, active] = await Promise.all([
      getDailyRunForDay(ctx, currentDayKey),
      getActiveRuns(ctx),
    ]);
    if (active.length > 1) {
      throw new Error("More than one durable ingestion run is active.");
    }

    if (existingForCurrentDay) {
      if (
        dailySnapshot.status === "assigned" &&
        dailySnapshot.runId !== undefined &&
        dailySnapshot.runId !== existingForCurrentDay._id
      ) {
        throw new Error("Daily source snapshot is assigned to a different run.");
      }
      if (dailySnapshot.status !== "assigned" || dailySnapshot.runId === undefined) {
        const now = Date.now();
        await ctx.db.patch(dailySnapshot._id, {
          status: "assigned",
          runId: existingForCurrentDay._id,
          updatedAt: now,
        });
      }
      return dailyAdmission(existingForCurrentDay, currentDayKey, true);
    }

    if (dailySnapshot.status === "assigned" || dailySnapshot.runId !== undefined) {
      throw new Error("Daily source snapshot references a missing day-owned run.");
    }

    if (active.length === 1) {
      // Do not overlap or replace the prior run. Its controls, receipts, paid
      // attempt boundaries, and provider leases remain the only executable
      // work until it reaches a terminal state.
      return dailyAdmission(active[0], currentDayKey, false);
    }

    const pendingSnapshot = await ctx.db
      .query("ingestionDailySnapshots")
      .withIndex("by_status_dayKey", (q) => q.eq("status", "pending"))
      .order("asc")
      .first();
    if (!pendingSnapshot) {
      throw new Error("No pending daily source snapshot is available for admission.");
    }
    if (pendingSnapshot.selectedHandleCount !== pendingSnapshot.selectedHandles.length) {
      throw new Error("Pending daily source snapshot has inconsistent handle accounting.");
    }

    const existingForPendingDay = await getDailyRunForDay(ctx, pendingSnapshot.dayKey);
    let run = existingForPendingDay;
    if (!run) {
      const controls = controlsFor("daily");
      assertModeScope("daily", pendingSnapshot.selectedHandles, controls);
      const runId = await insertDurableRun(ctx, {
        mode: "daily",
        sourceSnapshotKey: pendingSnapshot.sourceSnapshotKey,
        handles: pendingSnapshot.selectedHandles,
        controls,
        createdBy: actor.actor,
        dailyDayKey: pendingSnapshot.dayKey,
      });
      run = await ctx.db.get(runId);
      if (!run) throw new Error("Daily ingestion run was not persisted.");
    }

    const now = Date.now();
    await ctx.db.patch(pendingSnapshot._id, {
      status: "assigned",
      runId: run._id,
      updatedAt: now,
    });
    return dailyAdmission(run, currentDayKey, pendingSnapshot.dayKey === currentDayKey);
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

/**
 * Authenticated, read-only ledger used to prove a paid canary stayed inside
 * its provider-attempt and token budget. Token totals include only analyses
 * completed after this run was created; older cached analyses remain visible
 * per receipt but are not attributed as new spend.
 */
export const getCanaryAccounting = query({
  args: { runId: v.id("ingestionRuns"), serviceSecret: v.optional(v.string()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const run = await ctx.db.get(args.runId);
    if (!run) return null;
    if (run.mode !== "canary" || run.selectedHandleCount !== 16) {
      throw new Error("Detailed paid-test accounting is restricted to exact 16-profile canaries.");
    }
    const perStatus = await Promise.all(
      receiptStatuses.map((status) =>
        ctx.db
          .query("ingestionRunHandleReceipts")
          .withIndex("by_run_status", (q) => q.eq("runId", run._id).eq("status", status))
          .take(run.selectedHandleCount + 1),
      ),
    );
    const receipts = perStatus.flat();
    if (receipts.length > run.selectedHandleCount) {
      throw new Error("Canary receipt accounting exceeded the frozen selection.");
    }
    const linkedPosts = await Promise.all(
      receipts.map((receipt) =>
        receipt.scrapedPostId ? ctx.db.get(receipt.scrapedPostId) : Promise.resolve(null),
      ),
    );
    const statusCounts = Object.fromEntries(
      receiptStatuses.map((status, index) => [status, perStatus[index].length]),
    );
    let attributedInputTokens = 0;
    let attributedOutputTokens = 0;
    let attributedReasoningTokens = 0;
    let attributedTotalTokens = 0;
    let openAiAttemptsStartedDuringRun = 0;
    let openAiAnalysesCompletedDuringRun = 0;
    const rows = receipts.map((receipt, index) => {
      const post = linkedPosts[index];
      const attemptStartedDuringRun =
        typeof post?.analysisAttemptStartedAt === "number" &&
        post.analysisAttemptStartedAt >= run.createdAt;
      const analysisCompletedDuringRun =
        typeof post?.analysisCompletedAt === "number" &&
        post.analysisCompletedAt >= run.createdAt;
      if (attemptStartedDuringRun) openAiAttemptsStartedDuringRun += 1;
      if (analysisCompletedDuringRun) {
        openAiAnalysesCompletedDuringRun += 1;
        attributedInputTokens += post.analysisInputTokens ?? 0;
        attributedOutputTokens += post.analysisOutputTokens ?? 0;
        attributedReasoningTokens += post.analysisReasoningTokens ?? 0;
        attributedTotalTokens += post.analysisTotalTokens ?? 0;
      }
      return {
        receiptId: receipt._id,
        handle: receipt.handle,
        status: receipt.status,
        providerAttemptCount: receipt.providerAttemptCount ?? 0,
        providerResultStatus: receipt.providerResultStatus ?? null,
        chargedMicros: receipt.chargedMicros ?? 0,
        scrapedPostId: receipt.scrapedPostId ?? null,
        scrapedPostSourceRevision: receipt.scrapedPostSourceRevision ?? null,
        processingOutcome: post?.processingOutcome ?? null,
        analysisModel: post?.analysisModel ?? null,
        analysisAttemptStartedAt: post?.analysisAttemptStartedAt ?? null,
        analysisCompletedAt: post?.analysisCompletedAt ?? null,
        analysisInputTokens: post?.analysisInputTokens ?? null,
        analysisOutputTokens: post?.analysisOutputTokens ?? null,
        analysisReasoningTokens: post?.analysisReasoningTokens ?? null,
        analysisTotalTokens: post?.analysisTotalTokens ?? null,
        attemptStartedDuringRun,
        analysisCompletedDuringRun,
      };
    });
    const providerAttemptCountTotal = receipts.reduce(
      (total, receipt) => total + (receipt.providerAttemptCount ?? 0),
      0,
    );
    return {
      runId: run._id,
      status: run.status,
      selectedHandleCount: run.selectedHandleCount,
      receiptCount: receipts.length,
      statusCounts,
      providerAttemptCountTotal,
      providerAttemptCountMax: receipts.reduce(
        (max, receipt) => Math.max(max, receipt.providerAttemptCount ?? 0),
        0,
      ),
      chargedMicrosTotal: receipts.reduce(
        (total, receipt) => total + (receipt.chargedMicros ?? 0),
        0,
      ),
      openAiAttemptsStartedDuringRun,
      openAiAnalysesCompletedDuringRun,
      attributedInputTokens,
      attributedOutputTokens,
      attributedReasoningTokens,
      attributedTotalTokens,
      rows,
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

    const expiredCandidates = await ctx.db
      .query("ingestionRunHandleReceipts")
      .withIndex("by_run_status_leaseExpiresAt", (q) =>
        q.eq("runId", args.runId).eq("status", "processing").lte("leaseExpiresAt", now),
      )
      .order("asc")
      .take(run.selectedHandleCount + 1);
    let expired = null;
    let expiredPost = null;
    for (const candidate of expiredCandidates) {
      const candidatePost = await getLinkedReceiptScrapedPost(ctx, candidate);
      // Lost acknowledgements on the dedicated exact lane are reconciled only
      // by its manifest-bound claimant. The daily consumer must skip those
      // expired rows and continue so an ordinary expired receipt is not
      // starved behind them.
      if (
        candidatePost &&
        isDedicatedLegacyDefinitiveOutputRecoveryReceipt(candidate, candidatePost)
      ) {
        continue;
      }
      expired = candidate;
      expiredPost = candidatePost;
      break;
    }
    if (expired) {
      await revokeReceiptScrapedPostProcessingLease(
        ctx,
        expired,
        now,
        "processing_receipt_lease_expired",
      );
      const post = expiredPost ?? await getLinkedReceiptScrapedPost(ctx, expired);
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
        await markReceiptChunkTerminal(ctx, expired, now);
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
    const activeCandidates = await ctx.db
      .query("ingestionRunHandleReceipts")
      .withIndex("by_run_status", (q) =>
        q.eq("runId", args.runId).eq("status", "processing"),
      )
      .take(run.selectedHandleCount + 1);
    for (const activeReceipt of activeCandidates) {
      const activePost = await getLinkedReceiptScrapedPost(ctx, activeReceipt);
      const isExpiredDedicatedRecovery =
        (activeReceipt.leaseExpiresAt ?? 0) <= now &&
        activePost &&
        isDedicatedLegacyDefinitiveOutputRecoveryReceipt(
          activeReceipt,
          activePost,
        );
      if (!isExpiredDedicatedRecovery) return null;
    }

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
      // A frozen legacy definitive-output recovery is operator-selected work.
      // Its durable recovery marker, exact allowlist identity, and persisted
      // post link reserve it for the processing-only recovery endpoint below.
      // Ordinary workers must leave it untouched even if outcomeDetail later
      // changes while a recovery retry is being reconciled.
      if (isDedicatedLegacyDefinitiveOutputRecoveryReceipt(candidate, linkedPost)) {
        continue;
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
        if (isDedicatedLegacyDefinitiveOutputRecoveryReceipt(candidate, linkedPost)) {
          continue;
        }
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
        if (
          candidatePost &&
          !isDedicatedLegacyDefinitiveOutputRecoveryReceipt(candidate, candidatePost) &&
          !(await rejectChangedRevision(candidate, candidatePost))
        ) {
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

const legacyDefinitiveOutputRecoveryClaimValidator = v.object({
  claimed: v.boolean(),
  state: v.union(
    v.literal("claimed"),
    v.literal("already_terminal"),
    v.literal("transport_ambiguous"),
  ),
  runId: v.id("ingestionRuns"),
  receiptId: v.id("ingestionRunHandleReceipts"),
  handle: v.string(),
  scrapedPostId: v.id("scrapedPosts"),
  scrapedPostSourceRevision: v.number(),
  processingAttemptCount: v.number(),
  providerAttemptCount: v.number(),
});

function hasUsableCurrentEventEvidence(post: any, sourceRevision: number): boolean {
  if (
    post.analysisRevision !== sourceRevision ||
    post.analysisAttemptRevision !== sourceRevision ||
    post.analysisAttemptProtocol !== EVENT_EXTRACTION_ANALYSIS_PROTOCOL ||
    post.analysisContractVersion !== "event_evidence_v2" ||
    !Number.isFinite(post.analysisCompletedAt) ||
    typeof post.analysisModel !== "string" ||
    typeof post.analysisIsEvent !== "boolean" ||
    !post.analysisResultJson
  ) {
    return false;
  }
  try {
    const parsed = JSON.parse(post.analysisResultJson) as {
      extraction_contract_version?: unknown;
    };
    return Boolean(
      parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        parsed.extraction_contract_version === "event_evidence_v2",
    );
  } catch {
    return false;
  }
}

async function terminalizeDedicatedLegacyRecoveryReceipt(
  ctx: { db: any },
  run: any,
  receipt: any,
  now: number,
  status: "fetched" | "failed",
  detail: string,
) {
  const chunk = await ctx.db.get(receipt.chunkId);
  if (!chunk || chunk.runId !== run._id) {
    throw new Error("Legacy recovery receipt chunk is missing or foreign.");
  }
  await ctx.db.patch(receipt._id, {
    status,
    terminalAt: now,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    retryNotBeforeAt: undefined,
    outcomeDetail: detail.slice(0, 256),
    updatedAt: now,
  });
  await markReceiptChunkTerminal(ctx, receipt, now);
  await finishRunIfTerminal(ctx, run, now);
}

/**
 * Claim only one operator-selected member of a frozen 1-3 receipt batch. The
 * caller supplies receipt IDs only; run, saved-post, and revision identities
 * are derived from the compiled legacy manifest. This mutation cannot enter
 * the Instagram fetch lane and ordinary processing claims explicitly skip the
 * same exact durable recovery marker above.
 */
export const claimLegacyDefinitiveOutputRecoveryReceipt = mutation({
  args: {
    selectedReceiptIds: v.array(v.id("ingestionRunHandleReceipts")),
    receiptId: v.id("ingestionRunHandleReceipts"),
    workerId: v.string(),
    legacyManifestVersion: v.literal(
      LEGACY_DEFINITIVE_OUTPUT_RECOVERY_MANIFEST_VERSION,
    ),
    selectionSha256: v.literal(
      LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_SELECTION_SHA256,
    ),
    selectionVersion: v.literal(
      LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_SELECTION_VERSION,
    ),
    recoveryProtocol: v.literal(DEFINITIVE_OUTPUT_RECOVERY_PROTOCOL),
    serviceSecret: v.optional(v.string()),
  },
  returns: legacyDefinitiveOutputRecoveryClaimValidator,
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const selectedReceiptIds = args.selectedReceiptIds.map(String);
    const uniqueReceiptIds = new Set(selectedReceiptIds);
    if (
      selectedReceiptIds.length < 1 ||
      selectedReceiptIds.length >
        MAX_LEGACY_DEFINITIVE_OUTPUT_RECOVERY_BATCH_SIZE ||
      uniqueReceiptIds.size !== selectedReceiptIds.length ||
      !uniqueReceiptIds.has(String(args.receiptId)) ||
      selectedReceiptIds.some(
        (receiptId) =>
          !legacyDefinitiveOutputRecoveryInitialReceiptIds.has(receiptId),
      )
    ) {
      throw new Error(
        "Legacy recovery requires one to three unique selected receipt IDs including the target.",
      );
    }
    if (
      args.legacyManifestVersion !==
        LEGACY_DEFINITIVE_OUTPUT_RECOVERY_MANIFEST_VERSION ||
      args.selectionSha256 !==
        LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_SELECTION_SHA256 ||
      args.selectionVersion !==
        LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_SELECTION_VERSION ||
      args.recoveryProtocol !== DEFINITIVE_OUTPUT_RECOVERY_PROTOCOL
    ) {
      throw new Error("Legacy recovery protocol or manifest fence mismatch.");
    }

    const selectedEntries: LegacyDefinitiveOutputRecoveryEntry[] = [];
    for (const receiptId of selectedReceiptIds) {
      const entry = getLegacyDefinitiveOutputRecoveryEntry(receiptId);
      if (!entry) {
        throw new Error("Legacy recovery selection is not in the frozen allowlist.");
      }
      selectedEntries.push(entry);
    }
    const targetEntry = getLegacyDefinitiveOutputRecoveryEntry(args.receiptId);
    if (
      !targetEntry ||
      selectedEntries.some((entry) => entry.runId !== targetEntry.runId)
    ) {
      throw new Error("Legacy recovery selection must belong to one frozen run.");
    }

    const selectedReceipts = await Promise.all(
      args.selectedReceiptIds.map((receiptId) => ctx.db.get(receiptId)),
    );
    const selectedPosts = await Promise.all(
      selectedReceipts.map((receipt) =>
        receipt?.scrapedPostId
          ? ctx.db.get(receipt.scrapedPostId)
          : Promise.resolve(null),
      ),
    );
    for (let index = 0; index < selectedEntries.length; index += 1) {
      const entry = selectedEntries[index];
      const receipt = selectedReceipts[index];
      const post = selectedPosts[index];
      if (
        !receipt ||
        !post ||
        entry.receiptId !== receipt._id ||
        entry.runId !== receipt.runId ||
        entry.savedPostId !== receipt.scrapedPostId ||
        entry.savedPostId !== post._id ||
        receipt.handle !== post.handle ||
        entry.sourceRevision !== receipt.scrapedPostSourceRevision ||
        entry.sourceRevision !== getScrapedPostSourceRevision(post) ||
        receipt.providerAttemptCount !== 1 ||
        receipt.providerResultStatus !== "persisted" ||
        receipt.persistedPostCount !== 1 ||
        !isDedicatedLegacyDefinitiveOutputRecoveryReceipt(receipt, post)
      ) {
        throw new Error(
          "Legacy recovery selection no longer matches its exact persisted recovery fence.",
        );
      }
    }

    const targetIndex = selectedEntries.findIndex(
      (entry) => entry.receiptId === String(args.receiptId),
    );
    const receipt = selectedReceipts[targetIndex];
    const savedPost = selectedPosts[targetIndex];
    if (!receipt || !savedPost) {
      throw new Error("Legacy recovery target disappeared during validation.");
    }
    const run = await ctx.db.get(receipt.runId);
    if (!run || String(run._id) !== targetEntry.runId) {
      throw new Error("Legacy recovery run identity mismatch.");
    }
    const now = Date.now();
    if (
      selectedReceipts.some(
        (selectedReceipt, index) =>
          (selectedReceipt?.leaseExpiresAt ?? 0) > now ||
          (selectedPosts[index]?.processingLeaseExpiresAt ?? 0) > now,
      )
    ) {
      throw new Error(
        "Legacy recovery refuses an active lease anywhere in the selected batch.",
      );
    }
    const targetReceiptLeaseActive = (receipt.leaseExpiresAt ?? 0) > now;
    const targetPostLeaseActive =
      (savedPost.processingLeaseExpiresAt ?? 0) > now;
    if (targetReceiptLeaseActive || targetPostLeaseActive) {
      throw new Error("Legacy recovery refuses an active receipt or saved-post lease.");
    }
    if (!args.workerId.trim()) {
      throw new Error("Legacy recovery worker identity is required.");
    }

    const terminalReceipt = terminalStatuses.includes(
      receipt.status as (typeof terminalStatuses)[number],
    );
    if (terminalReceipt) {
      const isKnownAmbiguousRecoveryTerminal =
        receipt.status === "failed" &&
        receipt.outcomeDetail ===
          `saved_post:${savedPost._id};openai_transport_ambiguous` &&
        savedPost.processingStatus === "retryable_failure" &&
        savedPost.processingOutcome === "openai_transport_ambiguous" &&
        savedPost.analysisAttemptRevision === targetEntry.sourceRevision &&
        !hasUsableCurrentEventEvidence(savedPost, targetEntry.sourceRevision);
      if (!isTerminalScrapedPost(savedPost) && !isKnownAmbiguousRecoveryTerminal) {
        throw new Error(
          "Legacy recovery terminal receipt does not have a terminal saved post.",
        );
      }
      return {
        claimed: false,
        state: isKnownAmbiguousRecoveryTerminal
          ? ("transport_ambiguous" as const)
          : ("already_terminal" as const),
        runId: run._id,
        receiptId: receipt._id,
        handle: receipt.handle,
        scrapedPostId: savedPost._id,
        scrapedPostSourceRevision: targetEntry.sourceRevision,
        processingAttemptCount: receipt.processingAttemptCount ?? 0,
        providerAttemptCount: receipt.providerAttemptCount ?? 0,
      };
    }
    if (run.status === "building" || run.status === "completed" || run.status === "failed") {
      throw new Error("Legacy recovery run is not in a processable state.");
    }
    if (receipt.status !== "processing_pending" && receipt.status !== "processing") {
      throw new Error("Legacy recovery target is not in the processing-only lane.");
    }
    if (
      receipt.status !== "processing" &&
      (receipt.leaseOwner !== undefined || receipt.leaseExpiresAt !== undefined)
    ) {
      throw new Error("Legacy recovery target has an uncleared receipt lease.");
    }

    if (isTerminalScrapedPost(savedPost)) {
      const status =
        savedPost.processingOutcome === "terminal_permanent_failure"
          ? ("failed" as const)
          : ("fetched" as const);
      await terminalizeDedicatedLegacyRecoveryReceipt(
        ctx,
        run,
        receipt,
        now,
        status,
        `saved_post:${savedPost._id};${savedPost.processingOutcome}`,
      );
      return {
        claimed: false,
        state: "already_terminal" as const,
        runId: run._id,
        receiptId: receipt._id,
        handle: receipt.handle,
        scrapedPostId: savedPost._id,
        scrapedPostSourceRevision: targetEntry.sourceRevision,
        processingAttemptCount: receipt.processingAttemptCount ?? 0,
        providerAttemptCount: receipt.providerAttemptCount ?? 0,
      };
    }

    const hasCurrentAnalysis = hasUsableCurrentEventEvidence(
      savedPost,
      targetEntry.sourceRevision,
    );
    const hasUnresolvedTransportAttempt =
      savedPost.analysisAttemptRevision === targetEntry.sourceRevision &&
      !hasCurrentAnalysis;
    if (hasUnresolvedTransportAttempt) {
      if (
        savedPost.processingLeaseOwner !== undefined &&
        targetPostLeaseActive
      ) {
        throw new Error("Legacy recovery refuses an active saved-post lease.");
      }
      await ctx.db.patch(savedPost._id, {
        processingStatus: "retryable_failure",
        blocksPaidFetch: false,
        processingOutcome: "openai_transport_ambiguous",
        processingError:
          "A recovery OpenAI transport may have started; replay remains blocked.",
        processingLeaseOwner: undefined,
        processingLeaseExpiresAt: undefined,
        processingRetryAt: undefined,
        lastProcessedAt: now,
        updatedAt: now,
      });
      await terminalizeDedicatedLegacyRecoveryReceipt(
        ctx,
        run,
        receipt,
        now,
        "failed",
        `saved_post:${savedPost._id};openai_transport_ambiguous`,
      );
      return {
        claimed: false,
        state: "transport_ambiguous" as const,
        runId: run._id,
        receiptId: receipt._id,
        handle: receipt.handle,
        scrapedPostId: savedPost._id,
        scrapedPostSourceRevision: targetEntry.sourceRevision,
        processingAttemptCount: receipt.processingAttemptCount ?? 0,
        providerAttemptCount: receipt.providerAttemptCount ?? 0,
      };
    }
    if (
      !hasCurrentAnalysis &&
      (savedPost.analysisAttemptRevision !== undefined ||
        savedPost.analysisRevision !== undefined)
    ) {
      throw new Error("Legacy recovery analysis generation has drifted.");
    }

    const [providerLease, activeProcessingReceipts] = await Promise.all([
      ctx.db
        .query("ingestionProviderLeases")
        .withIndex("by_provider", (q) => q.eq("provider", "openai"))
        .unique(),
      ctx.db
        .query("ingestionRunHandleReceipts")
        .withIndex("by_run_status", (q) =>
          q.eq("runId", run._id).eq("status", "processing"),
        )
        .take(2),
    ]);
    if ((providerLease?.leaseExpiresAt ?? 0) > now) {
      throw new Error("Legacy recovery refuses an active OpenAI provider lease.");
    }
    if (
      activeProcessingReceipts.some(
        (activeReceipt) => activeReceipt._id !== receipt._id,
      )
    ) {
      throw new Error("Legacy recovery refuses an unrelated processing receipt.");
    }
    if (
      savedPost.processingStatus === "processing" &&
      (savedPost.processingLeaseExpiresAt ?? 0) > now
    ) {
      throw new Error("Legacy recovery refuses an active saved-post lease.");
    }
    if (
      savedPost.processingStatus !== "pending" &&
      savedPost.processingStatus !== "retryable_failure" &&
      savedPost.processingStatus !== "processing"
    ) {
      throw new Error("Legacy recovery saved post is not processable.");
    }

    // An expired exact-lane owner can be reconciled safely. A current analysis
    // will be reused without transport; no attempt marker means the previous
    // request died before OpenAI. The ambiguous case was terminalized above.
    await ctx.db.patch(savedPost._id, {
      processingStatus: "pending",
      blocksPaidFetch: true,
      processingOutcome: hasCurrentAnalysis
        ? "definitive_output_recovery_materialization_resume"
        : "definitive_output_requeued",
      processingError: undefined,
      processingLeaseOwner: undefined,
      processingLeaseExpiresAt: undefined,
      processingRetryAt: undefined,
      lastProcessedAt: now,
      updatedAt: now,
    });
    const processingAttemptCount = (receipt.processingAttemptCount ?? 0) + 1;
    await ctx.db.patch(receipt._id, {
      status: "processing",
      processingAttemptCount,
      leaseOwner: args.workerId.slice(0, 200),
      leaseExpiresAt: now + LEASE_MS,
      retryNotBeforeAt: undefined,
      outcomeDetail: "legacy_definitive_output_recovery_claimed",
      updatedAt: now,
    });
    return {
      claimed: true,
      state: "claimed" as const,
      runId: run._id,
      receiptId: receipt._id,
      handle: receipt.handle,
      scrapedPostId: savedPost._id,
      scrapedPostSourceRevision: targetEntry.sourceRevision,
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
      await markReceiptChunkTerminal(ctx, receipt, now);
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
    await markReceiptChunkTerminal(ctx, receipt, now);
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

const definitiveOutputRequeueResultValidator = v.object({
  requeued: v.boolean(),
  reason: v.union(v.literal("requeued"), v.literal("already_requeued")),
});

/**
 * Reopen one definitively invalid extraction response without re-entering the
 * paid Instagram-fetch lane. Eligibility is based on the current protocol's
 * durable output-failure attestation, never on free-form error text.
 */
export const requeueDefinitiveOutputFailure = mutation({
  args: {
    runId: v.id("ingestionRuns"),
    receiptId: v.id("ingestionRunHandleReceipts"),
    scrapedPostId: v.id("scrapedPosts"),
    expectedSourceRevision: v.number(),
    failedAttemptProtocol: v.union(
      v.literal(EVENT_EXTRACTION_ANALYSIS_PROTOCOL),
      v.literal(LEGACY_EVENT_EXTRACTION_ANALYSIS_PROTOCOL),
    ),
    recoveryProtocol: v.literal(DEFINITIVE_OUTPUT_RECOVERY_PROTOCOL),
    legacyManifestVersion: v.optional(
      v.literal(LEGACY_DEFINITIVE_OUTPUT_RECOVERY_MANIFEST_VERSION),
    ),
    serviceSecret: v.optional(v.string()),
  },
  returns: definitiveOutputRequeueResultValidator,
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const isLegacyRecovery =
      args.failedAttemptProtocol === LEGACY_EVENT_EXTRACTION_ANALYSIS_PROTOCOL;
    let legacyEntry: LegacyDefinitiveOutputRecoveryEntry | null = null;
    if (
      args.recoveryProtocol !== DEFINITIVE_OUTPUT_RECOVERY_PROTOCOL
    ) {
      throw new Error("Definitive-output recovery protocol fence mismatch.");
    }
    if (isLegacyRecovery) {
      if (
        args.legacyManifestVersion !==
        LEGACY_DEFINITIVE_OUTPUT_RECOVERY_MANIFEST_VERSION
      ) {
        throw new Error(
          "Legacy definitive-output recovery manifest version mismatch.",
        );
      }
      legacyEntry = getLegacyDefinitiveOutputRecoveryEntry(args.receiptId);
      if (
        !legacyEntry ||
        legacyEntry.runId !== args.runId ||
        legacyEntry.savedPostId !== args.scrapedPostId ||
        legacyEntry.sourceRevision !== args.expectedSourceRevision
      ) {
        throw new Error(
          "Legacy definitive-output recovery target is not in the frozen allowlist.",
        );
      }
    } else {
      if (args.failedAttemptProtocol !== EVENT_EXTRACTION_ANALYSIS_PROTOCOL) {
        throw new Error("Definitive-output recovery protocol fence mismatch.");
      }
      if (args.legacyManifestVersion !== undefined) {
        throw new Error(
          "Current definitive-output recovery refuses a legacy manifest version.",
        );
      }
    }
    const [run, receipt, savedPost] = await Promise.all([
      ctx.db.get(args.runId),
      ctx.db.get(args.receiptId),
      ctx.db.get(args.scrapedPostId),
    ]);
    if (!run || !receipt || receipt.runId !== args.runId) {
      throw new Error("Definitive-output recovery receipt does not belong to this run.");
    }
    if (
      !savedPost ||
      receipt.scrapedPostId !== savedPost._id ||
      savedPost.handle !== receipt.handle
    ) {
      throw new Error("Definitive-output recovery requires the exact linked saved post.");
    }
    if (
      !Number.isSafeInteger(args.expectedSourceRevision) ||
      args.expectedSourceRevision < 1 ||
      receipt.scrapedPostSourceRevision !== args.expectedSourceRevision ||
      (savedPost.sourceRevision ?? 1) !== args.expectedSourceRevision
    ) {
      throw new Error("Definitive-output recovery source revision has drifted.");
    }
    if (
      receipt.providerResultStatus !== "persisted" ||
      receipt.providerAttemptCount !== 1 ||
      receipt.persistedPostCount !== 1
    ) {
      throw new Error(
        "Definitive-output recovery requires exactly one persisted paid-fetch result.",
      );
    }

    const alreadyRequeued =
      savedPost.analysisDefinitiveOutputRecoveryRevision ===
        args.expectedSourceRevision &&
      savedPost.analysisDefinitiveOutputRecoveryFromProtocol ===
        args.failedAttemptProtocol &&
      savedPost.analysisDefinitiveOutputRecoveryProtocol === args.recoveryProtocol;
    if (alreadyRequeued) {
      return { requeued: false, reason: "already_requeued" as const };
    }

    const now = Date.now();
    if (run.status === "building") {
      throw new Error("This durable run cannot accept definitive-output recovery.");
    }
    if (receipt.status !== "failed") {
      throw new Error("Only a failed durable receipt can be requeued by this recovery.");
    }
    if (
      receipt.leaseOwner !== undefined ||
      (receipt.leaseExpiresAt ?? 0) > now ||
      savedPost.processingLeaseOwner !== undefined ||
      (savedPost.processingLeaseExpiresAt ?? 0) > now
    ) {
      throw new Error("Definitive-output recovery refuses an active or uncleared lease.");
    }
    if (
      savedPost.processingStatus !== "completed" ||
      savedPost.processingOutcome !== "terminal_permanent_failure"
    ) {
      throw new Error("Saved post is not a terminal permanent extraction failure.");
    }
    if (
      savedPost.analysisRevision !== undefined ||
      Boolean(savedPost.analysisResultJson)
    ) {
      throw new Error("Definitive-output recovery refuses a post with current analysis.");
    }
    if (legacyEntry) {
      const hasCompletedAnalysis =
        savedPost.analysisRevision !== undefined ||
        savedPost.analysisResultJson !== undefined ||
        savedPost.analysisCompletedAt !== undefined ||
        savedPost.analysisModel !== undefined ||
        savedPost.analysisContractVersion !== undefined ||
        savedPost.analysisIsEvent !== undefined ||
        savedPost.analysisNonEventReason !== undefined ||
        savedPost.analysisInputTokens !== undefined ||
        savedPost.analysisOutputTokens !== undefined ||
        savedPost.analysisReasoningTokens !== undefined ||
        savedPost.analysisTotalTokens !== undefined;
      const hasPriorDefinitiveAttestation =
        savedPost.analysisDefinitiveOutputFailureRevision !== undefined ||
        savedPost.analysisDefinitiveOutputFailureProtocol !== undefined ||
        savedPost.analysisDefinitiveOutputFailureAttemptStartedAt !== undefined ||
        savedPost.analysisDefinitiveOutputFailureOwner !== undefined ||
        savedPost.analysisDefinitiveOutputFailureKind !== undefined ||
        savedPost.analysisDefinitiveOutputFailureMessage !== undefined ||
        savedPost.analysisDefinitiveOutputFailureAt !== undefined ||
        savedPost.analysisDefinitiveOutputFailureModel !== undefined ||
        savedPost.analysisDefinitiveOutputFailureInputTokens !== undefined ||
        savedPost.analysisDefinitiveOutputFailureOutputTokens !== undefined ||
        savedPost.analysisDefinitiveOutputFailureReasoningTokens !== undefined ||
        savedPost.analysisDefinitiveOutputFailureTotalTokens !== undefined ||
        savedPost.analysisDefinitiveOutputRecoveryRevision !== undefined ||
        savedPost.analysisDefinitiveOutputRecoveryFromProtocol !== undefined ||
        savedPost.analysisDefinitiveOutputRecoveryProtocol !== undefined ||
        savedPost.analysisDefinitiveOutputRecoveredAt !== undefined;
      if (
        savedPost.updatedAt !== legacyEntry.sourceUpdatedAt ||
        receipt.updatedAt !== legacyEntry.receiptUpdatedAt ||
        savedPost.analysisAttemptRevision !== legacyEntry.sourceRevision ||
        savedPost.analysisAttemptProtocol !==
          LEGACY_EVENT_EXTRACTION_ANALYSIS_PROTOCOL ||
        savedPost.analysisAttemptStartedAt !==
          legacyEntry.analysisAttemptStartedAt ||
        !savedPost.analysisAttemptOwner ||
        receipt.terminalAt !== legacyEntry.receiptTerminalAt ||
        legacyEntry.failureAt < legacyEntry.analysisAttemptStartedAt ||
        legacyEntry.failureAt > legacyEntry.receiptTerminalAt ||
        receipt.outcomeDetail !==
          `saved_post:${legacyEntry.savedPostId};terminal_permanent_failure` ||
        savedPost.blocksPaidFetch !== false ||
        receipt.leaseExpiresAt !== undefined ||
        savedPost.processingLeaseExpiresAt !== undefined ||
        hasCompletedAnalysis ||
        hasPriorDefinitiveAttestation ||
        !savedPost.processingError
      ) {
        throw new Error(
          "Legacy definitive-output recovery current state has drifted from the frozen manifest.",
        );
      }
    } else {
      if (
        savedPost.analysisAttemptRevision !== args.expectedSourceRevision ||
        savedPost.analysisAttemptProtocol !== args.failedAttemptProtocol ||
        !savedPost.analysisAttemptOwner ||
        savedPost.analysisDefinitiveOutputFailureRevision !==
          args.expectedSourceRevision ||
        savedPost.analysisDefinitiveOutputFailureProtocol !==
          args.failedAttemptProtocol ||
        savedPost.analysisDefinitiveOutputFailureAttemptStartedAt !==
          savedPost.analysisAttemptStartedAt ||
        savedPost.analysisDefinitiveOutputFailureOwner !==
          savedPost.analysisAttemptOwner ||
        !definitiveOutputFailureKinds.has(
          savedPost.analysisDefinitiveOutputFailureKind ?? "",
        ) ||
        !savedPost.analysisDefinitiveOutputFailureAt ||
        !savedPost.analysisDefinitiveOutputFailureModel
      ) {
        throw new Error(
          "Saved post does not carry an exact definitive-output failure attestation.",
        );
      }
    }

    if (run.status === "completed" || run.status === "failed") {
      const perStatusReceipts = await Promise.all(
        receiptStatuses.map((status) =>
          ctx.db
            .query("ingestionRunHandleReceipts")
            .withIndex("by_run_status", (q) =>
              q.eq("runId", run._id).eq("status", status),
            )
            .take(run.selectedHandleCount + 1),
        ),
      );
      const allRunReceipts = perStatusReceipts.flat();
      if (allRunReceipts.length !== run.selectedHandleCount) {
        throw new Error(
          "Terminal-run recovery requires complete frozen receipt accounting.",
        );
      }
      const nonTerminalReceipts = allRunReceipts.filter(
        (candidate) =>
          !terminalStatuses.includes(
            candidate.status as (typeof terminalStatuses)[number],
          ),
      );
      const nonTerminalPosts = await Promise.all(
        nonTerminalReceipts.map((candidate) =>
          candidate.scrapedPostId
            ? ctx.db.get(candidate.scrapedPostId)
            : Promise.resolve(null),
        ),
      );
      if (
        nonTerminalReceipts.some(
          (candidate, index) =>
            candidate.providerAttemptCount !== 1 ||
            candidate.providerResultStatus !== "persisted" ||
            candidate.persistedPostCount !== 1 ||
            !candidate.scrapedPostId ||
            candidate.scrapedPostSourceRevision === undefined ||
            (candidate.leaseExpiresAt ?? 0) > now ||
            !nonTerminalPosts[index] ||
            nonTerminalPosts[index]?.handle !== candidate.handle ||
            (nonTerminalPosts[index]?.sourceRevision ?? 1) !==
              candidate.scrapedPostSourceRevision,
        )
      ) {
        throw new Error(
          "Terminal-run recovery refuses any nonterminal receipt that could re-enter paid fetch.",
        );
      }
    }

    if (run.status === "completed" || run.status === "failed") {
      const otherActiveRuns = (await Promise.all(
        activeRunStatuses.map((status) =>
          ctx.db
            .query("ingestionRuns")
            .withIndex("by_status_createdAt", (q) => q.eq("status", status))
            .order("desc")
            .take(2),
        ),
      ))
        .flat()
        .filter((activeRun) => activeRun._id !== run._id);
      if (otherActiveRuns.length > 0) {
        throw new Error(
          "Another durable ingestion run is active; completed-run recovery cannot overlap it.",
        );
      }
    }

    const chunk = await ctx.db.get(receipt.chunkId);
    if (!chunk || chunk.runId !== run._id) {
      throw new Error("Definitive-output recovery receipt chunk is missing or foreign.");
    }
    const legacyFailureAttestation = legacyEntry
      ? {
          analysisDefinitiveOutputFailureRevision: legacyEntry.sourceRevision,
          analysisDefinitiveOutputFailureProtocol:
            LEGACY_EVENT_EXTRACTION_ANALYSIS_PROTOCOL,
          analysisDefinitiveOutputFailureAttemptStartedAt:
            legacyEntry.analysisAttemptStartedAt,
          analysisDefinitiveOutputFailureOwner: savedPost.analysisAttemptOwner,
          analysisDefinitiveOutputFailureKind: legacyEntry.failureKind,
          analysisDefinitiveOutputFailureMessage: savedPost.processingError,
          analysisDefinitiveOutputFailureAt: legacyEntry.failureAt,
        }
      : {};
    await ctx.db.patch(savedPost._id, {
      ...legacyFailureAttestation,
      processingStatus: "pending",
      blocksPaidFetch: true,
      processingOutcome: "definitive_output_requeued",
      processingError: undefined,
      processingLeaseOwner: undefined,
      processingLeaseExpiresAt: undefined,
      processingRetryAt: undefined,
      analysisAttemptRevision: undefined,
      analysisAttemptStartedAt: undefined,
      analysisAttemptOwner: undefined,
      analysisAttemptProtocol: undefined,
      analysisAttemptBudgetDayKey: undefined,
      analysisDefinitiveOutputRecoveryRevision: args.expectedSourceRevision,
      analysisDefinitiveOutputRecoveryFromProtocol: args.failedAttemptProtocol,
      analysisDefinitiveOutputRecoveryProtocol: args.recoveryProtocol,
      analysisDefinitiveOutputRecoveredAt: now,
      lastProcessedAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(receipt._id, {
      status: "processing_pending",
      terminalAt: undefined,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      retryNotBeforeAt: now,
      outcomeDetail: "saved_post_definitive_output_requeued",
      updatedAt: now,
    });
    await ctx.db.patch(chunk._id, {
      terminalReceiptCount: Math.max(0, chunk.terminalReceiptCount - 1),
      status: "running",
      updatedAt: now,
    });
    const countsAfterRequeue = await terminalCountsForRun(
      ctx,
      run._id,
      run.selectedHandleCount,
    );
    await ctx.db.patch(run._id, {
      status:
        run.status === "completed" || run.status === "failed"
          ? "queued"
          : run.status,
      terminalReceiptCount: countsAfterRequeue.terminalReceiptCount,
      failedReceiptCount: countsAfterRequeue.failedReceiptCount,
      finishedAt: undefined,
      updatedAt: now,
    });
    return { requeued: true, reason: "requeued" as const };
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
