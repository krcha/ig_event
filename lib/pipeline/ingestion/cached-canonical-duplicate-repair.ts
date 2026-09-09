import type { ExtractedEventData } from "@/lib/ai/extract-event-data";
import type { SourceOccurrencePlan } from "@/lib/pipeline/source-occurrence-planning";
import type {
  IngestionPostContext,
  IngestionStep,
  PrepareEventResult,
  ProcessIngestionPostOptions,
} from "@/lib/pipeline/ingestion/contracts";
import { createEventMutation } from "@/lib/pipeline/ingestion/convex-bindings";
import {
  getErrorMessage,
  logError,
  logInfo,
} from "@/lib/pipeline/ingestion/runtime";

/**
 * Recovery-only persistence lane for a current poster cache. The Convex
 * mutation is explicitly forbidden from creating an event and returns only
 * after the full approved same-date cohort proves one canonical duplicate.
 */
export async function persistCachedCanonicalApprovedDuplicateForRepair(input: {
  client: ProcessIngestionPostOptions["client"];
  extracted: ExtractedEventData;
  extractionMode: "poster" | "caption_only";
  postContext: IngestionPostContext;
  preparedResults: PrepareEventResult[];
  processingFence: ProcessIngestionPostOptions["processingFence"];
  serviceSecret: string;
  sourceOccurrencePlan: SourceOccurrencePlan | null;
  summary: ProcessIngestionPostOptions["summary"];
}): Promise<void> {
  const prepared =
    input.preparedResults.length === 1 ? input.preparedResults[0] : null;
  if (
    input.extractionMode !== "poster" ||
    !input.extracted.is_event ||
    !prepared ||
    prepared.kind !== "ok" ||
    prepared.event.status !== "approved" ||
    !input.sourceOccurrencePlan
  ) {
    input.summary.failedExtractions += 1;
    input.summary.failed_extractions += 1;
    input.summary.failed_extraction += 1;
    input.summary.errors.push(
      `Canonical-duplicate cache repair requires exactly one approved poster occurrence (count=${input.preparedResults.length}, kind=${prepared?.kind ?? "none"}, status=${prepared?.kind === "ok" ? prepared.event.status : "none"}, pendingReasons=${prepared?.kind === "ok" ? JSON.stringify(prepared.normalizedFields.moderationPendingReasons ?? []) : "[]"}).`,
    );
    return;
  }
  try {
    const createResult = (await input.client.mutation(createEventMutation, {
      ...prepared.event,
      sourceOccurrencePlan: input.sourceOccurrencePlan,
      processingFence: input.processingFence,
      returnCreateDisposition: true,
      requireCanonicalApprovedDuplicate: true,
      serviceSecret: input.serviceSecret,
    })) as {
      eventId?: string;
      created?: boolean;
      disposition?: string;
      updatedAt?: number;
    };
    if (
      createResult.created !== false ||
      createResult.disposition !== "canonical_approved_duplicate" ||
      !createResult.eventId ||
      !Number.isSafeInteger(createResult.updatedAt)
    ) {
      throw new Error(
        "Canonical-duplicate cache repair did not resolve to one existing approved event.",
      );
    }
    input.summary.terminalCanonicalDuplicates =
      (input.summary.terminalCanonicalDuplicates ?? 0) + 1;
    input.summary.skippedDuplicates += 1;
    input.summary.skipped_duplicates += 1;
    input.summary.skipped_duplicates_clean += 1;
    logInfo("duplicate_cached_repair_terminal", {
      ...input.postContext,
      extractionMode: input.extractionMode,
      existingEventId: createResult.eventId,
      sourceOccurrenceKey: prepared.event.sourceOccurrenceKey,
    });
  } catch (error) {
    input.summary.failedExtractions += 1;
    input.summary.failed_extractions += 1;
    input.summary.failed_extraction += 1;
    input.summary.errors.push(getErrorMessage(error));
    logError("duplicate_cached_repair.failed", {
      step: "insert_new_event" satisfies IngestionStep,
      ...input.postContext,
      extractionMode: input.extractionMode,
      error: getErrorMessage(error),
    });
  }
}
