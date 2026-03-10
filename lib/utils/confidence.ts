export const DUPLICATE_CONFIDENCE_MULTIPLIER = 0.5;
export const MISSING_IMAGE_CONFIDENCE_PENALTY = 0.2;
export const AUTO_APPROVE_CONFIDENCE_THRESHOLD = 0.9;

export function normalizeConfidenceScore(
  value: number | string | null | undefined,
): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  const parsed =
    typeof value === "number" ? value : Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  const normalized =
    parsed <= 1 ? parsed : parsed <= 100 ? parsed / 100 : null;
  if (normalized === null) {
    return null;
  }

  return Math.round(normalized * 100) / 100;
}

export function formatConfidenceScore(
  value: number | string | null | undefined,
): string | null {
  const normalized = normalizeConfidenceScore(value);
  return normalized === null ? null : normalized.toFixed(2);
}

export function clampConfidenceScore(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}

export function calculateModerationConfidenceScore(
  baseConfidenceScore: number | null,
  options: {
    hasSuspectedDuplicates: boolean;
    missingImage: boolean;
  },
): number | null {
  if (baseConfidenceScore === null) {
    return null;
  }

  let score = baseConfidenceScore;
  if (options.hasSuspectedDuplicates) {
    score *= DUPLICATE_CONFIDENCE_MULTIPLIER;
  }
  if (options.missingImage) {
    score -= MISSING_IMAGE_CONFIDENCE_PENALTY;
  }

  return clampConfidenceScore(score);
}

export function shouldAutoApproveConfidenceScore(
  confidenceScore: number | null,
): boolean {
  return (
    confidenceScore !== null &&
    confidenceScore > AUTO_APPROVE_CONFIDENCE_THRESHOLD
  );
}

export function normalizeConfidencePayload<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeConfidencePayload(item)) as T;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const normalizedRecord: Record<string, unknown> = {};
  for (const [key, recordValue] of Object.entries(value)) {
    if (key === "confidence") {
      normalizedRecord[key] =
        normalizeConfidenceScore(
          recordValue as number | string | null | undefined,
        ) ?? recordValue;
      continue;
    }
    normalizedRecord[key] = normalizeConfidencePayload(recordValue);
  }

  return normalizedRecord as T;
}
