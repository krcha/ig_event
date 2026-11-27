import type { FunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { upcomingVenueRepairPlan } from "./eventRepairs/upcomingVenueRepairs";
import { approveNamedPendingVenue, type NamedVenuePlan, type NamedVenueResult } from "./eventRepairs/namedPendingVenue";

export const namedVenueResult = v.object({
  outcome: v.union(v.literal("approved"), v.literal("already_applied"), v.literal("stale"), v.literal("held")),
  reason: v.string(),
});
type Exact = { id: Id<"events">; expectedUpdatedAt: number; plan?: NamedVenuePlan };
export const check = internalMutation({
  args: { id: v.id("events"), expectedUpdatedAt: v.number(), plan: v.optional(upcomingVenueRepairPlan) },
  returns: namedVenueResult,
  handler: approveNamedPendingVenue,
});
const checkRef = "internal/namedPendingVenueApproval:check" as unknown as FunctionReference<"mutation", "internal", Exact, NamedVenueResult>;

/** Catch only known policy holds after Convex has rolled back the child transaction. */
export async function recheckNamedVenue(ctx: MutationCtx, args: Exact): Promise<NamedVenueResult> {
  try { return await ctx.runMutation(checkRef, args); }
  catch (error) {
    if (error instanceof ConvexError && error.data && typeof error.data === "object" &&
        typeof error.data.namedVenueHold === "string") return { outcome: "held", reason: error.data.namedVenueHold };
    throw error;
  }
}
