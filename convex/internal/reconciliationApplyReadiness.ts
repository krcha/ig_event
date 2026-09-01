import type { MutationCtx } from "../_generated/server";
import { assertReconciliationRolloutEnabled } from "./reconciliationRollout";
import type { ReconciliationVerifiedOperationKind } from "./reconciliationRollout";
import { assertReconciliationPrerequisites } from "./reconciliationPrerequisites";

/** Apply-only gate kept separate from planning and verification authority. */
export async function assertReconciliationApplyReady(
  ctx: MutationCtx,
  requiredOperation: ReconciliationVerifiedOperationKind,
): Promise<void> {
  await assertReconciliationPrerequisites(ctx);
  await assertReconciliationRolloutEnabled(ctx, requiredOperation);
}
