export const LEGACY_EVENT_EXTRACTION_ANALYSIS_PROTOCOL =
  "openai-responses:event-extraction:event_evidence_v2" as const;

// Completed caches and definitive failures produced by the previous bounded
// generation remain explicitly identifiable after the cap changes.
export const PREVIOUS_EVENT_EXTRACTION_ANALYSIS_PROTOCOL =
  "openai-responses:event-extraction:event_evidence_v2:compact_medium:max_output_tokens_8192:v1" as const;

// This protocol generation is intentionally tied to the structured-output
// cap. A saved-post attempt can therefore prove the exact request boundary it
// used without relaxing the one-transport or strict-schema contract.
export const EVENT_EXTRACTION_ANALYSIS_PROTOCOL =
  "openai-responses:event-extraction:event_evidence_v2:compact_medium:max_output_tokens_16384:v2" as const;

export const DEFINITIVE_OUTPUT_RECOVERY_PROTOCOL =
  "openai-definitive-output-requeue:v1" as const;

export const OPENAI_DEFINITIVE_OUTPUT_FAILURE_KINDS = [
  "incomplete_max_output_tokens",
  "empty_output",
  "invalid_json",
  "invalid_schema",
] as const;

export type OpenAiDefinitiveOutputFailureKind =
  (typeof OPENAI_DEFINITIVE_OUTPUT_FAILURE_KINDS)[number];
