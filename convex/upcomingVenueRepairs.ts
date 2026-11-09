import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { exactJsonValue } from "../lib/events/exact-json-value";
import { requireAdminOrServiceSecret } from "./authz";
import { persistAutomaticUniqueApproval } from "./internal/automaticUniqueApproval";
import {
  AUTOMATIC_UNIQUE_APPROVAL_HOLD_REASONS,
  evaluateAutomaticUniqueApproval,
} from "./internal/automaticUniqueApprovalPreflight";
import {
  persistUpcomingVenueRepair,
  prepareUpcomingVenueRepair,
  upcomingVenueRepairPlan,
} from "./internal/eventRepairs/upcomingVenueRepairs";

export const preview = query({
  args: { id: v.id("events"), expectedUpdatedAt: v.number(), serviceSecret: v.string() },
  returns: v.object({
    plan: upcomingVenueRepairPlan,
    title: v.string(),
    date: v.string(),
    previousVenue: v.string(),
    venue: v.string(),
    instagramHandle: v.string(),
  }),
  handler: async (ctx, args) => {
    const { kind } = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    if (kind !== "service") throw new Error("Venue repair requires service authentication.");
    const { plan, event, nextEvent, venueHandle } = await prepareUpcomingVenueRepair(ctx, args);
    return {
      plan, title: event.title, date: event.date, previousVenue: event.venue,
      venue: nextEvent.venue, instagramHandle: venueHandle,
    };
  },
});

export const apply = mutation({
  args: { plan: upcomingVenueRepairPlan, serviceSecret: v.string() },
  returns: v.object({
    id: v.id("events"),
    updatedAt: v.number(),
    status: v.union(v.literal("pending"), v.literal("approved"), v.literal("rejected")),
    publicationState: v.union(v.literal("publishable"), v.literal("hidden"), v.literal("pending_verification"), v.null()),
    holdReason: v.union(...AUTOMATIC_UNIQUE_APPROVAL_HOLD_REASONS.map((reason) => v.literal(reason)), v.null()),
  }),
  handler: async (ctx, { plan, serviceSecret }) => {
    const { kind, actor } = await requireAdminOrServiceSecret(ctx, serviceSecret);
    if (kind !== "service") throw new Error("Venue repair requires service authentication.");
    const prepared = await prepareUpcomingVenueRepair(ctx, plan);
    if (!exactJsonValue(prepared.plan, plan)) throw new ConvexError("Venue repair evidence changed after preview.");
    let event = await persistUpcomingVenueRepair(ctx, prepared, actor);
    let holdReason = null;
    if (event.status === "pending") {
      const evaluation = await evaluateAutomaticUniqueApproval(ctx, event);
      if (evaluation.approval) {
        event = await persistAutomaticUniqueApproval(ctx, event, evaluation.approval);
        if (event.publicationState !== "publishable") {
          throw new Error("Repaired and approved event did not become public.");
        }
      } else {
        holdReason = evaluation.diagnostic.holdReason;
      }
    }
    return { id: event._id, updatedAt: event.updatedAt, status: event.status, publicationState: event.publicationState ?? null, holdReason };
  },
});
