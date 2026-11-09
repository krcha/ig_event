import { extractEventTimeFromText, normalizeEventTime } from "./event-time";

export type ConfirmedEventSchemaFacts = {
  title: string;
  date: string;
  venueId: string;
  time?: string;
};

type EvidenceEvent = {
  title: string;
  date: string;
  venue: string;
  venueId?: string;
  normalizedFieldsJson?: string;
  sourceConflictFields?: readonly string[];
  dateEvidenceResolvedDate?: string;
  dateEvidenceSource?: string;
  time?: string;
  timeStatus?: string;
  timeSource?: string;
  timeEvidenceKind?: string;
  timeEvidenceText?: string;
};

export function readEventEvidenceRecord(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function getConfirmedEventSchemaFacts(
  event: EvidenceEvent,
  publicVenueId: string | undefined,
): ConfirmedEventSchemaFacts | undefined {
  if (!publicVenueId || publicVenueId !== event.venueId) return;
  const facts = readEventEvidenceRecord(event.normalizedFieldsJson);
  if (
    facts.sourceGroundingTitleVerified !== true ||
    facts.titleUsedFallback === true ||
    facts.titleDerivedFromContext === true ||
    facts.dateEvidenceVerified !== true ||
    facts.venueEvidenceVerified !== true ||
    facts.title !== event.title ||
    facts.normalizedDate !== event.date ||
    facts.normalizedVenue !== event.venue ||
    facts.dateEvidenceResolvedDate !== event.date ||
    event.dateEvidenceResolvedDate !== event.date ||
    !["caption", "poster", "alt_text"].includes(event.dateEvidenceSource ?? "") ||
    (event.sourceConflictFields?.length ?? 0) > 0 ||
    (typeof facts.materialSourceConflictCount === "number" && facts.materialSourceConflictCount > 0)
  ) return;

  const start = normalizeEventTime(event.time).startLabel;
  const time = start &&
    event.timeStatus === "confirmed" &&
    event.timeEvidenceKind === "start_time_stated" &&
    facts.timeEvidenceVerified === true &&
    facts.sourceConflictProvisionalStart === undefined &&
    typeof facts.time === "string" &&
    normalizeEventTime(facts.time).startLabel === start &&
    normalizeEventTime(extractEventTimeFromText(event.timeEvidenceText)).startLabel === start &&
    ["caption", "poster", "alt_text", "schedule_entry"].includes(event.timeSource ?? "")
    ? start : undefined;
  return { title: event.title, date: event.date, venueId: publicVenueId, ...(time ? { time } : {}) };
}
