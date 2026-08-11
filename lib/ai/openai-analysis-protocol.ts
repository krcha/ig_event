export const LEGACY_EVENT_EXTRACTION_ANALYSIS_PROTOCOL =
  "openai-responses:event-extraction:event_evidence_v2" as const;

// This protocol generation is intentionally tied to the larger structured-
// output cap. A saved-post attempt can therefore prove whether it used the old
// 4,096-token boundary or the replacement 8,192-token boundary.
export const EVENT_EXTRACTION_ANALYSIS_PROTOCOL =
  "openai-responses:event-extraction:event_evidence_v2:compact_medium:max_output_tokens_8192:v1" as const;

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
