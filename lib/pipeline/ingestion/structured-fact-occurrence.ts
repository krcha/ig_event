import { getStructuredFactsOccurrenceTime } from "@/lib/domain/occurrences/facts";
import { TBD_EVENT_TIME } from "@/lib/events/event-time";
import type { PrepareEventResult } from "@/lib/pipeline/ingestion/contracts";
import type { StructuredFactExtractionResult } from "@/lib/pipeline/ingestion/structured-fact-contracts";
import {
  bindSourceOccurrenceFactMetadata,
  buildSourceOccurrencePlanFromFacts,
  type SourceOccurrencePlan,
} from "@/lib/pipeline/source-occurrence-planning";
import type { InstagramScrapedPost } from "@/lib/scraper/instagram-scraper";

function readStringArray(
  record: Record<string, unknown>,
  key: string,
  fallback: readonly string[],
): string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [...fallback];
}

/** Bind durable occurrence identity directly onto typed fact results. */
export function bindStructuredFactOccurrenceMetadata(
  post: InstagramScrapedPost,
  results: readonly StructuredFactExtractionResult[],
): StructuredFactExtractionResult[] {
  return bindSourceOccurrenceFactMetadata(post, results);
}

/**
 * Reconciliation may reassign only occurrence metadata on the compatibility
 * persistence command. Copy that metadata back to facts before planning so the
 * source-occurrence writer never needs the command as a second authority.
 */
export function applyPreparedOccurrenceMetadataToStructuredFacts(
  factsResults: readonly StructuredFactExtractionResult[],
  reconciledCommands: readonly PrepareEventResult[],
): StructuredFactExtractionResult[] {
  if (factsResults.length !== reconciledCommands.length) {
    throw new Error("Structured facts and prepared occurrence metadata diverged.");
  }
  return factsResults.map((result, index) => {
    const prepared = reconciledCommands[index];
    if (!prepared || (result.kind === "event") !== (prepared.kind === "ok")) {
      throw new Error(
        "Structured-fact occurrence disposition diverged during reconciliation.",
      );
    }
    if (result.kind === "skip") {
      if (prepared.kind !== "skip") {
        throw new Error("Prepared occurrence metadata changed a skip disposition.");
      }
      return { ...result, normalizedFields: prepared.normalizedFields };
    }
    if (prepared.kind !== "ok") {
      throw new Error("Prepared occurrence metadata changed an event disposition.");
    }
    const expectedTime = getStructuredFactsOccurrenceTime(result.facts);
    if (
      prepared.event.date !== result.facts.localDate ||
      prepared.event.time !== expectedTime ||
      prepared.event.title !== result.facts.titleClaim ||
      prepared.event.venue !== (result.facts.venueClaim ?? "") ||
      JSON.stringify(prepared.event.artists) !==
        JSON.stringify(result.facts.artistClaims)
    ) {
      throw new Error(
        "Prepared occurrence metadata changed fact-owned semantic fields.",
      );
    }
    if (prepared.event.status !== "pending") {
      return {
        ...result,
        normalizedFields: prepared.normalizedFields,
      };
    }
    const policy = result.facts.policy;
    return {
      ...result,
      normalizedFields: prepared.normalizedFields,
      facts: {
        ...result.facts,
        policy: {
          approvalDisposition: "pending",
          pendingReasons: readStringArray(
            prepared.normalizedFields,
            "moderationPendingReasons",
            policy.pendingReasons,
          ),
          signals: readStringArray(
            prepared.normalizedFields,
            "moderationSignals",
            policy.signals,
          ),
          structuredEvidenceVerified: policy.structuredEvidenceVerified,
        },
      },
    };
  });
}

export function buildStructuredFactOccurrencePlan(
  post: InstagramScrapedPost,
  factsResults: readonly StructuredFactExtractionResult[],
): SourceOccurrencePlan | null {
  return buildSourceOccurrencePlanFromFacts(
    post,
    factsResults.map((result) =>
      result.kind === "skip"
        ? result
        : {
            ...result,
            canonicalEvent: {
              ...(result.evidence.dateEvidenceIsRelative !== undefined
                ? {
                    dateEvidenceIsRelative:
                      result.evidence.dateEvidenceIsRelative,
                  }
                : {}),
              ...(result.evidence.dateEvidenceResolvedDate
                ? {
                    dateEvidenceResolvedDate:
                      result.evidence.dateEvidenceResolvedDate,
                  }
                : {}),
              ...(result.evidence.dateEvidenceSource
                ? { dateEvidenceSource: result.evidence.dateEvidenceSource }
                : {}),
              ...(result.evidence.dateEvidenceText
                ? { dateEvidenceText: result.evidence.dateEvidenceText }
                : {}),
              ...(result.presentation.description
                ? { description: result.presentation.description }
                : {}),
              normalizedFieldsJson: JSON.stringify(result.normalizedFields),
              requestedStatus: result.facts.policy.approvalDisposition,
              sourceConflictFields: [...result.evidence.sourceConflictFields],
              ...(result.presentation.ticketPrice
                ? { ticketPrice: result.presentation.ticketPrice }
                : {}),
              time:
                getStructuredFactsOccurrenceTime(result.facts) ??
                TBD_EVENT_TIME,
              timeConfidence: result.evidence.timeConfidence,
              ...(result.evidence.timeEvidenceKind
                ? { timeEvidenceKind: result.evidence.timeEvidenceKind }
                : {}),
              ...(result.evidence.timeEvidenceText
                ? { timeEvidenceText: result.evidence.timeEvidenceText }
                : {}),
              timeSource: result.evidence.timeSource,
              timeStatus: result.evidence.timeStatus,
            },
          },
    ),
  );
}
