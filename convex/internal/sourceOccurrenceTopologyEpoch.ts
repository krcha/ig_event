import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export const SOURCE_OCCURRENCE_TOPOLOGY_EPOCH_KEY =
  "source-occurrence-topology-v1" as const;

export type SourceOccurrenceTopologyEpochSnapshot = {
  currentEpoch: number;
  verifiedEpoch: number;
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
  if (row.verifiedEpoch > row.currentEpoch) {
    throw new Error(
      "Source-occurrence verified topology epoch exceeds the current epoch.",
    );
  }
  return {
    currentEpoch: row.currentEpoch,
    verifiedEpoch: row.verifiedEpoch,
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
 * verified frontier only while induction is already intact; unverified
 * writers leave a gap that later safe writers cannot launder and only a
 * stable full audit may certify.
 */
export async function markSourceOccurrenceTopologyMutation(
  ctx: Pick<MutationCtx, "db">,
  options: { verified: boolean },
): Promise<SourceOccurrenceTopologyEpochSnapshot> {
  const existing = await loadSourceOccurrenceTopologyEpochRow(ctx);
  const previous = existing
    ? toSnapshot(existing)
    : { currentEpoch: 0, verifiedEpoch: 0 };
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
  if (existing) {
    await ctx.db.patch(existing._id, {
      currentEpoch,
      verifiedEpoch,
      updatedAt: now,
    });
  } else {
    await ctx.db.insert("sourceOccurrenceTopologyEpoch", {
      key: SOURCE_OCCURRENCE_TOPOLOGY_EPOCH_KEY,
      currentEpoch,
      verifiedEpoch,
      createdAt: now,
      updatedAt: now,
    });
  }
  return { currentEpoch, verifiedEpoch };
}

/**
 * Certifies a full audit only when its dirty baseline stayed stable. Mutations
 * after that baseline are allowed only when every one advanced the verified
 * frontier too. A missing singleton may be initialized only for epoch zero.
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
      createdAt: now,
      updatedAt: now,
    });
    return { currentEpoch: 0, verifiedEpoch: 0 };
  }

  const current = toSnapshot(existing);
  if (current.currentEpoch === options.auditEpoch) {
    if (current.verifiedEpoch !== current.currentEpoch) {
      await ctx.db.patch(existing._id, {
        verifiedEpoch: current.currentEpoch,
        updatedAt: now,
      });
    }
    return {
      currentEpoch: current.currentEpoch,
      verifiedEpoch: current.currentEpoch,
    };
  }
  if (
    current.currentEpoch === current.verifiedEpoch &&
    options.auditEpoch <= current.verifiedEpoch
  ) {
    return current;
  }
  throw new Error(
    "Source-occurrence topology changed without verification during the audit.",
  );
}
