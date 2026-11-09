import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { applyApprovedPublicationRepair, previewApprovedPublicationRepair } from "./internal/eventRepairs/approvedPublicationRepairs";

const target = { id: v.id("events"), sourceIdentity: v.optional(v.string()), serviceSecret: v.string() };

export const preview = query({
  args: target,
  returns: v.object({
    id: v.id("events"), title: v.string(), sourceIdentity: v.union(v.string(), v.null()), ready: v.boolean(), reviewDigest: v.string(),
    missing: v.array(v.object({
      key: v.string(), title: v.string(), date: v.string(),
      outcome: v.union(v.literal("attach"), v.literal("expired"), v.literal("missing_source_row"), v.literal("missing_unique_approved_representative")),
      representativeId: v.union(v.id("events"), v.null()), representativeTitle: v.union(v.string(), v.null()),
    })),
  }),
  handler: previewApprovedPublicationRepair,
});

export const apply = mutation({
  args: { ...target, reviewDigest: v.string(), moderationNote: v.string() },
  returns: v.object({ id: v.id("events"), affectedIds: v.array(v.id("events")), attachedCount: v.number(), expiredCount: v.number() }),
  handler: applyApprovedPublicationRepair,
});
