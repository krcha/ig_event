import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  getReviewedVinylTavanSplitContextHandler,
  splitReviewedVinylTavanHandler,
} from "./internal/eventRepairs/reviewedVinylTavanNovember2026Split";

/** One checksum-bound poster review; no caller-selected source or venue. */
export const getContext = query({
  args: { serviceSecret: v.string() },
  returns: v.any(),
  handler: getReviewedVinylTavanSplitContextHandler,
});

export const split = mutation({
  args: { expectedContextSha256: v.string(), moderationNote: v.string(), serviceSecret: v.string() },
  returns: v.object({ vinylEventId: v.id("events"), tavanEventId: v.id("events"), vinylUpdatedAt: v.number() }),
  handler: splitReviewedVinylTavanHandler,
});
