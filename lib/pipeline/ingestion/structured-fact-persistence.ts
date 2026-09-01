import { TBD_EVENT_TIME } from "@/lib/events/event-time";
import type { PrepareEventResult } from "@/lib/pipeline/ingestion/contracts";
import type {
  StructuredFactEventResult,
  StructuredFactExtractionResult,
} from "@/lib/pipeline/ingestion/structured-fact-contracts";

function prepareStructuredFactEventForPersistence(
  result: StructuredFactEventResult,
): Extract<PrepareEventResult, { kind: "ok" }> {
  const { evidence, facts, normalizedFields, presentation, source } = result;
  const persistenceTime =
    facts.timeRelation === "exact" && facts.startTime
      ? facts.startTime
      : TBD_EVENT_TIME;
  const sourceOccurrenceKey =
    typeof normalizedFields.sourceOccurrenceKey === "string" &&
    normalizedFields.sourceOccurrenceKey.trim().length > 0
      ? normalizedFields.sourceOccurrenceKey
      : undefined;

  return {
    kind: "ok",
    normalizedFields,
    event: {
      title: facts.titleClaim,
      date: facts.localDate,
      time: persistenceTime,
      timeSource: evidence.timeSource,
      ...(evidence.timeEvidenceText
        ? { timeEvidenceText: evidence.timeEvidenceText }
        : {}),
      timeConfidence: evidence.timeConfidence,
      timeStatus: evidence.timeStatus,
      ...(evidence.timeEvidenceKind
        ? { timeEvidenceKind: evidence.timeEvidenceKind }
        : {}),
      ...(evidence.dateEvidenceText
        ? { dateEvidenceText: evidence.dateEvidenceText }
        : {}),
      ...(evidence.dateEvidenceSource
        ? { dateEvidenceSource: evidence.dateEvidenceSource }
        : {}),
      ...(evidence.dateEvidenceIsRelative !== undefined
        ? { dateEvidenceIsRelative: evidence.dateEvidenceIsRelative }
        : {}),
      ...(evidence.dateEvidenceResolvedDate
        ? { dateEvidenceResolvedDate: evidence.dateEvidenceResolvedDate }
        : {}),
      sourceConflictFields: [...evidence.sourceConflictFields],
      venue: facts.venueClaim ?? "",
      artists: [...facts.artistClaims],
      ...presentation,
      instagramPostUrl: source.instagramPostUrl,
      instagramPostId: source.instagramPostId,
      eventType: facts.eventTypeClaim ?? "",
      ...(source.caption ? { sourceCaption: source.caption } : {}),
      ...(source.postedAt ? { sourcePostedAt: source.postedAt } : {}),
      rawExtractionJson: source.rawExtractionJson,
      normalizedFieldsJson: JSON.stringify(normalizedFields),
      ...(sourceOccurrenceKey ? { sourceOccurrenceKey } : {}),
      status: facts.policy.approvalDisposition,
    },
  };
}

/** Typed-fact -> legacy persistence command adapter. */
export function prepareStructuredFactsForPersistence(
  results: readonly StructuredFactExtractionResult[],
): PrepareEventResult[] {
  return results.map((result) =>
    result.kind === "event"
      ? prepareStructuredFactEventForPersistence(result)
      : {
          kind: "skip",
          reason: result.reason,
          normalizedFields: result.normalizedFields,
        },
  );
}
