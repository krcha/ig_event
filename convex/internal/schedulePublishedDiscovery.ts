import { makeFunctionReference } from "convex/server";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

const processEvent = makeFunctionReference<"mutation", { eventId: Id<"events"> }, null>("eventDiscovery:processPublishedEvent");

export async function schedulePublishedDiscovery(ctx: MutationCtx, eventId: Id<"events">) {
  // Scheduling commits atomically with the publication or withdrawal.
  await ctx.scheduler?.runAfter(0, processEvent, { eventId });
}
