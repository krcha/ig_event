import {
  calculateModerationConfidenceScore,
  normalizeConfidenceScore,
} from "@/lib/utils/confidence";

function readNumberOrStringField(
  record: Record<string, unknown> | null,
  key: string,
): number | string | null {
  const value = record?.[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return null;
}

export function getPersistedBaseConfidenceScore(input: {
  normalizedFields: Record<string, unknown> | null;
  rawExtraction: Record<string, unknown> | null;
}): number | null {
  return (
    normalizeConfidenceScore(
      readNumberOrStringField(input.normalizedFields, "confidence"),
    ) ??
    normalizeConfidenceScore(
      readNumberOrStringField(input.rawExtraction, "confidence"),
    )
  );
}

export function getPersistedModerationConfidenceScore(input: {
  normalizedFields: Record<string, unknown> | null;
  rawExtraction: Record<string, unknown> | null;
  hasImage: boolean;
}): number | null {
  const baseConfidenceScore = getPersistedBaseConfidenceScore(input);

  return calculateModerationConfidenceScore(baseConfidenceScore, {
    hasSuspectedDuplicates: false,
    missingImage: !input.hasImage,
    allowMissingImage:
      input.normalizedFields?.moderationAllowMissingImage === true,
  });
}
