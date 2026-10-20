import {
  cinemaReleaseDateIsSeparateFromProgramDate,
  partitionEventEvidenceSourceConflicts,
  type EventEvidenceConflictContext,
  type EventEvidenceSourceConflict,
} from "./event-evidence-conflict-policy.ts";
import { HUMAN_REVIEW_REQUIRED_REASON } from "../domain/moderation/policy.ts";

type PendingConflictEvent = {
  artists: string[];
  date: string;
  normalizedFieldsJson?: string;
  rawExtractionJson?: string;
  sourceCaption?: string;
  sourceConflictFields?: string[];
  sourcePostedAt?: string;
  status: "pending" | "approved" | "rejected";
  title: string;
  venue: string;
};

export type PendingSourceConflictReclassification = {
  normalizedFieldsJson: string;
  previousMaterialCount: number;
  nextBenignCount: number;
  sourceConflictFields: string[];
};

function parseRecord(value: string | undefined): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value ?? "null") as unknown;
  } catch {
    throw new Error("Pending conflict reclassification requires valid JSON evidence.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Pending conflict reclassification requires object evidence.");
  }
  return parsed as Record<string, unknown>;
}

function isConflict(value: unknown): value is EventEvidenceSourceConflict {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const conflict = value as Record<string, unknown>;
  return (
    typeof conflict.field === "string" &&
    typeof conflict.poster_value === "string" &&
    typeof conflict.caption_value === "string" &&
    typeof conflict.reason === "string"
  );
}

function sameConflictMultiset(left: readonly unknown[], right: readonly unknown[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = left.map((value) => JSON.stringify(value)).sort();
  const sortedRight = right.map((value) => JSON.stringify(value)).sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

/**
 * Reclassify a verified cinema release claim without changing extraction or
 * occurrence facts. A separate receipt-fenced mutation persists this patch.
 */
export function preparePendingCinemaSourceConflictReclassification(
  event: PendingConflictEvent,
): PendingSourceConflictReclassification {
  if (event.status !== "pending") {
    throw new Error("Only pending events can have source conflicts reclassified.");
  }
  const fields = parseRecord(event.normalizedFieldsJson);
  const raw = parseRecord(event.rawExtractionJson);
  const reported = fields.extractionSourceConflicts;
  const oldMaterial = fields.materialSourceConflicts;
  const oldBenign = fields.benignSourceConflicts;
  const rawConflicts = raw.source_conflicts;
  if (
    fields.extractionContractVersion !== "event_evidence_v2" ||
    fields.sourceConflictResolutionVersion !== 1 ||
    !Array.isArray(reported) || !reported.every(isConflict) ||
    !Array.isArray(oldMaterial) || !oldMaterial.every(isConflict) ||
    !Array.isArray(oldBenign) || !oldBenign.every(isConflict) ||
    !Array.isArray(rawConflicts) || !rawConflicts.every(isConflict) ||
    reported.length < 1 || oldMaterial.length < 1 ||
    fields.extractionSourceConflictCount !== reported.length ||
    fields.materialSourceConflictCount !== oldMaterial.length ||
    fields.benignSourceConflictCount !== oldBenign.length ||
    !sameConflictMultiset(reported, rawConflicts) ||
    !sameConflictMultiset(reported, [...oldMaterial, ...oldBenign]) ||
    !Array.isArray(event.sourceConflictFields) ||
    !Array.isArray(fields.sourceConflictFields) ||
    !sameConflictMultiset(event.sourceConflictFields, fields.sourceConflictFields) ||
    !sameConflictMultiset(event.sourceConflictFields, ["date"]) ||
    fields.extractionIsEvent !== true ||
    raw.is_event !== true ||
    fields.dateEvidenceVerified !== true ||
    fields.timeEvidenceVerified !== true ||
    typeof fields.identityEvidenceVerified !== "boolean" ||
    fields.venueEvidenceVerified !== true ||
    fields.structuredEvidenceVerified !== false ||
    fields.sourceOccurrencePlanUnverified === true ||
    fields.sourceOccurrenceAmbiguousProvenance === true ||
    fields.normalizedIsValid !== true ||
    fields.approvalTitleSensible !== true ||
    fields.dateSuspiciousYear !== false ||
    fields.title !== event.title ||
    fields.normalizedDate !== event.date ||
    fields.normalizedVenue !== event.venue ||
    !Array.isArray(fields.artists) ||
    !sameConflictMultiset(fields.artists, event.artists) ||
    fields.sourceGroundingSourceCaption !== event.sourceCaption ||
    fields.extractionNonEventReason !== null &&
      fields.extractionNonEventReason !== undefined &&
      fields.extractionNonEventReason !== ""
  ) {
    throw new Error("Pending conflict reclassification evidence is not a verified cinema candidate.");
  }
  const sourceAccountRole = fields.sourceAccountRole;
  if (
    sourceAccountRole !== "venue" &&
    sourceAccountRole !== "promoter" &&
    sourceAccountRole !== "unknown"
  ) {
    throw new Error("Pending conflict reclassification has no verified source role.");
  }
  const context: EventEvidenceConflictContext = {
    artists: event.artists,
    dateEvidenceVerified: true,
    identityEvidenceVerified: fields.identityEvidenceVerified === true,
    resolvedDate: event.date,
    selectedTitle: event.title,
    selectedVenue: event.venue,
    singleOccurrenceSource:
      fields.splitEventTotal === 1 && fields.multiEventSplitDetected === false,
    sourceAccountName:
      typeof fields.sourceAccountName === "string" ? fields.sourceAccountName : "",
    sourceAccountRole,
    sourceCaption: event.sourceCaption ?? "",
    sourcePostedAt: event.sourcePostedAt,
    venueEvidenceVerified: true,
  };
  if (
    !oldMaterial.every((conflict) =>
      conflict.field === "date" &&
      cinemaReleaseDateIsSeparateFromProgramDate(conflict, context)
    )
  ) {
    throw new Error("Pending conflict reclassification found a non-cinema material conflict.");
  }
  const next = partitionEventEvidenceSourceConflicts(reported, context);
  if (next.material.length > 0 || next.benign.length !== reported.length) {
    throw new Error("Pending conflict reclassification leaves a material source conflict.");
  }
  const pendingReasons = fields.moderationPendingReasons;
  const signals = fields.moderationSignals;
  if (
    !Array.isArray(pendingReasons) ||
    !pendingReasons.every((reason) => typeof reason === "string") ||
    !pendingReasons.includes(HUMAN_REVIEW_REQUIRED_REASON) ||
    !pendingReasons.includes("poster_caption_conflict") ||
    !Array.isArray(signals) || !signals.every((signal) => typeof signal === "string") ||
    fields.moderationAutoApproved !== false
  ) {
    throw new Error("Pending conflict reclassification has other moderation blockers.");
  }

  const updatedFields = {
    ...fields,
    materialSourceConflicts: [],
    materialSourceConflictCount: 0,
    benignSourceConflicts: next.benign,
    benignSourceConflictCount: next.benign.length,
    sourceConflictFields: [],
    structuredEvidenceVerified: fields.identityEvidenceVerified === true,
    moderationPendingReasons: pendingReasons.filter(
      (reason) => reason !== "poster_caption_conflict",
    ),
    moderationSignals: signals.filter(
      (signal) => signal !== "poster_caption_conflict",
    ),
  };
  return {
    normalizedFieldsJson: JSON.stringify(updatedFields),
    previousMaterialCount: oldMaterial.length,
    nextBenignCount: next.benign.length,
    sourceConflictFields: [],
  };
}
