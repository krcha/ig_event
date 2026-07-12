export type EventTimeWriteSource =
  | "caption"
  | "description"
  | "alt_text"
  | "model"
  | "poster"
  | "schedule_entry"
  | "unknown";

export type EventTimeWriteStatus = "confirmed" | "inferred" | "unknown";

export type EventTimeWritePatch = {
  time?: string;
  timeSource?: EventTimeWriteSource;
  timeEvidenceText?: string | null;
  timeConfidence?: number;
  timeStatus?: EventTimeWriteStatus;
};

/**
 * Every time change must also replace its provenance. Legacy callers that only
 * provide a time are normalized to an explicit unknown provenance and clear
 * stale evidence. Partial provenance is rejected rather than mixed with an old
 * record. A null evidence value is the wire-safe request to remove that field.
 */
export function normalizeEventTimeWritePatch<T extends EventTimeWritePatch>(
  patch: T,
): Omit<T, "timeEvidenceText"> & { timeEvidenceText?: string } {
  const normalized = { ...patch } as Omit<T, "timeEvidenceText"> & {
    timeEvidenceText?: string;
  };

  if (Object.hasOwn(patch, "timeEvidenceText")) {
    normalized.timeEvidenceText = patch.timeEvidenceText ?? undefined;
  }

  if (patch.time === undefined) {
    return normalized;
  }

  const provenanceKeys = [
    "timeSource",
    "timeEvidenceText",
    "timeConfidence",
    "timeStatus",
  ] as const;
  const hasAnyProvenance = provenanceKeys.some((key) => Object.hasOwn(patch, key));

  if (!hasAnyProvenance) {
    return {
      ...normalized,
      timeSource: "unknown",
      timeEvidenceText: undefined,
      timeConfidence: 0,
      timeStatus: "unknown",
    };
  }

  if (
    patch.timeSource === undefined ||
    patch.timeConfidence === undefined ||
    patch.timeStatus === undefined
  ) {
    throw new Error(
      "A time update must provide timeSource, timeConfidence, and timeStatus together.",
    );
  }

  if (!Number.isFinite(patch.timeConfidence) || patch.timeConfidence < 0 || patch.timeConfidence > 1) {
    throw new Error("timeConfidence must be between 0 and 1.");
  }

  return normalized;
}
