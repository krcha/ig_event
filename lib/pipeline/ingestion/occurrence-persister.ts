import type { ExtractedEventData } from "@/lib/ai/extract-event-data";
import type { SourceOccurrenceReceipt } from "@/lib/pipeline/source-occurrence-planning";
import type { ExistingSourceMatch, IngestionPostContext, IngestionStep, PrepareEventResult, ProcessIngestionPostOptions } from "@/lib/pipeline/ingestion/contracts";
import { createEventMutation, getEventQuery, reconcileIngestionPlanMutation, reconcileInstagramSourceOccurrenceReceiptMutation, recordInstagramSourceOccurrenceSatisfactionMutation, updateEventAndRecordInstagramSourceOccurrenceSatisfactionMutation, updateEventMutation, updateSourceOccurrenceExpectedCountMutation } from "@/lib/pipeline/ingestion/convex-bindings";
import { isLowQualityExistingEvent, mapDuplicateReasonToLogEvent } from "@/lib/pipeline/ingestion/existing-source-policy";
import { hasDurableMediaEligibleNormalizedFields, persistInstagramMediaCandidates } from "@/lib/pipeline/ingestion/media-durability";
import { buildDuplicateUpdatePatch, hasMaterialEventChange } from "@/lib/pipeline/ingestion/occurrence-comparison";
import { findBestExistingMatchForPreparedEvent, hasCompatibleSourceOccurrenceIdentity, hasIncompleteAmbiguousCollisionContext, listExistingEventsByPreparedDates, reconcileAmbiguousOccurrenceKeysWithExistingEvents } from "@/lib/pipeline/ingestion/occurrence-matching";
import { getEventDateFilterContext } from "@/lib/pipeline/ingestion/parsing-date";
import { classifyExistingApprovedOccurrence } from "@/lib/pipeline/ingestion/post-processing-policy";
import { getErrorMessage, logError, logInfo } from "@/lib/pipeline/ingestion/runtime";
import { normalizeString, parseJsonRecord, readJsonNumber, readJsonString, readJsonStringArray } from "@/lib/pipeline/ingestion/values";
import type { StructuredFactExtractionResult } from "@/lib/pipeline/ingestion/structured-fact-contracts";
import {
  applyPreparedOccurrenceMetadataToStructuredFacts,
  buildStructuredFactOccurrencePlan,
} from "@/lib/pipeline/ingestion/structured-fact-occurrence";

type PersistStructuredFactOccurrencesInput = {
  analyzedPosterPersisted: boolean;
  client: ProcessIngestionPostOptions["client"];
  durableMediaCandidates: string[];
  existingSourceMatches: ExistingSourceMatch[];
  extracted: ExtractedEventData;
  extractionMode: "poster" | "caption_only";
  handle: string;
  post: ProcessIngestionPostOptions["post"];
  postContext: IngestionPostContext;
  preparedResults: PrepareEventResult[];
  processingFence: ProcessIngestionPostOptions["processingFence"];
  recoveringIncompleteSourceOccurrenceSet: boolean;
  selectedImageChecksumSha256: string | null;
  selectedImageUrl: string | null;
  serviceSecret: string;
  sourceReceipt: SourceOccurrenceReceipt | null;
  structuredFacts: readonly StructuredFactExtractionResult[];
  summary: ProcessIngestionPostOptions["summary"];
};

type GenericIngestionOutcome = {
  action: "attach" | "create" | "manual_review" | "update";
  applied: boolean;
  canonicalEventId?: string;
  canonicalEventStatus?: "approved" | "pending" | "rejected";
  sourceOccurrenceId: string;
  sourceOccurrenceKey: string;
};

type GenericIngestionResult =
  | { authority: "legacy"; outcomes: [] }
  | { authority: "reconciliation"; outcomes: GenericIngestionOutcome[] };

/** Duplicate reconciliation and durable event persistence after fact normalization. */
export async function persistStructuredFactOccurrences(input: PersistStructuredFactOccurrencesInput): Promise<void> {
  const {
    analyzedPosterPersisted, client, durableMediaCandidates, existingSourceMatches: sourceIdentityMatches,
    extracted, extractionMode, handle, post, postContext, processingFence,
    recoveringIncompleteSourceOccurrenceSet, selectedImageChecksumSha256, selectedImageUrl,
    serviceSecret, sourceReceipt, summary,
  } = input;
  let preparedResults = input.preparedResults;
  let structuredFacts = input.structuredFacts;
  const requiresDurableAnalyzedPoster = preparedResults.some(
    (prepared) =>
      prepared.kind === "ok" &&
      prepared.normalizedFields.extractionContractVersion === "event_evidence_v2" &&
      prepared.normalizedFields.extractionMode === "poster",
  );
  if (requiresDurableAnalyzedPoster && !analyzedPosterPersisted) {
    if (!selectedImageUrl || !selectedImageChecksumSha256) {
      summary.failedImagePersistence += 1;
      summary.errors.push(
        "Approved poster evidence is missing its exact analyzed-image checksum.",
      );
    }
    logError("ingestion.image.analysis_poster_not_durable", {
      ...postContext,
      extractionMode,
      selectedImageUrl,
    });
    return;
  }

  if (
    preparedResults.some(
      (prepared) => prepared.normalizedFields.rejectedRecurringModelSchedule === true,
    )
  ) {
    const error =
      "Recurring schedule rejected because model lanes are ambiguous or omit preserved source lanes.";
    summary.failedExtractions += 1;
    summary.failed_extractions += 1;
    summary.failed_extraction += 1;
    summary.errors.push(error);
    logError("ingestion.recurring_schedule.rejected", {
      step: "normalize_posts" satisfies IngestionStep,
      ...postContext,
      extractionMode,
      selectedImageUrl,
      error,
    });
    return;
  }

  const todayEpochDay = Math.floor(
    Date.parse(`${getEventDateFilterContext().todayIsoDate}T00:00:00Z`) /
      86_400_000,
  );
  const safelyOmittedPastOccurrenceKeys = new Set(
    preparedResults
      .filter(
        (prepared) =>
          prepared.kind === "skip" && prepared.reason === "past_event",
      )
      .filter((prepared) => {
        const date = readJsonString(prepared.normalizedFields, "normalizedDate");
        if (!date) return false;
        const eventEpochDay = Math.floor(
          Date.parse(`${date}T00:00:00Z`) / 86_400_000,
        );
        return Number.isFinite(eventEpochDay) && todayEpochDay - eventEpochDay >= 2;
      })
      .map((prepared) =>
        readJsonString(prepared.normalizedFields, "sourceOccurrenceKey"),
      )
      .filter((key): key is string => key !== null),
  );
  const cutoverPlan = buildStructuredFactOccurrencePlan(post, structuredFacts);
  if (cutoverPlan) {
    cutoverPlan.previousSourceFingerprint =
      sourceReceipt?.sourceFingerprint ?? null;
    cutoverPlan.confirmedPastKeys = [...safelyOmittedPastOccurrenceKeys];
  }
  let genericIngestion: GenericIngestionResult;
  try {
    genericIngestion = (await client.mutation(reconcileIngestionPlanMutation, {
      plan: cutoverPlan,
      processingFence,
      serviceSecret,
    })) as GenericIngestionResult;
  } catch (error) {
    summary.failedExtractions += 1;
    summary.failed_extractions += 1;
    summary.failed_extraction += 1;
    summary.errors.push(getErrorMessage(error));
    logError("ingestion.reconciliation.apply_failed", {
      step: "update_existing_event" satisfies IngestionStep,
      ...postContext,
      extractionMode,
      error: getErrorMessage(error),
    });
    return;
  }
  if (genericIngestion.authority === "reconciliation") {
    for (const prepared of preparedResults) {
      if (prepared.kind !== "skip") continue;
      if (prepared.reason === "missing_date") summary.skipped_missing_date += 1;
      else if (prepared.reason === "missing_venue")
        summary.skipped_missing_venue += 1;
      else if (prepared.reason === "past_event") summary.skipped_past_event += 1;
      else if (prepared.reason === "far_future")
        summary.skipped_far_future_event += 1;
      else summary.skipped_invalid_event += 1;
      logInfo("ingestion.event.skipped", {
        ...postContext,
        extractionMode,
        reason: prepared.reason,
        normalizedFields: prepared.normalizedFields,
      });
    }
    for (const outcome of genericIngestion.outcomes) {
      if (outcome.action === "create" && outcome.applied) {
        summary.insertedEvents += 1;
        summary.inserted_events += 1;
        if (outcome.canonicalEventStatus === "approved") {
          summary.insertedApprovedEvents += 1;
        } else {
          summary.insertedPendingEvents += 1;
        }
      } else if (outcome.action === "update" && outcome.applied) {
        summary.updated_duplicates_bad_data += 1;
      } else if (outcome.action === "attach" && outcome.applied) {
        summary.skippedDuplicates += 1;
        summary.skipped_duplicates += 1;
        summary.skipped_duplicates_clean += 1;
      } else if (outcome.action === "manual_review") {
        summary.failedExtractions += 1;
        summary.failed_extractions += 1;
        summary.failed_extraction += 1;
        summary.errors.push(
          `Source occurrence ${outcome.sourceOccurrenceKey} requires manual reconciliation review.`,
        );
      }
      logInfo("ingestion.reconciliation.outcome", {
        ...postContext,
        action: outcome.action,
        applied: outcome.applied,
        canonicalEventId: outcome.canonicalEventId,
        canonicalEventStatus: outcome.canonicalEventStatus,
        sourceOccurrenceId: outcome.sourceOccurrenceId,
        sourceOccurrenceKey: outcome.sourceOccurrenceKey,
      });
    }
    return;
  }

  let existingMatches: ExistingSourceMatch[] = [];
  try {
    const sameDateMatches = await listExistingEventsByPreparedDates(
      client,
      post,
      preparedResults,
      serviceSecret,
    );
    const matchesById = new Map<string, ExistingSourceMatch>();
    for (const match of sourceIdentityMatches) {
      matchesById.set(match.existingEvent._id, match);
    }
    for (const match of sameDateMatches) {
      if (!matchesById.has(match.existingEvent._id)) {
        matchesById.set(match.existingEvent._id, match);
      }
    }
    existingMatches = [...matchesById.values()];
  } catch (error) {
    summary.failedExtractions += 1;
    summary.failed_extractions += 1;
    summary.errors.push(getErrorMessage(error));
    logError("ingestion.duplicate_check.failed", {
      step: "duplicate_lookup" satisfies IngestionStep,
      ...postContext,
      extractionMode,
      selectedImageUrl,
      error: getErrorMessage(error),
    });
    return;
  }

  preparedResults = reconcileAmbiguousOccurrenceKeysWithExistingEvents(
    preparedResults,
    existingMatches,
  );
  structuredFacts = applyPreparedOccurrenceMetadataToStructuredFacts(
    structuredFacts,
    preparedResults,
  );
  const sourceOccurrencePlan = buildStructuredFactOccurrencePlan(
    post,
    structuredFacts,
  );

  if (sourceOccurrencePlan) {
    sourceOccurrencePlan.previousSourceFingerprint =
      sourceReceipt?.sourceFingerprint ?? null;
    sourceOccurrencePlan.confirmedPastKeys = [
      ...safelyOmittedPastOccurrenceKeys,
    ];
    if (sourceOccurrencePlan.expectedKeys.length === 0) {
      try {
        await client.mutation(reconcileInstagramSourceOccurrenceReceiptMutation, {
          plan: sourceOccurrencePlan,
          processingFence,
          serviceSecret,
        });
      } catch (error) {
        summary.failedExtractions += 1;
        summary.failed_extractions += 1;
        summary.errors.push(getErrorMessage(error));
        logError("ingestion.source_occurrence_receipt.reconcile_failed", {
          step: "update_existing_event" satisfies IngestionStep,
          ...postContext,
          extractionMode,
          error: getErrorMessage(error),
        });
        return;
      }
    }
  }
  let hasDurableMediaAttachmentTarget = false;
  const claimedRepresentativeEventIds = new Set<string>();
  for (const prepared of preparedResults) {
    if (prepared.kind === "skip") {
      if (prepared.reason === "missing_date") {
        summary.skipped_missing_date += 1;
      } else if (prepared.reason === "missing_venue") {
        summary.skipped_missing_venue += 1;
      } else if (prepared.reason === "past_event") {
        summary.skipped_past_event += 1;
      } else if (prepared.reason === "far_future") {
        summary.skipped_far_future_event += 1;
      } else {
        summary.skipped_invalid_event += 1;
      }

      logInfo("ingestion.event.skipped", {
        ...postContext,
        extractionMode,
        selectedImageUrl,
        reason: prepared.reason,
        caption: post.caption,
        postTimestamp: post.postedAt,
        rawExtraction: extracted,
        normalizedFields: prepared.normalizedFields,
      });
      continue;
    }

    const durableMediaEligible = hasDurableMediaEligibleNormalizedFields(
      prepared.normalizedFields,
    );

    const approvedOccurrenceRelations = existingMatches
      .filter(
        (match) =>
          match.existingEvent.status === "approved" &&
          match.existingEvent.date === prepared.event.date,
      )
      .map((match) => {
        return classifyExistingApprovedOccurrence(
          match.existingEvent,
          prepared.event,
        );
      });

    if (
      prepared.event.status === "approved" &&
      approvedOccurrenceRelations.includes("ambiguous")
    ) {
      const pendingReasons = [
        ...new Set([
          ...((prepared.normalizedFields.moderationPendingReasons as string[] | undefined) ?? []),
          "ambiguous_approved_occurrence",
        ]),
      ];
      const moderationSignals = [
        ...new Set([
          ...((prepared.normalizedFields.moderationSignals as string[] | undefined) ?? []),
          "ambiguous_approved_occurrence",
        ]),
      ];
      prepared.normalizedFields.moderationAutoApproved = false;
      prepared.normalizedFields.moderationAutoApproveRule = null;
      prepared.normalizedFields.moderationPendingReasons = pendingReasons;
      prepared.normalizedFields.moderationSignals = moderationSignals;
      prepared.event.status = "pending";
      prepared.event.normalizedFieldsJson = JSON.stringify(prepared.normalizedFields);
    }

    const preparedOccurrenceKey = readJsonString(
      prepared.normalizedFields,
      "sourceOccurrenceKey",
    );
    const expectedPreparedOccurrence =
      sourceOccurrencePlan?.expectedOccurrences.find(
        (occurrence) => occurrence.key === preparedOccurrenceKey,
      );
    const existingMatch = findBestExistingMatchForPreparedEvent(
      existingMatches.filter(
        (match) => !claimedRepresentativeEventIds.has(match.existingEvent._id),
      ),
      prepared.event,
      prepared.normalizedFields,
    );

    const conflictingOccurrenceKey =
      preparedOccurrenceKey &&
      expectedPreparedOccurrence
        ? existingMatches.find((match) => {
            const existingFields = parseJsonRecord(
              match.existingEvent.normalizedFieldsJson,
            );
            const existingKey =
              normalizeString(match.existingEvent.sourceOccurrenceKey) ||
              readJsonString(existingFields, "sourceOccurrenceKey");
            return (
              existingKey === preparedOccurrenceKey &&
              match.existingEvent._id !== existingMatch?.existingEvent._id
            );
          })
        : undefined;
    if (conflictingOccurrenceKey) {
      const error =
        "Source-occurrence key is occupied by a different semantic representative; manual repair is required.";
      summary.failedExtractions += 1;
      summary.failed_extractions += 1;
      summary.errors.push(error);
      logError("ingestion.source_occurrence_binding.conflict", {
        step: "update_existing_event" satisfies IngestionStep,
        ...postContext,
        extractionMode,
        sourceOccurrenceKey: preparedOccurrenceKey,
        conflictingEventId: conflictingOccurrenceKey.existingEvent._id,
        error,
      });
      continue;
    }

    if (
      !existingMatch &&
      hasIncompleteAmbiguousCollisionContext(
        existingMatches,
        prepared.event,
        prepared.normalizedFields,
      )
    ) {
      const error =
        "Ambiguous source-occurrence collision requires a complete sibling extraction before persistence.";
      summary.failedExtractions += 1;
      summary.failed_extractions += 1;
      summary.errors.push(error);
      logError("ingestion.source_occurrence_collision.deferred", {
        step: "insert_new_event" satisfies IngestionStep,
        ...postContext,
        extractionMode,
        date: prepared.event.date,
        time: prepared.event.time,
        sourceOccurrenceKey: readJsonString(
          prepared.normalizedFields,
          "sourceOccurrenceKey",
        ),
        error,
      });
      continue;
    }

    if (existingMatch) {
      claimedRepresentativeEventIds.add(existingMatch.existingEvent._id);
      const existingReceiptMappings =
        sourceReceipt?.satisfiedOccurrences.filter(
          (occurrence) => occurrence.eventId === existingMatch.existingEvent._id,
        ) ?? [];
      const supersededOccurrenceKey =
        sourceOccurrencePlan &&
        preparedOccurrenceKey &&
        sourceReceipt &&
        sourceReceipt.sourceFingerprint !== sourceOccurrencePlan.sourceFingerprint &&
        existingMatch.matchedBy !== "same_date_semantic" &&
        existingReceiptMappings.length === 1 &&
        existingReceiptMappings[0]?.key !== preparedOccurrenceKey &&
        sourceReceipt.expectedKeys.includes(existingReceiptMappings[0]!.key) &&
        !sourceOccurrencePlan.expectedKeys.includes(existingReceiptMappings[0]!.key)
          ? existingReceiptMappings[0]!.key
          : undefined;
      const recordPreparedOccurrenceSatisfaction = async (): Promise<boolean> => {
        if (!sourceOccurrencePlan || !preparedOccurrenceKey) {
          return true;
        }
        try {
          await client.mutation(recordInstagramSourceOccurrenceSatisfactionMutation, {
            plan: sourceOccurrencePlan,
            satisfiedKey: preparedOccurrenceKey,
            representativeEventId: existingMatch.existingEvent._id,
            processingFence,
            ...(supersededOccurrenceKey
              ? { supersededKey: supersededOccurrenceKey }
              : {}),
            serviceSecret,
          });
          return true;
        } catch (error) {
          summary.errors.push(getErrorMessage(error));
          logError("ingestion.source_occurrence_receipt.failed", {
            step: "update_existing_event" satisfies IngestionStep,
            ...postContext,
            extractionMode,
            existingEventId: existingMatch.existingEvent._id,
            error: getErrorMessage(error),
          });
          return false;
        }
      };
      const preservesExistingSiblingDuringRecovery =
        recoveringIncompleteSourceOccurrenceSet &&
        existingMatch.matchedBy !== "same_date_semantic" &&
        normalizeString(existingMatch.existingEvent.date) === prepared.event.date &&
        hasCompatibleSourceOccurrenceIdentity(
          existingMatch.existingEvent,
          prepared.event,
          prepared.normalizedFields,
        );
      if (preservesExistingSiblingDuringRecovery) {
        const receiptSatisfactionSucceeded =
          await recordPreparedOccurrenceSatisfaction();
        if (!receiptSatisfactionSucceeded) {
          summary.duplicate_update_failed += 1;
          continue;
        }
        const existingNormalizedFields = parseJsonRecord(
          existingMatch.existingEvent.normalizedFieldsJson,
        );
        const currentExpectedCount = readJsonNumber(
          existingNormalizedFields,
          "sourceOccurrenceExpectedCount",
        );
        const currentExpectedKeys = readJsonStringArray(
          existingNormalizedFields,
          "sourceOccurrenceExpectedKeys",
        );
        const nextExpectedCount = readJsonNumber(
          prepared.normalizedFields,
          "sourceOccurrenceExpectedCount",
        );
        const nextExpectedKeys = readJsonStringArray(
          prepared.normalizedFields,
          "sourceOccurrenceExpectedKeys",
        );
        const currentDeferredChildCount =
          readJsonNumber(existingNormalizedFields, "sourceOccurrenceDeferredChildCount") ?? 0;
        const nextDeferredChildCount =
          readJsonNumber(prepared.normalizedFields, "sourceOccurrenceDeferredChildCount") ?? 0;
        const currentSourceFingerprint = readJsonString(
          existingNormalizedFields,
          "sourceOccurrenceSourceFingerprint",
        );
        const nextSourceFingerprint = readJsonString(
          prepared.normalizedFields,
          "sourceOccurrenceSourceFingerprint",
        );
        const removedExpectedKeys = currentExpectedKeys.filter(
          (key) => !nextExpectedKeys.includes(key),
        );
        const sourceOccurrenceKey =
          normalizeString(existingMatch.existingEvent.sourceOccurrenceKey) ||
          readJsonString(existingNormalizedFields, "sourceOccurrenceKey");
        const nextSourceOccurrenceKey = readJsonString(
          prepared.normalizedFields,
          "sourceOccurrenceKey",
        );
        const addedExpectedKeys = nextExpectedKeys.filter(
          (key) => !currentExpectedKeys.includes(key),
        );
        const confirmedPastKeys = removedExpectedKeys.filter((key) =>
          safelyOmittedPastOccurrenceKeys.has(key),
        );
        const safeSameSourceTransition =
          removedExpectedKeys.length === 0 ||
          (addedExpectedKeys.length === 0 &&
            confirmedPastKeys.length === removedExpectedKeys.length);
        const metadataChanged =
          currentExpectedCount !== nextExpectedCount ||
          JSON.stringify(currentExpectedKeys) !== JSON.stringify(nextExpectedKeys) ||
          currentDeferredChildCount !== nextDeferredChildCount ||
          currentSourceFingerprint !== nextSourceFingerprint;
        if (
          sourceOccurrenceKey &&
          sourceOccurrenceKey === nextSourceOccurrenceKey &&
          currentExpectedCount !== null &&
          nextExpectedCount !== null &&
          nextSourceFingerprint &&
          currentExpectedCount >= 1 &&
          nextExpectedCount >= 1 &&
          currentExpectedKeys.length === currentExpectedCount &&
          nextExpectedKeys.length === nextExpectedCount &&
          new Set(currentExpectedKeys).size === currentExpectedKeys.length &&
          new Set(nextExpectedKeys).size === nextExpectedKeys.length &&
          metadataChanged &&
          safeSameSourceTransition
        ) {
          try {
            await client.mutation(updateSourceOccurrenceExpectedCountMutation, {
              id: existingMatch.existingEvent._id,
              sourceOccurrenceKey,
              expectedCurrentCount: currentExpectedCount,
              expectedCurrentKeys: currentExpectedKeys,
              expectedCurrentDeferredChildCount: currentDeferredChildCount,
              expectedCurrentSourceFingerprint: currentSourceFingerprint ?? undefined,
              nextExpectedCount,
              nextExpectedKeys,
              nextDeferredChildCount,
              nextSourceFingerprint,
              confirmedPastKeys,
              processingFence,
              serviceSecret,
            });
            const normalizedFieldsJson = JSON.stringify({
              ...(existingNormalizedFields ?? {}),
              sourceOccurrenceExpectedCount: nextExpectedCount,
              sourceOccurrenceExpectedKeys: nextExpectedKeys,
              sourceOccurrenceDeferredChildCount: nextDeferredChildCount,
              sourceOccurrenceSourceFingerprint: nextSourceFingerprint,
            });
            existingMatch.existingEvent.normalizedFieldsJson = normalizedFieldsJson;
            logInfo("duplicate_incomplete_source_completeness_updated", {
              ...postContext,
              extractionMode,
              existingEventId: existingMatch.existingEvent._id,
              currentExpectedCount,
              nextExpectedCount,
            });
          } catch (error) {
            summary.duplicate_update_failed += 1;
            summary.errors.push(getErrorMessage(error));
            logError("duplicate_incomplete_source_completeness_update_failed", {
              step: "update_existing_event" satisfies IngestionStep,
              ...postContext,
              extractionMode,
              existingEventId: existingMatch.existingEvent._id,
              currentExpectedCount,
              nextExpectedCount,
              error: getErrorMessage(error),
            });
          }
        }
        if (durableMediaEligible) {
          hasDurableMediaAttachmentTarget = true;
        }
        summary.skippedDuplicates += 1;
        summary.skipped_duplicates += 1;
        summary.skipped_duplicates_clean += 1;
        logInfo("duplicate_incomplete_source_sibling_preserved", {
          ...postContext,
          extractionMode,
          selectedImageUrl,
          matchedBy: existingMatch.matchedBy,
          matchedValue: existingMatch.matchedValue,
          existingEventId: existingMatch.existingEvent._id,
          normalizedFields: prepared.normalizedFields,
        });
        continue;
      }

      const quality = isLowQualityExistingEvent(existingMatch.existingEvent, post.postedAt);
      const hasMaterialChange = hasMaterialEventChange(
        existingMatch.existingEvent,
        prepared.event,
      );

      if (!quality.isLowQuality && !hasMaterialChange) {
        const receiptSatisfactionSucceeded =
          await recordPreparedOccurrenceSatisfaction();
        if (!receiptSatisfactionSucceeded) {
          summary.duplicate_update_failed += 1;
          continue;
        }
        if (durableMediaEligible) {
          hasDurableMediaAttachmentTarget = true;
        }
        summary.skippedDuplicates += 1;
        summary.skipped_duplicates += 1;
        summary.skipped_duplicates_clean += 1;
        logInfo("duplicate_clean_skip", {
          ...postContext,
          extractionMode,
          selectedImageUrl,
          matchedBy: existingMatch.matchedBy,
          matchedValue: existingMatch.matchedValue,
          existingEventId: existingMatch.existingEvent._id,
          existingStatus: existingMatch.existingEvent.status,
          normalizedFields: prepared.normalizedFields,
        });
        continue;
      }

      const primaryReason = quality.primaryReason ?? "invalid_normalized_fields";
      const updateReasonEvent = mapDuplicateReasonToLogEvent(primaryReason);
      const updatePayload = buildDuplicateUpdatePatch(
        existingMatch.existingEvent,
        prepared.event,
      );

      if (updatePayload.protectedApprovedFromPending) {
        const receiptSatisfactionSucceeded =
          await recordPreparedOccurrenceSatisfaction();
        if (!receiptSatisfactionSucceeded) {
          summary.duplicate_update_failed += 1;
          continue;
        }
        if (durableMediaEligible) {
          hasDurableMediaAttachmentTarget = true;
        }
        summary.skippedDuplicates += 1;
        summary.skipped_duplicates += 1;
        summary.skipped_duplicates_clean += 1;
        logInfo("duplicate_approved_protected_from_pending_update", {
          ...postContext,
          extractionMode,
          selectedImageUrl,
          matchedBy: existingMatch.matchedBy,
          matchedValue: existingMatch.matchedValue,
          existingEventId: existingMatch.existingEvent._id,
          existingStatus: existingMatch.existingEvent.status,
          candidateStatus: prepared.event.status,
          normalizedFields: prepared.normalizedFields,
        });
        continue;
      }

      try {
        let persistedUpdate: { updatedAt: number };
        if (sourceOccurrencePlan && preparedOccurrenceKey) {
          persistedUpdate = await client.mutation(
            updateEventAndRecordInstagramSourceOccurrenceSatisfactionMutation,
            {
              id: existingMatch.existingEvent._id,
              patch: updatePayload.patch,
              expectedStatus: existingMatch.existingEvent.status,
              expectedUpdatedAt: existingMatch.existingEvent.updatedAt,
              plan: sourceOccurrencePlan,
              satisfiedKey: preparedOccurrenceKey,
              processingFence,
              ...(supersededOccurrenceKey
                ? { supersededKey: supersededOccurrenceKey }
                : {}),
              serviceSecret,
            },
          );
        } else {
          persistedUpdate = await client.mutation(updateEventMutation, {
            id: existingMatch.existingEvent._id,
            patch: updatePayload.patch,
            expectedStatus: existingMatch.existingEvent.status,
            expectedUpdatedAt: existingMatch.existingEvent.updatedAt,
            serviceSecret,
          }) as { updatedAt: number };
        }
        if (durableMediaEligible) {
          hasDurableMediaAttachmentTarget = true;
        }
        summary.updated_duplicates_bad_data += 1;
        logInfo(updateReasonEvent, {
          phase: "duplicate_updated",
          ...postContext,
          extractionMode,
          selectedImageUrl,
          matchedBy: existingMatch.matchedBy,
          matchedValue: existingMatch.matchedValue,
          existingEventId: existingMatch.existingEvent._id,
          qualityReasons: quality.reasons,
          qualityDetails: quality.details,
          materiallyChanged: updatePayload.materiallyChanged,
          statusAutoApproved: updatePayload.statusAutoApproved,
          statusResetToPending: updatePayload.statusResetToPending,
          caption: post.caption,
          postTimestamp: post.postedAt,
          rawExtraction: extracted,
          normalizedFields: prepared.normalizedFields,
        });
        const { clearTicketPrice, ...persistedPatch } = updatePayload.patch;
        existingMatch.existingEvent = {
          ...existingMatch.existingEvent,
          ...persistedPatch,
          ...(clearTicketPrice ? { ticketPrice: undefined } : {}),
          timeEvidenceText: updatePayload.patch.timeEvidenceText ?? undefined,
          status:
            updatePayload.patch.status ?? existingMatch.existingEvent.status,
          reviewedAt:
            updatePayload.patch.reviewedAt ?? existingMatch.existingEvent.reviewedAt,
          reviewedBy:
            updatePayload.patch.reviewedBy ?? existingMatch.existingEvent.reviewedBy,
          moderationNote:
            updatePayload.patch.moderationNote ?? existingMatch.existingEvent.moderationNote,
          updatedAt: persistedUpdate.updatedAt,
        };
      } catch (error) {
        summary.duplicate_update_failed += 1;
        summary.errors.push(getErrorMessage(error));
        logError("duplicate_update_failed", {
          step: "update_existing_event" satisfies IngestionStep,
          ...postContext,
          extractionMode,
          selectedImageUrl,
          existingEventId: existingMatch.existingEvent._id,
          qualityReasons: quality.reasons,
          error: getErrorMessage(error),
        });
      }
      continue;
    }

    try {
      const createResult = (await client.mutation(
        createEventMutation,
        {
          ...prepared.event,
          ...(sourceOccurrencePlan ? { sourceOccurrencePlan } : {}),
          processingFence,
          returnCreateDisposition: true,
          serviceSecret,
        },
      )) as string | { eventId: string; created: boolean; updatedAt?: number };
      const insertedId =
        typeof createResult === "string" ? createResult : createResult.eventId;
      const wasCreated =
        typeof createResult === "string" ? true : createResult.created;
      let insertedUpdatedAt =
        typeof createResult === "string" ? undefined : createResult.updatedAt;
      if (!Number.isSafeInteger(insertedUpdatedAt)) {
        const persistedEvent = (await client.query(getEventQuery, { id: insertedId })) as
          | { updatedAt?: number }
          | null;
        insertedUpdatedAt = persistedEvent?.updatedAt;
      }
      if (!Number.isSafeInteger(insertedUpdatedAt)) {
        throw new Error("Created event did not expose an exact updatedAt version.");
      }
      const exactInsertedUpdatedAt = insertedUpdatedAt as number;
      if (durableMediaEligible) {
        hasDurableMediaAttachmentTarget = true;
      }
      if (!wasCreated) {
        summary.skippedDuplicates += 1;
        summary.skipped_duplicates += 1;
        summary.skipped_duplicates_clean += 1;
        existingMatches.push({
          existingEvent: {
            _id: insertedId,
            ...prepared.event,
            updatedAt: exactInsertedUpdatedAt,
          },
          matchedBy: "post_url",
          matchedValue: prepared.event.instagramPostUrl,
        });
        logInfo("duplicate_atomic_source_occurrence_skip", {
          ...postContext,
          extractionMode,
          selectedImageUrl,
          existingEventId: insertedId,
          sourceOccurrenceKey: prepared.event.sourceOccurrenceKey,
          normalizedFields: prepared.normalizedFields,
        });
        continue;
      }
      summary.insertedEvents += 1;
      summary.inserted_events += 1;
      if (prepared.event.status === "approved") {
        summary.insertedApprovedEvents += 1;
      } else if (prepared.event.status === "pending") {
        summary.insertedPendingEvents += 1;
      }
      existingMatches.push({
        existingEvent: {
          _id: insertedId,
          ...prepared.event,
          updatedAt: exactInsertedUpdatedAt,
        },
        matchedBy: "post_url",
        matchedValue: prepared.event.instagramPostUrl,
      });
      logInfo("ingestion.event.inserted", {
        ...postContext,
        extractionMode,
        selectedImageUrl,
        caption: post.caption,
        postTimestamp: post.postedAt,
        rawExtraction: extracted,
        normalizedFields: prepared.normalizedFields,
      });
    } catch (error) {
      summary.failedExtractions += 1;
      summary.failed_extractions += 1;
      summary.failed_extraction += 1;
      summary.errors.push(getErrorMessage(error));
      logError("ingestion.insert.failed", {
        step: "insert_new_event" satisfies IngestionStep,
        ...postContext,
        extractionMode,
        selectedImageUrl,
        error: getErrorMessage(error),
      });
    }
  }

  if (hasDurableMediaAttachmentTarget && durableMediaCandidates.length > 0) {
    await persistInstagramMediaCandidates({
      client,
      handle,
      post,
      processingFence,
      summary,
      serviceSecret,
      upstreamUrls: durableMediaCandidates,
    });
  }
}
