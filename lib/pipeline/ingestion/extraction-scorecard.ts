import type { ExtractedEventData } from "@/lib/ai/extract-event-data";
import type { AutomatedModerationDecision as ModerationDecision } from "@/lib/domain/moderation/index";
import { normalizeConfidenceScore } from "@/lib/utils/confidence";
import { normalizeString } from "@/lib/pipeline/ingestion/values";

const EXTRACTION_FIELD_LABELS: Array<{
  key: keyof ExtractedEventData["field_confirmation"];
  label: string;
}> = [
  { key: "title", label: "Title" },
  { key: "location", label: "Location" },
  { key: "location_name", label: "Venue" },
  { key: "price", label: "Price" },
  { key: "start_time", label: "Start time" },
  { key: "short_description", label: "Description" },
  { key: "artists", label: "Artists" },
];

export function buildExtractionFieldEvidence(
  fieldConfirmation: ExtractedEventData["field_confirmation"],
) {
  return EXTRACTION_FIELD_LABELS.map(({ key, label }) => {
    const entry = fieldConfirmation[key];
    return {
      field: key,
      label,
      confidence: normalizeConfidenceScore(entry.confidence),
      foundIn: entry.found_in,
      evidence: normalizeString(entry.evidence),
      evidenceSnippets: entry.evidence_snippets
        .map((snippet) => ({
          source: snippet.source,
          text: normalizeString(snippet.text),
        }))
        .filter((snippet) => snippet.text.length > 0),
      notes: normalizeString(entry.notes),
    };
  });
}

function getWeakExtractionFields(
  fieldEvidence: ReturnType<typeof buildExtractionFieldEvidence>,
) {
  return fieldEvidence
    .filter((field) => {
      const hasEvidence =
        field.evidence.length > 0 ||
        field.evidenceSnippets.some((snippet) => snippet.text.length > 0);
      return field.confidence === null || field.confidence < 0.7 || !hasEvidence;
    })
    .map((field) => field.field);
}

export function buildSkippedExtractionScorecard(options: {
  baseConfidenceScore: number | null;
  fieldConfirmation: ExtractedEventData["field_confirmation"];
  normalizedInvalidReason: string;
}) {
  const fieldEvidence = buildExtractionFieldEvidence(options.fieldConfirmation);

  return {
    agent: "event_extraction",
    version: 1,
    baseConfidenceScore: options.baseConfidenceScore,
    finalModerationConfidenceScore: null,
    normalizedIsValid: false,
    normalizedInvalidReason: options.normalizedInvalidReason,
    autoApproved: false,
    autoApproveRule: null,
    pendingReasons: [options.normalizedInvalidReason],
    signals: ["normalization_failed"],
    weakFields: getWeakExtractionFields(fieldEvidence),
    fieldEvidence,
  };
}

export function buildExtractionScorecard(options: {
  baseConfidenceScore: number | null;
  moderationDecision: ModerationDecision;
  fieldConfirmation: ExtractedEventData["field_confirmation"];
  normalizedIsValid: boolean;
  normalizedInvalidReason: string | null;
}) {
  const fieldEvidence = buildExtractionFieldEvidence(options.fieldConfirmation);

  return {
    agent: "event_extraction",
    version: 1,
    baseConfidenceScore: options.baseConfidenceScore,
    finalModerationConfidenceScore: options.moderationDecision.confidenceScore,
    normalizedIsValid: options.normalizedIsValid,
    normalizedInvalidReason: options.normalizedInvalidReason,
    autoApproved: options.moderationDecision.autoApproved,
    autoApproveRule: options.moderationDecision.autoApproveRule,
    pendingReasons: options.moderationDecision.pendingReasons,
    signals: options.moderationDecision.signals,
    weakFields: getWeakExtractionFields(fieldEvidence),
    fieldEvidence,
  };
}
