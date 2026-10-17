import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  foldReviewedPromoterScheduleDuplicateHandler,
  getReviewedPromoterScheduleFoldContextHandler,
} from "./internal/eventRepairs/reviewedPromoterScheduleFold";

const reviewedSourceVersion = v.object({
  sourceLinkId: v.id("instagramEventSources"),
  sourceLinkUpdatedAt: v.number(),
  receiptId: v.id("instagramSourceOccurrenceReceipts"),
  receiptUpdatedAt: v.number(),
  sourceOccurrenceId: v.id("sourceOccurrences"),
  sourceOccurrenceUpdatedAt: v.number(),
});

export const getReviewedPromoterScheduleFoldContext = query({
  args: {
    operationId: v.string(),
    primaryId: v.id("events"),
    duplicateId: v.id("events"),
    targetVenueId: v.id("venues"),
    serviceSecret: v.string(),
  },
  returns: v.any(),
  handler: getReviewedPromoterScheduleFoldContextHandler,
});

export const foldReviewedPromoterScheduleDuplicate = mutation({
  args: {
    operationId: v.string(),
    primaryId: v.id("events"),
    expectedPrimaryUpdatedAt: v.number(),
    expectedPrimaryNormalizedFieldsJson: v.string(),
    primarySource: reviewedSourceVersion,
    duplicateId: v.id("events"),
    expectedDuplicateUpdatedAt: v.number(),
    expectedDuplicateNormalizedFieldsJson: v.string(),
    duplicateSource: reviewedSourceVersion,
    expectedPrimarySourceHandle: v.string(),
    expectedScheduleSourceHandle: v.string(),
    targetVenueId: v.id("venues"),
    expectedTargetVenueUpdatedAt: v.number(),
    expectedTargetVenueHandle: v.string(),
    nextVenue: v.string(),
    programTitle: v.string(),
    nextTitle: v.string(),
    expectedScheduleRow: v.string(),
    expectedScheduleCaptionLine: v.string(),
    nextDescription: v.string(),
    moderationNote: v.string(),
    serviceSecret: v.string(),
  },
  returns: v.object({
    operationId: v.string(),
    primaryId: v.id("events"),
    primaryUpdatedAt: v.number(),
    primaryReceiptUpdatedAt: v.number(),
    duplicateId: v.id("events"),
    duplicateUpdatedAt: v.number(),
    duplicateReceiptUpdatedAt: v.number(),
    movedSaveCount: v.number(),
    dedupedSaveCount: v.number(),
  }),
  handler: foldReviewedPromoterScheduleDuplicateHandler,
});
