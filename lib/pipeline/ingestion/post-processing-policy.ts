import { extractEventDataFromInstagramPost } from "@/lib/ai/extract-event-data";
import { downloadImage, normalizeToJpeg } from "@/lib/ai/prepare-image-for-openai";
import { classifyApprovalOccurrenceRelation } from "@/lib/events/approval-occurrence-conflict";
import { getConfiguredVenueNameForHandle, normalizeHandle, toSearchableText } from "@/lib/pipeline/venue-normalization";
import type { ExistingEventRecord, PreparedEvent, ProcessIngestionPostDependencies } from "@/lib/pipeline/ingestion/contracts";
import { extractShortcodeFromPostUrl } from "@/lib/pipeline/ingestion/source-documents";
import { normalizeString } from "@/lib/pipeline/ingestion/values";

export const DEFAULT_PROCESS_INGESTION_POST_DEPENDENCIES: ProcessIngestionPostDependencies = {
  downloadImage,
  extractEventDataFromPost: extractEventDataFromInstagramPost,
  normalizeToJpeg,
};

export function classifyExistingApprovedOccurrence(
  existing: ExistingEventRecord,
  candidate: PreparedEvent,
) {
  const existingVenue = toSearchableText(existing.venue);
  const candidateVenue = toSearchableText(candidate.venue);
  const sameVenue =
    Boolean(existingVenue) &&
    Boolean(candidateVenue) &&
    existingVenue === candidateVenue;
  const existingShortcode = extractShortcodeFromPostUrl(existing.instagramPostUrl ?? "");
  const candidateShortcode = extractShortcodeFromPostUrl(candidate.instagramPostUrl ?? "");
  const sameSource =
    (Boolean(existing.instagramPostId) &&
      existing.instagramPostId === candidate.instagramPostId) ||
    (Boolean(existingShortcode) && existingShortcode === candidateShortcode);
  return classifyApprovalOccurrenceRelation({
    candidate,
    existing,
    sameVenue,
    sameSource,
    unknownVenue: !existingVenue || !candidateVenue,
  });
}

export const classifyExistingApprovedOccurrenceForTesting =
  classifyExistingApprovedOccurrence;

export function resolveInstagramSourceExtractionContext(options: {
  sourceHandle: string;
  configuredVenueNamesByHandle: Record<string, string>;
  sourceDisplayNamesByHandle?: Record<string, string>;
  sourceRolesByHandle?: Record<string, "venue" | "promoter" | "unknown">;
}): {
  canonicalVenueName: string | null;
  instagramSourceName: string | null;
  sourceRole: "venue" | "promoter" | "unknown";
} {
  const normalizedSourceHandle = normalizeHandle(options.sourceHandle);
  const sourceRole = options.sourceRolesByHandle?.[normalizedSourceHandle] ?? "unknown";
  const configuredSourceName =
    getConfiguredVenueNameForHandle(
      options.sourceHandle,
      options.configuredVenueNamesByHandle,
    ) || null;
  const observedDisplayName = normalizeString(
    options.sourceDisplayNamesByHandle?.[normalizedSourceHandle],
  );
  return {
    canonicalVenueName: sourceRole === "promoter" ? null : configuredSourceName,
    instagramSourceName: configuredSourceName || observedDisplayName || null,
    sourceRole,
  };
}

export const resolveInstagramSourceExtractionContextForTesting =
  resolveInstagramSourceExtractionContext;
