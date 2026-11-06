import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  VENUE_LINKS_NOVEMBER_2026_REVIEWS,
  consolidateReviewedVenueLinksNovember2026Handler,
  getReviewedVenueLinksNovember2026ContextHandler,
} from "./internal/eventRepairs/reviewedVenueLinksNovember2026Repairs";

const groupKey = v.union(...Object.keys(VENUE_LINKS_NOVEMBER_2026_REVIEWS).map((key) => v.literal(key)));

/** Frozen reviewed campaigns; callers cannot enroll events or supply facts. */
export const getContext = query({
  args: { groupKey, serviceSecret: v.string() },
  returns: v.any(),
  handler: getReviewedVenueLinksNovember2026ContextHandler,
});

export const consolidate = mutation({
  args: { groupKey, expectedContextSha256: v.string(), moderationNote: v.string(), serviceSecret: v.string() },
  returns: v.object({
    groupKey, primaryId: v.id("events"), rejectedIds: v.array(v.id("events")), primaryUpdatedAt: v.number(),
    movedSaveCount: v.number(), dedupedSaveCount: v.number(),
  }),
  handler: consolidateReviewedVenueLinksNovember2026Handler,
});
