import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export const SOURCE_OCCURRENCE_TOPOLOGY_EPOCH_KEY =
  "source-occurrence-topology-v1" as const;

export type SourceOccurrenceTopologyEpochSnapshot = {
  currentEpoch: number;
  verifiedEpoch: number;
  lastUnverifiedEpoch?: number;
};

type ReadContext = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

function assertValidEpoch(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is invalid.`);
  }
}

function toSnapshot(
  row: Doc<"sourceOccurrenceTopologyEpoch">,
): SourceOccurrenceTopologyEpochSnapshot {
  assertValidEpoch(row.currentEpoch, "Source-occurrence current topology epoch");
  assertValidEpoch(row.verifiedEpoch, "Source-occurrence verified topology epoch");
  const lastUnverifiedEpoch = row.lastUnverifiedEpoch;
  if (lastUnverifiedEpoch !== undefined) {
    assertValidEpoch(
      lastUnverifiedEpoch,
      "Source-occurrence last unverified topology epoch",
    );
  }
  if (row.verifiedEpoch > row.currentEpoch) {
    throw new Error(
      "Source-occurrence verified topology epoch exceeds the current epoch.",
    );
  }
  if (
    lastUnverifiedEpoch !== undefined &&
    lastUnverifiedEpoch > row.currentEpoch
  ) {
    throw new Error(
      "Source-occurrence last unverified topology epoch exceeds the current epoch.",
    );
  }
  return {
    currentEpoch: row.currentEpoch,
    verifiedEpoch: row.verifiedEpoch,
    lastUnverifiedEpoch,
  };
}

async function loadSourceOccurrenceTopologyEpochRow(
  ctx: ReadContext,
): Promise<Doc<"sourceOccurrenceTopologyEpoch"> | null> {
  const rows = await ctx.db
    .query("sourceOccurrenceTopologyEpoch")
    .withIndex("by_key", (q) =>
      q.eq("key", SOURCE_OCCURRENCE_TOPOLOGY_EPOCH_KEY),
    )
    .take(2);
  if (rows.length > 1) {
    throw new Error("Source-occurrence topology epoch singleton is not unique.");
  }
  const row = rows[0] ?? null;
  if (row) toSnapshot(row);
  return row;
}

/** Missing legacy state is returned as null so every coverage gate fails closed. */
export async function readSourceOccurrenceTopologyEpoch(
  ctx: ReadContext,
): Promise<SourceOccurrenceTopologyEpochSnapshot | null> {
  const row = await loadSourceOccurrenceTopologyEpochRow(ctx);
  return row ? toSnapshot(row) : null;
}

/**
 * Marks one committed topology mutation. Proven-safe writers advance the
 * verified frontier only while induction is already intact and must keep
 * every affected materialized publication decision synchronized in the same
 * transaction. Unverified writers leave a gap that later safe writers cannot
 * launder and only a stable full audit may certify.
 */
export async function markSourceOccurrenceTopologyMutation(
  ctx: Pick<MutationCtx, "db">,
  options: { verified: boolean },
): Promise<SourceOccurrenceTopologyEpochSnapshot> {
  const existing = await loadSourceOccurrenceTopologyEpochRow(ctx);
  const previous = existing
    ? toSnapshot(existing)
    : { currentEpoch: 0, verifiedEpoch: 0, lastUnverifiedEpoch: 0 };
  if (previous.currentEpoch === Number.MAX_SAFE_INTEGER) {
    throw new Error("Source-occurrence topology epoch is exhausted.");
  }
  const now = Date.now();
  const currentEpoch = Math.max(now, previous.currentEpoch + 1);
  assertValidEpoch(currentEpoch, "Next source-occurrence topology epoch");
  const verifiedEpoch =
    options.verified && previous.currentEpoch === previous.verifiedEpoch
      ? currentEpoch
      : previous.verifiedEpoch;
  const lastUnverifiedEpoch = options.verified
    ? (previous.lastUnverifiedEpoch ?? previous.currentEpoch)
    : currentEpoch;
  if (existing) {
    await ctx.db.patch(existing._id, {
      currentEpoch,
      verifiedEpoch,
      lastUnverifiedEpoch,
      updatedAt: now,
    });
  } else {
    await ctx.db.insert("sourceOccurrenceTopologyEpoch", {
      key: SOURCE_OCCURRENCE_TOPOLOGY_EPOCH_KEY,
      currentEpoch,
      verifiedEpoch,
      lastUnverifiedEpoch,
      createdAt: now,
      updatedAt: now,
    });
  }
  return { currentEpoch, verifiedEpoch, lastUnverifiedEpoch };
}

/**
 * Certifies a full audit only when its dirty baseline stayed stable. Mutations
 * after that baseline are allowed only when every one advanced the verified
 * frontier too. Certification never erases the monotonic unverified frontier,
 * because only a later publication audit can absorb its visibility effects.
 * A missing singleton may be initialized only for epoch zero.
 */
export async function finalizeSourceOccurrenceTopologyAudit(
  ctx: Pick<MutationCtx, "db">,
  options: { auditEpoch: number },
): Promise<SourceOccurrenceTopologyEpochSnapshot> {
  assertValidEpoch(options.auditEpoch, "Source-occurrence audit topology epoch");
  const existing = await loadSourceOccurrenceTopologyEpochRow(ctx);
  const now = Date.now();
  if (!existing) {
    if (options.auditEpoch !== 0) {
      throw new Error(
        "Source-occurrence topology audit cannot finalize against missing epoch state.",
      );
    }
    await ctx.db.insert("sourceOccurrenceTopologyEpoch", {
      key: SOURCE_OCCURRENCE_TOPOLOGY_EPOCH_KEY,
      currentEpoch: 0,
      verifiedEpoch: 0,
      lastUnverifiedEpoch: 0,
      createdAt: now,
      updatedAt: now,
    });
    return {
      currentEpoch: 0,
      verifiedEpoch: 0,
      lastUnverifiedEpoch: 0,
    };
  }

  const current = toSnapshot(existing);
  const lastUnverifiedEpoch =
    current.lastUnverifiedEpoch ?? current.currentEpoch;
  if (current.currentEpoch === options.auditEpoch) {
    if (
      current.verifiedEpoch !== current.currentEpoch ||
      current.lastUnverifiedEpoch === undefined
    ) {
      await ctx.db.patch(existing._id, {
        verifiedEpoch: current.currentEpoch,
        lastUnverifiedEpoch,
        updatedAt: now,
      });
    }
    return {
      currentEpoch: current.currentEpoch,
      verifiedEpoch: current.currentEpoch,
      lastUnverifiedEpoch,
    };
  }
  if (
    current.currentEpoch === current.verifiedEpoch &&
    options.auditEpoch <= current.verifiedEpoch
  ) {
    if (current.lastUnverifiedEpoch === undefined) {
      await ctx.db.patch(existing._id, {
        lastUnverifiedEpoch,
        updatedAt: now,
      });
    }
    return { ...current, lastUnverifiedEpoch };
  }
  throw new Error(
    "Source-occurrence topology changed without verification during the audit.",
  );
}
