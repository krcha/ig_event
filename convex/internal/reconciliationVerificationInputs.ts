import type { MutationCtx } from "../_generated/server";
import { hasPublicationDependencyWriteSince } from "../publicationCutover";
import { hasSourceDocumentWriteSince } from "../repositories/reconciliationSourceContext";

/**
 * Fences every mutable, indexed input that can change reconciliation policy
 * without advancing the source-occurrence topology epoch. Provenance,
 * receipts, occurrence bindings, and publication grounding are fenced by that
 * epoch; canonical events, source documents, venues, and venue identities are
 * fenced here. `gte` intentionally fails closed on same-millisecond writes.
 */
export async function assertNoReconciliationInputWriteSince(
  ctx: Pick<MutationCtx, "db">,
  startedAt: number,
): Promise<void> {
  if (!Number.isFinite(startedAt) || startedAt < 0) {
    throw new Error("Reconciliation verification input fence is invalid.");
  }
  const [eventWrite, sourceWrite, publicationDependencyWrite] =
    await Promise.all([
      ctx.db
        .query("events")
        .withIndex("by_updatedAt", (q) => q.gte("updatedAt", startedAt))
        .first(),
      hasSourceDocumentWriteSince(ctx, startedAt),
      hasPublicationDependencyWriteSince(ctx, startedAt),
    ]);
  if (eventWrite || sourceWrite || publicationDependencyWrite) {
    throw new Error(
      "Reconciliation verification inputs changed after the run started; restart verification.",
    );
  }
}
