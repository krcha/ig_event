import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  consolidateReviewedDrugstoreNovember2026Handler,
  getReviewedDrugstoreNovember2026ContextHandler,
} from "./internal/eventRepairs/reviewedDrugstoreNovember2026Repairs";

/** One frozen source-reviewed incident; callers cannot enroll more events. */
export const getContext = query({
  args: { serviceSecret: v.string() },
  returns: v.any(),
  handler: getReviewedDrugstoreNovember2026ContextHandler,
});

export const consolidate = mutation({
  args: {
    expectedContextSha256: v.string(),
    moderationNote: v.string(),
    serviceSecret: v.string(),
  },
  returns: v.object({
    primaryId: v.id("events"),
    rejectedIds: v.array(v.id("events")),
    primaryUpdatedAt: v.number(),
    movedSaveCount: v.number(),
    dedupedSaveCount: v.number(),
  }),
  handler: consolidateReviewedDrugstoreNovember2026Handler,
});
