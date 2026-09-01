import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  assertReconciliationSourceFence,
  upsertReconciliationProvenance,
  type ReconciliationSourceDocument,
} from "../repositories/reconciliationSourceContext";

/** Thin provider-neutral orchestration facade retained for reconciliation. */
export async function assertCurrentSourceFence(
  sourceDocument: ReconciliationSourceDocument,
  occurrence: Doc<"sourceOccurrences">,
  args: { mode: "shadow" | "apply"; processingOwner?: string },
): Promise<void> {
  assertReconciliationSourceFence(sourceDocument, occurrence, args);
}

export async function upsertProvenanceAndReceipt(options: {
  ctx: MutationCtx;
  eventId: Id<"events">;
  occurrence: Doc<"sourceOccurrences">;
  sourceDocument: ReconciliationSourceDocument;
}): Promise<Id<"events">[]> {
  return upsertReconciliationProvenance(options);
}
