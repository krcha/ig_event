import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  applyFalseCinemaAutomaticApprovalReversalHandler,
  previewFalseCinemaAutomaticApprovalReversalHandler,
} from "./internal/eventRepairs/revertFalseCinemaAutomaticApproval";

const versionFields = {
  id: v.id("events"),
  expectedUpdatedAt: v.number(),
  expectedNormalizedFieldsJson: v.string(),
  expectedSourceLinkId: v.id("instagramEventSources"),
  expectedSourceLinkUpdatedAt: v.number(),
};
const version = v.object(versionFields);

export const preview = query({
  args: { serviceSecret: v.string() },
  returns: v.object({
    sourceIdentity: v.string(),
    sourceId: v.id("scrapedPosts"),
    sourceUpdatedAt: v.number(),
    receiptId: v.id("instagramSourceOccurrenceReceipts"),
    receiptUpdatedAt: v.number(),
    sourceFingerprint: v.string(),
    items: v.array(v.object({
      ...versionFields,
      title: v.string(),
      date: v.string(),
    })),
  }),
  handler: previewFalseCinemaAutomaticApprovalReversalHandler,
});

export const apply = mutation({
  args: {
    sourceId: v.id("scrapedPosts"),
    sourceUpdatedAt: v.number(),
    receiptId: v.id("instagramSourceOccurrenceReceipts"),
    receiptUpdatedAt: v.number(),
    sourceFingerprint: v.string(),
    items: v.array(version),
    serviceSecret: v.string(),
  },
  returns: v.object({
    updatedCount: v.number(),
    updated: v.array(v.object({ id: v.id("events"), updatedAt: v.number() })),
  }),
  handler: applyFalseCinemaAutomaticApprovalReversalHandler,
});
