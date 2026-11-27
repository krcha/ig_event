import { v } from "convex/values";
import { musicGenre } from "./eventDiscoveryValues";

export const performerRole = v.union(v.literal("live"), v.literal("party"));
export const performerSource = v.object({ url: v.string(), quote: v.string() });
export const performerEvidence = v.object({
  kind: v.union(v.literal("web"), v.literal("editorial")),
  identity: performerSource,
  corroboration: v.optional(performerSource),
  profileUrl: v.optional(v.string()),
  verifiedHandle: v.optional(v.string()),
  role: v.optional(
    v.object({ category: performerRole, source: performerSource }),
  ),
  genres: v.array(
    v.object({
      genre: musicGenre,
      url: v.string(),
      quote: v.string(),
      dominant: v.boolean(),
    }),
  ),
});
export const performerSupport = v.object({
  genre: musicGenre,
  appearances: v.number(),
  dominant: v.number(),
});
export const performerBackfillPhase = v.union(
  v.literal("priority"),
  v.literal("sources"),
  v.literal("calendar"),
  v.literal("reconcile"),
  v.literal("done"),
);
