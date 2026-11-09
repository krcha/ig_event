import {
  cinemaReleaseDateIsSeparateFromProgramDate,
  partitionEventEvidenceSourceConflicts,
  type EventEvidenceConflictContext,
  type EventEvidenceSourceConflict,
} from "./event-evidence-conflict-policy.ts";
import { HUMAN_REVIEW_REQUIRED_REASON } from "../domain/moderation/policy.ts";

export type PendingConflictEvent = {
  artists: string[];
  date: string;
  time?: string;
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function sameStoredArray(left: unknown, right: unknown): boolean {
  return Array.isArray(left) && Array.isArray(right) && sameConflictMultiset(left, right);
}

function readBoundCarouselConflictRow(
  event: { date?: unknown },
  fields: Record<string, unknown>,
  raw: Record<string, unknown>,
): Record<string, unknown> | null {
  if (raw._carouselContractVersion !== "carousel_evidence_v1" ||
      fields.extractionCarouselContractVersion !== raw._carouselContractVersion ||
      !Array.isArray(raw.schedule_entries) ||
      !Array.isArray(fields.carouselSourceRowIndexes) || fields.carouselSourceRowIndexes.length !== 1) return null;
  const index = fields.carouselSourceRowIndexes[0];
  if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= 64) return null;
  const row = asRecord(raw.schedule_entries[index]);
  const date = asRecord(row?.date_evidence);
  if (!row || !date || typeof row.source_text !== "string" || !row.source_text.trim() ||
      row.source_text !== fields.carouselSourceText ||
      !sameStoredArray(row.source_slide_indexes, fields.carouselSourceSlideIndexes) ||
      !sameStoredArray(row.poster_evidence, fields.carouselPosterEvidence) ||
      !sameStoredArray(row.text_evidence, fields.carouselTextEvidence) ||
      (date.resolved_date ? date.resolved_date !== event.date : date.exact_text !== fields.dateEvidenceText)) return null;
  return row;
}

/** Resolve the original conflict list from the exact retained carousel row or
 * the ordinary source-wide analysis. Unbound carousel conflicts fail closed. */
export function readBoundExtractionSourceConflicts(
  event: { date?: unknown },
  fields: Record<string, unknown>,
  raw: Record<string, unknown>,
): unknown {
  if (raw._carouselContractVersion !== "carousel_evidence_v1") return raw.source_conflicts;
  const row = readBoundCarouselConflictRow(event, fields, raw);
  if (row) return row.source_conflicts;
  const rows = raw.schedule_entries;
  const rowIndexes = fields.carouselSourceRowIndexes;
  // Coalesced rows do not provide one conflict scope. Keep their existing
  // no-conflict path only when each source row explicitly reported none.
  if (Array.isArray(rows) && Array.isArray(rowIndexes) && rowIndexes.length > 1 &&
      rowIndexes.every((index) => typeof index === "number" && Number.isSafeInteger(index) &&
        index >= 0 && index < 64 && Array.isArray(asRecord(rows[index])?.source_conflicts) &&
        (asRecord(rows[index])!.source_conflicts as unknown[]).length === 0)) return raw.source_conflicts;
  return null;
}

/**
 * Reclassify a verified cinema release claim without changing extraction or
 * occurrence facts. A separate receipt-fenced mutation persists this patch.
 */
function preparePendingConflictReclassification(
  event: PendingConflictEvent,
  mode: "cinema" | "benign",
): PendingSourceConflictReclassification {
  if (event.status !== "pending") {
    throw new Error("Only pending events can have source conflicts reclassified.");
  }
  const fields = parseRecord(event.normalizedFieldsJson);
  const raw = parseRecord(event.rawExtractionJson);
  const reported = fields.extractionSourceConflicts;
  const oldMaterial = fields.materialSourceConflicts;
  const oldBenign = fields.benignSourceConflicts;
  const rawConflicts = readBoundExtractionSourceConflicts(event, fields, raw);
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
    (mode === "cinema" ? !sameConflictMultiset(event.sourceConflictFields, ["date"])
      : !sameConflictMultiset(event.sourceConflictFields, [...new Set(oldMaterial.map((conflict) => conflict.field))])) ||
    fields.extractionIsEvent !== true ||
    raw.is_event !== true ||
    fields.dateEvidenceVerified !== true ||
    fields.timeEvidenceVerified !== true ||
    typeof fields.identityEvidenceVerified !== "boolean" ||
    (mode === "benign" && fields.identityEvidenceVerified !== true) ||
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
  const context = buildPendingSourceConflictContext(event, fields, raw);

  if (
    mode === "cinema" && !oldMaterial.every((conflict) =>
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

export function preparePendingCinemaSourceConflictReclassification(event: PendingConflictEvent): PendingSourceConflictReclassification {
  return preparePendingConflictReclassification(event, "cinema");
}

export function preparePendingSourceConflictReclassification(event: PendingConflictEvent): PendingSourceConflictReclassification {
  return preparePendingConflictReclassification(event, "benign");
}

export function buildPendingSourceConflictContext(
  event: { artists?: unknown; date?: unknown; time?: unknown; title?: unknown; venue?: unknown; sourceCaption?: unknown; sourcePostedAt?: unknown; rawExtractionJson?: unknown },
  fields: Record<string, unknown>, suppliedRaw?: Record<string, unknown>,
): EventEvidenceConflictContext {
  let raw = suppliedRaw ?? {};
  if (!suppliedRaw && typeof event.rawExtractionJson === "string") { try { raw = parseRecord(event.rawExtractionJson); } catch { raw = {}; } }
  const sourceCaption = typeof event.sourceCaption === "string" ? event.sourceCaption : "";
  const title = typeof event.title === "string" ? event.title : "";
  const date = typeof event.date === "string" ? event.date : "";
  const venue = typeof event.venue === "string" ? event.venue : "";
  const time = typeof event.time === "string" ? event.time : "";
  const carouselRow = readBoundCarouselConflictRow(event, fields, raw);
  const rowText = typeof carouselRow?.source_text === "string" ? carouselRow.source_text
    : typeof fields.rowSourceText === "string" ? fields.rowSourceText
    : typeof fields.splitSourceLine === "string" ? fields.splitSourceLine : "";
  const singleOccurrenceSource = carouselRow
    ? Boolean(date && (asRecord(carouselRow.date_evidence)?.resolved_date === date ||
      (fields.dateEvidenceVerified === true && fields.dateEvidenceResolvedDate === date &&
        fields.dateRangeExpanded !== true)))
    : raw._carouselContractVersion !== "carousel_evidence_v1" &&
      fields.splitEventTotal === 1 && fields.multiEventSplitDetected === false &&
      (!Array.isArray(raw.schedule_entries) || raw.schedule_entries.length <= 1);
  const scopedCaption = Array.isArray(carouselRow?.text_evidence)
    ? carouselRow.text_evidence.flatMap((item: unknown) => {
        const snippet = asRecord(item);
        if (snippet?.source !== "caption" || typeof snippet.text !== "string") return [];
        const text = snippet.text.normalize("NFC").replace(/\s+/gu, " ").trim();
        return text && sourceCaption.normalize("NFC").replace(/\s+/gu, " ").includes(text) ? [snippet.text] : [];
      }).join("\n")
    : sourceCaption;
  const posterTexts: string[] = [];
  const add = (value: unknown) => { if (typeof value === "string" && value.trim() && value.length <= 4096 && posterTexts.length < 64) posterTexts.push(value); };
  const readEvidence = (record: Record<string, unknown>) => {
    const timeEvidence = record.time_evidence;
    if (timeEvidence && typeof timeEvidence === "object" && !Array.isArray(timeEvidence) && (timeEvidence as Record<string, unknown>).source === "poster")
      add((timeEvidence as Record<string, unknown>).exact_text);
    if (Array.isArray(record.poster_evidence)) for (const item of record.poster_evidence)
      if (item && typeof item === "object" && !Array.isArray(item)) add((item as Record<string, unknown>).text);
  };
  const rows = Array.isArray(raw.schedule_entries) && raw.schedule_entries.length <= 64 ? raw.schedule_entries : [];
  const matchedRows = rowText ? rows.map(asRecord).filter((row) => row?.source_text === rowText) : [];
  const matchingRow = matchedRows.length === 1 ? matchedRows[0] : null;
  if (carouselRow && fields.extractionMode !== "caption_only") {
    readEvidence(carouselRow);
  } else if (matchingRow && fields.extractionMode !== "caption_only" &&
      matchingRow.title === title && matchingRow.venue === venue &&
      asRecord(matchingRow.date_evidence)?.resolved_date === date && matchingRow.time === time &&
      Array.isArray(matchingRow.artists) && Array.isArray(event.artists) &&
      sameConflictMultiset(matchingRow.artists, event.artists)) {
    readEvidence(matchingRow);
  }
  if (!carouselRow && singleOccurrenceSource && fields.extractionMode !== "caption_only") {
    readEvidence(raw);
    const confirmations = raw.field_confirmation;
    if (confirmations && typeof confirmations === "object" && !Array.isArray(confirmations))
      for (const value of Object.values(confirmations as Record<string, unknown>)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const snippets = (value as Record<string, unknown>).evidence_snippets;
        if (Array.isArray(snippets)) for (const snippet of snippets)
          if (snippet && typeof snippet === "object" && !Array.isArray(snippet) && (snippet as Record<string, unknown>).source === "poster")
            add((snippet as Record<string, unknown>).text);
      }
  }
  const role = fields.sourceAccountRole;
  const supplement = fields.focusedSourceConflictReview;
  if (supplement && typeof supplement === "object" && !Array.isArray(supplement)) {
    const marker = supplement as Record<string, unknown>;
    if (marker.policyVersion === 1 && typeof marker.reviewId === "string" && typeof marker.reviewKey === "string" &&
        typeof marker.contextFingerprint === "string" && Array.isArray(marker.posterTexts) && marker.posterTexts.length <= 64) {
      for (const value of marker.posterTexts) if (value && typeof value === "object" && !Array.isArray(value)) add((value as Record<string, unknown>).text);
    }
  }
  // Database admission and public grounding independently reload any focused
  // review marker. The marker alone never establishes persisted source proof.
  return {
    artists: Array.isArray(event.artists) ? event.artists.filter((value): value is string => typeof value === "string") : [],
    dateEvidenceVerified: fields.dateEvidenceVerified === true, identityEvidenceVerified: fields.identityEvidenceVerified === true,
    resolvedDate: date, selectedTitle: title, selectedVenue: venue, selectedTime: time,
    timeEvidenceVerified: fields.timeEvidenceVerified === true && fields.time === time, singleOccurrenceSource,
    sourceAccountName: typeof fields.sourceAccountName === "string" ? fields.sourceAccountName : "",
    sourceAccountRole: role === "venue" || role === "promoter" || role === "unknown" ? role : undefined,
    sourceCaption: scopedCaption,
    sourcePostedAt: typeof event.sourcePostedAt === "string" ? event.sourcePostedAt : undefined,
    venueEvidenceVerified: fields.venueEvidenceVerified === true, occurrenceSourceText: rowText, sourcePosterTexts: [...new Set(posterTexts)],
    sourceWideScheduleConflicts: raw._carouselContractVersion !== "carousel_evidence_v1" && rows.length > 1 && Array.isArray(raw.source_conflicts),
    sourceScheduleRows: rows.flatMap((row) => {
      const text = asRecord(row)?.source_text;
      return typeof text === "string" && text.trim() && text.length <= 4096 ? [text] : [];
    }),
  };
}
