import { buildSourceOccurrenceIdentity, hasIncompleteSourceOccurrenceSetForTesting, isCompleteSourceOccurrenceReceipt } from "@/lib/pipeline/source-occurrence-planning";
import { isLowConfidenceVenue } from "@/lib/pipeline/venue-normalization";
import { type InstagramScrapedPost } from "@/lib/scraper/instagram-scraper";
import { normalizeConfidenceScore } from "@/lib/utils/confidence";
import { ConvexHttpClient } from "convex/browser";
import type { DuplicateQualityReason, DuplicateUpdateLogEvent, ExistingEventQuality, ExistingEventRecord, ExistingSourceMatch, HandleSummary, SourceDuplicateSkipDecision } from "@/lib/pipeline/ingestion/contracts";
import { getInstagramSourceOccurrenceReceiptQuery } from "@/lib/pipeline/ingestion/convex-bindings";
import { EXISTING_EVENT_CONFIDENCE_THRESHOLD } from "@/lib/pipeline/ingestion/occurrence-comparison";
import { parsePostedAt } from "@/lib/pipeline/ingestion/source-documents";
import { normalizeString, parseJsonRecord, readJsonBoolean, readJsonNumber, readJsonString } from "@/lib/pipeline/ingestion/values";

export function parseEventYear(date: string | undefined): number | null {
  if (!date) {
    return null;
  }
  const match = date.match(/^(\d{4})-\d{2}-\d{2}$/);
  if (!match) {
    return null;
  }
  return Number.parseInt(match[1], 10);
}

export function mapDuplicateReasonToLogEvent(reason: DuplicateQualityReason): DuplicateUpdateLogEvent {
  if (reason === "wrong_year") return "duplicate_updated_wrong_year";
  if (reason === "bad_venue") return "duplicate_updated_bad_venue";
  if (reason === "low_confidence") return "duplicate_updated_low_confidence";
  return "duplicate_updated_bad_data";
}

export function isLowQualityExistingEvent(
  existing: ExistingEventRecord,
  postTimestamp: string | null,
): ExistingEventQuality {
  const reasons = new Set<DuplicateQualityReason>();
  const normalizedFields = parseJsonRecord(existing.normalizedFieldsJson);
  const postDate = parsePostedAt(postTimestamp ?? existing.sourcePostedAt ?? null);
  const eventYear = parseEventYear(existing.date);
  const explicitYearHighConfidence =
    readJsonString(normalizedFields, "dateYearSelectionReason") === "explicit_year_from_text" &&
    readJsonString(normalizedFields, "dateConfidence") === "high";
  const confidence = normalizeConfidenceScore(readJsonNumber(normalizedFields, "confidence"));

  if (!normalizeString(existing.title) || !normalizeString(existing.date) || !normalizeString(existing.venue) || !normalizeString(existing.eventType)) {
    reasons.add("invalid_required_fields");
  }

  if (readJsonBoolean(normalizedFields, "dateSuspiciousYear")) {
    reasons.add("wrong_year");
  }

  if (postDate && eventYear !== null) {
    const postYear = postDate.getUTCFullYear();
    if (Math.abs(eventYear - postYear) >= 2) {
      reasons.add("wrong_year");
    }
    if (eventYear < postYear && !explicitYearHighConfidence) {
      reasons.add("wrong_year");
    }
  }

  if (
    readJsonString(normalizedFields, "dateReason") !== null ||
    readJsonString(normalizedFields, "normalizedDate") === null ||
    readJsonBoolean(normalizedFields, "normalizedIsValid") === false
  ) {
    reasons.add("invalid_normalized_fields");
  }

  if (isLowConfidenceVenue(existing.venue)) {
    reasons.add("bad_venue");
  }

  const normalizedVenue = existing.venue.toLowerCase().replace(/\s+/g, " ").trim();
  if (normalizedVenue === "unknown venue" || normalizedVenue === "20_44 nightclub") {
    reasons.add("bad_venue");
  }

  if (confidence !== null && confidence < EXISTING_EVENT_CONFIDENCE_THRESHOLD) {
    reasons.add("low_confidence");
  }

  const orderedReasons: DuplicateQualityReason[] = [];
  if (reasons.has("wrong_year")) orderedReasons.push("wrong_year");
  if (reasons.has("bad_venue")) orderedReasons.push("bad_venue");
  if (reasons.has("low_confidence")) orderedReasons.push("low_confidence");
  if (reasons.has("invalid_required_fields")) orderedReasons.push("invalid_required_fields");
  if (reasons.has("invalid_normalized_fields")) orderedReasons.push("invalid_normalized_fields");

  return {
    isLowQuality: orderedReasons.length > 0,
    primaryReason: orderedReasons[0] ?? null,
    reasons: orderedReasons,
    details: {
      postTimestamp: postTimestamp ?? existing.sourcePostedAt ?? null,
      existingDate: existing.date,
      existingVenue: existing.venue,
      existingStatus: existing.status,
      confidence,
      explicitYearHighConfidence,
      normalizedDateReason: readJsonString(normalizedFields, "dateReason"),
      normalizedDate: readJsonString(normalizedFields, "normalizedDate"),
      normalizedInvalidReason: readJsonString(normalizedFields, "normalizedInvalidReason"),
    },
  };
}

export function shouldReprocessExistingSourcePosts(): boolean {
  return normalizeString(process.env.INGESTION_REPROCESS_EXISTING_SOURCE_POSTS).toLowerCase() === "true";
}

export const hasIncompleteSourceOccurrenceSet =
  hasIncompleteSourceOccurrenceSetForTesting;

export async function getCurrentSourceOccurrenceReceiptState(
  client: ConvexHttpClient,
  post: InstagramScrapedPost,
  serviceSecret: string,
): Promise<"absent" | "complete" | "incomplete"> {
  const receipt = await client.query(getInstagramSourceOccurrenceReceiptQuery, {
    sourceIdentity: buildSourceOccurrenceIdentity(post),
    serviceSecret,
  });
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return "absent";
  }
  return isCompleteSourceOccurrenceReceipt(receipt, post) ? "complete" : "incomplete";
}

export function getPreExtractionSourceDuplicateSkipDecision(
  matches: ExistingSourceMatch[],
  post: InstagramScrapedPost,
): SourceDuplicateSkipDecision | null {
  const firstMatch = matches[0];
  if (!firstMatch) {
    return null;
  }

  // A source post that advertised multiple occurrences is only complete when all
  // deterministic child-row identities are already persisted. Re-extract a partial
  // set so retries can recover a sibling that failed after an earlier insert.
  if (hasIncompleteSourceOccurrenceSet(matches, post)) {
    return null;
  }

  if (!shouldReprocessExistingSourcePosts()) {
    return {
      match: firstMatch,
      quality: isLowQualityExistingEvent(firstMatch.existingEvent, post.postedAt),
      reason: "already_processed_source",
    };
  }

  for (const match of matches) {
    const quality = isLowQualityExistingEvent(match.existingEvent, post.postedAt);
    if (!quality.isLowQuality) {
      return {
        match,
        quality,
        reason: "clean_existing_source",
      };
    }
  }

  return null;
}

export function recordSourceDuplicateSkip(
  summary: HandleSummary,
  decision: SourceDuplicateSkipDecision,
): void {
  summary.skippedDuplicates += 1;
  summary.skipped_duplicates += 1;
  if (!decision.quality.isLowQuality) {
    summary.skipped_duplicates_clean += 1;
  }
}
