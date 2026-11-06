import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  consolidateReviewedNovember2026Handler,
  getReviewedNovember2026ContextHandler,
} from "./internal/eventRepairs/reviewedNovember2026Repairs";

const groupKey = v.union(
  v.literal("bife-nov7"),
  v.literal("vrtoglavica-nov6"),
  v.literal("kuko-nov7"),
  v.literal("dksg-nov6"),
  v.literal("bitef-nov6"),
  v.literal("ladidadi-nov6"),
  v.literal("tranzit-nov6"),
);

/** Frozen incident review, never an automatic ingestion or merge policy. */
export const getContext = query({
  args: { groupKey, serviceSecret: v.string() },
  returns: v.any(),
  handler: getReviewedNovember2026ContextHandler,
});

export const consolidate = mutation({
  args: {
    groupKey,
    expectedContextJson: v.string(),
    moderationNote: v.string(),
    serviceSecret: v.string(),
  },
  returns: v.object({
    groupKey,
    primaryId: v.id("events"),
    rejectedIds: v.array(v.id("events")),
    primaryUpdatedAt: v.number(),
    movedSaveCount: v.number(),
    dedupedSaveCount: v.number(),
  }),
  handler: consolidateReviewedNovember2026Handler,
});
