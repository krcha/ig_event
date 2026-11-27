import { v } from "convex/values";

export const apifyPhaseReceipt = v.object({ runId: v.string(), datasetId: v.optional(v.string()) });
export const apifyAcquisitionReceipt = v.object({
  onlyPostsNewerThan: v.string(),
  basic: apifyPhaseReceipt,
  details: v.optional(apifyPhaseReceipt),
});
export const acquisitionIssue = v.object({
  reason: v.union(v.literal("provider_error_row"), v.literal("incomplete_post_details"), v.literal("details_unavailable")),
  postId: v.optional(v.string()),
});
