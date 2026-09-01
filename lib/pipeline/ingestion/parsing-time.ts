import { type ExtractedEventData } from "@/lib/ai/extract-event-data";
import { type EventTimeProvenance, type EventTimeSource, extractEventTimeEvidenceFromText, extractEventTimeFromText, isTbdEventTime } from "@/lib/events/event-time";
import { type EventConsistencyIssue, sanitizeTimeAgainstDate } from "@/lib/events/event-validation";
import { normalizeConfidenceScore } from "@/lib/utils/confidence";
import type { EventTimeEvidence, EventTimeEvidenceSource, SplitEventCandidate } from "@/lib/pipeline/ingestion/contracts";
import { stripDoorOpeningClockValues } from "@/lib/pipeline/ingestion/parsing-source-evidence";
import { normalizeString } from "@/lib/pipeline/ingestion/values";

export function findEventTimeEvidence(
  candidates: Array<{ source: EventTimeEvidenceSource; text: string | null | undefined }>,
): EventTimeEvidence | null {
  const seenText = new Set<string>();
  for (const candidate of candidates) {
    const text = candidate.text?.trim() ?? "";
    const dedupeKey = text.replace(/\s+/g, " ").toLocaleLowerCase();
    if (!text || seenText.has(dedupeKey)) {
      continue;
    }
    seenText.add(dedupeKey);

    const startTimeText = stripDoorOpeningClockValues(text);
    const extracted = extractEventTimeEvidenceFromText(startTimeText);
    if (extracted) {
      return {
        source: candidate.source,
        text: extracted.evidence,
        time: extracted.time,
      };
    }
  }

  return null;
}

export function resolveEventTimeFromExtractionAndEvidence(options: {
  rawDate: string;
  rawTime: string;
  textEvidence: Array<{ source: EventTimeEvidenceSource; text: string | null | undefined }>;
}): {
  issues: EventConsistencyIssue[];
  rawTime: string;
  time: string;
  timeEvidence: EventTimeEvidence | null;
  timeSource: EventTimeEvidenceSource | "extracted_time_tbd" | "extracted_time_unparsed" | null;
} {
  const sanitizedRawTime = sanitizeTimeAgainstDate(options.rawTime, options.rawDate);
  const issues: EventConsistencyIssue[] =
    options.rawTime && options.rawTime !== sanitizedRawTime ? ["time_is_date"] : [];
  const parsedExtractedTime = extractEventTimeFromText(sanitizedRawTime);
  if (parsedExtractedTime) {
    return {
      issues,
      rawTime: options.rawTime,
      time: parsedExtractedTime,
      timeEvidence: {
        source: "extracted_time",
        text: sanitizedRawTime,
        time: parsedExtractedTime,
      },
      timeSource: "extracted_time",
    };
  }

  const inferredTime = findEventTimeEvidence(options.textEvidence);
  if (inferredTime) {
    return {
      issues,
      rawTime: options.rawTime || inferredTime.text,
      time: inferredTime.time,
      timeEvidence: inferredTime,
      timeSource: inferredTime.source,
    };
  }

  return {
    issues,
    rawTime: options.rawTime,
    time: sanitizedRawTime,
    timeEvidence: null,
    timeSource: sanitizedRawTime
      ? isTbdEventTime(sanitizedRawTime)
        ? "extracted_time_tbd"
        : "extracted_time_unparsed"
      : null,
  };
}

export function mapModelEvidenceSource(value: string | null | undefined): EventTimeSource {
  const source = normalizeString(value).toLocaleLowerCase();
  if (source === "caption") return "caption";
  if (source === "poster") return "poster";
  if (source === "alt_text") return "alt_text";
  return "model";
}

export function buildTimeProvenance(options: {
  extracted: ExtractedEventData;
  resolution: ReturnType<typeof resolveEventTimeFromExtractionAndEvidence>;
}): EventTimeProvenance {
  const { resolution } = options;
  if (!extractEventTimeFromText(resolution.time) || isTbdEventTime(resolution.time)) {
    return {
      confidence: 0,
      evidenceText: null,
      source: "unknown",
      status: "unknown",
    };
  }

  if (resolution.timeSource === "extracted_time") {
    const confirmation = options.extracted.field_confirmation.start_time;
    const evidenceSnippets = confirmation.evidence_snippets
      .map((snippet) => ({ source: snippet.source, text: snippet.text.trim() }))
      .filter((snippet) => snippet.text.length > 0);
    const matchedSnippet = evidenceSnippets.find(
      (snippet) => extractEventTimeFromText(snippet.text) === resolution.time,
    );
    const confirmationEvidence = confirmation.evidence.trim();
    const confirmationEvidenceMatches =
      extractEventTimeFromText(confirmationEvidence) === resolution.time;
    const evidenceText =
      matchedSnippet?.text ||
      (confirmationEvidenceMatches
        ? confirmationEvidence
        : resolution.timeEvidence?.text || resolution.rawTime.trim() || null);
    const source = matchedSnippet
      ? mapModelEvidenceSource(matchedSnippet.source)
      : confirmationEvidenceMatches
        ? mapModelEvidenceSource(confirmation.found_in[0])
        : "model";

    return {
      confidence: normalizeConfidenceScore(confirmation.confidence) ?? 0.8,
      evidenceText,
      source,
      status: source === "model" ? "inferred" : "confirmed",
    };
  }

  const sourceByEvidence: Partial<Record<EventTimeEvidenceSource, EventTimeSource>> = {
    caption: "caption",
    description: "description",
    post_alt_text: "alt_text",
    source_caption: "model",
  };
  const confidenceBySource: Record<EventTimeSource, number> = {
    alt_text: 0.9,
    caption: 0.95,
    description: 0.85,
    model: 0.8,
    poster: 0.95,
    schedule_entry: 0.95,
    unknown: 0,
  };
  const source = resolution.timeEvidence
    ? sourceByEvidence[resolution.timeEvidence.source] ?? "model"
    : "model";

  return {
    confidence: confidenceBySource[source],
    evidenceText: resolution.timeEvidence?.text ?? (resolution.rawTime.trim() || null),
    source,
    status: "inferred",
  };
}

export function buildScheduleEntryTimeProvenance(entry: SplitEventCandidate): EventTimeProvenance {
  if (!entry.time) {
    return {
      confidence: 0,
      evidenceText: null,
      source: "unknown",
      status: "unknown",
    };
  }
  const evidence =
    extractEventTimeEvidenceFromText(entry.sourceLine) ??
    extractEventTimeEvidenceFromText(entry.rawTime);
  return {
    confidence: 0.95,
    evidenceText: evidence?.evidence ?? entry.rawTime?.trim() ?? entry.time,
    source: "schedule_entry",
    status: "confirmed",
  };
}

export function normalizeTicketPrice(price: string, currency: string): string {
  if (!price) {
    return currency;
  }

  if (!currency) {
    return price;
  }

  const searchablePrice = price.toLocaleLowerCase();
  const searchableCurrency = currency.toLocaleLowerCase();
  if (searchablePrice.includes(searchableCurrency)) {
    return price;
  }

  const hasCurrencyMarker =
    (/\b(?:eur|euro|euros)\b|\u20ac/i.test(searchablePrice) &&
      /\b(?:eur|euro|euros)\b|\u20ac/i.test(searchableCurrency)) ||
    (/\b(?:rsd|din|dinar|dinara)\b/i.test(searchablePrice) &&
      /\b(?:rsd|din|dinar|dinara)\b/i.test(searchableCurrency)) ||
    (/\b(?:usd|dollar|dollars)\b|\$/i.test(searchablePrice) &&
      /\b(?:usd|dollar|dollars)\b|\$/i.test(searchableCurrency)) ||
    (/\b(?:gbp|pound|pounds)\b|\u00a3/i.test(searchablePrice) &&
      /\b(?:gbp|pound|pounds)\b|\u00a3/i.test(searchableCurrency));

  return hasCurrencyMarker ? price : `${price} ${currency}`.trim();
}
