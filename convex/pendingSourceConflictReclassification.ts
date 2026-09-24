import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  previewPendingCinemaSourceConflictReclassificationHandler,
  reclassifyPendingCinemaSourceConflictsHandler,
} from "./internal/eventRepairs/pendingSourceConflictReclassification";

const version = v.object({
  id: v.id("events"),
  expectedUpdatedAt: v.number(),
  expectedNormalizedFieldsJson: v.string(),
  expectedSourceLinkId: v.id("instagramEventSources"),
  expectedSourceLinkUpdatedAt: v.number(),
});

export const preview = query({
  args: {
    sourceIdentity: v.string(),
    eventIds: v.array(v.id("events")),
    serviceSecret: v.string(),
  },
  returns: v.object({
    sourceIdentity: v.string(),
    expectedReceiptId: v.id("instagramSourceOccurrenceReceipts"),
    expectedReceiptUpdatedAt: v.number(),
    expectedSourceFingerprint: v.string(),
    items: v.array(
      v.object({
        id: v.id("events"),
        expectedUpdatedAt: v.number(),
        expectedNormalizedFieldsJson: v.string(),
        expectedSourceLinkId: v.id("instagramEventSources"),
        expectedSourceLinkUpdatedAt: v.number(),
        previousMaterialCount: v.number(),
        nextBenignCount: v.number(),
      }),
    ),
  }),
  handler: previewPendingCinemaSourceConflictReclassificationHandler,
});

export const apply = mutation({
  args: {
    sourceIdentity: v.string(),
    expectedReceiptId: v.id("instagramSourceOccurrenceReceipts"),
    expectedReceiptUpdatedAt: v.number(),
    expectedSourceFingerprint: v.string(),
    items: v.array(version),
    serviceSecret: v.string(),
  },
  returns: v.object({
    updatedCount: v.number(),
    receiptUpdatedAt: v.number(),
    updated: v.array(
      v.object({ id: v.id("events"), updatedAt: v.number() }),
    ),
  }),
  handler: reclassifyPendingCinemaSourceConflictsHandler,
});
