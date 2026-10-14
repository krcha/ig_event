import { sha256Hex } from "../domain/reconciliation/evidence-digest.ts";
import { eventEvidenceConflictIsBenign } from "./event-evidence-conflict-policy.ts";
import { buildPendingSourceConflictContext } from "./pending-source-conflict-reclassification.ts";
export const FOCUSED_SOURCE_CONFLICT_POLICY = "focused-source-conflict-review:v1";
export const FOCUSED_SOURCE_CONFLICT_PROTOCOL = "openai-responses:focused-source-conflict-review:max_output_tokens_4096:v1";
export const FOCUSED_SOURCE_CONFLICT_DAILY_LIMIT = 20;
export const FOCUSED_SOURCE_CONFLICT_HARD_DAILY_LIMIT = 50;
export const FOCUSED_SOURCE_CONFLICT_MAX_IMAGES = 8;
export const FOCUSED_SOURCE_CONFLICT_MAX_CONFLICTS = 8;
export type FocusedSourceConflictImage = { slideIndex: number; sourceUrl: string; url: string; checksumSha256: string; storageId: string };
export type FocusedSourceConflictEvent = { id: string; updatedAt: number; status: "pending"; title: string; date: string; time: string; venue: string; artists: string[]; rawExtractionJson: string; normalizedFieldsJson: string; sourceCaption: string; sourcePostedAt?: string; sourceConflictFields: string[] };
export type FocusedSourceConflictReviewContext = { scrapedPostId: string; sourceRevision: number; sourceIdentity: string; sourceFingerprint: string; instagramPostUrl: string; caption: string; altText: string; locationName: string; postedAt: string; analysisResultJson: string; retainedImages: FocusedSourceConflictImage[]; events: FocusedSourceConflictEvent[] };
export type FocusedSourceConflictResolution = { event_id: string; conflict_index: number; field: "date" | "time" | "venue" | "title" | "artists"; disposition: "benign_same_fact" | "separate_context" | "extraction_error" | "unresolved"; selected_value: string; poster_quote: string; caption_quote: string; slide_index: number | null; reason: string };
export type FocusedSourceConflictReviewResult = { policy_version: typeof FOCUSED_SOURCE_CONFLICT_POLICY; events: Array<{ event_id: string; selected_facts: { title: string; date: string; time: string; venue: string; artists: string[] }; resolutions: FocusedSourceConflictResolution[] }> };
export type FocusedSourceConflictValidation = { eventId: string; expectedUpdatedAt: number; disposition: "deterministic_reclassification" | "requires_saved_post_reprocess" | "unresolved"; reason: string; resolvedConflictIndexes: number[] };
export function buildFocusedSourceConflictReviewKey(context: FocusedSourceConflictReviewContext): string {
  return `focused-source-conflict:${sha256Hex(JSON.stringify({ policy: FOCUSED_SOURCE_CONFLICT_POLICY, sourceId: context.scrapedPostId,
    sourceRevision: context.sourceRevision, sourceIdentity: context.sourceIdentity, sourceFingerprint: context.sourceFingerprint,
    caption: context.caption, altText: context.altText, locationName: context.locationName, postedAt: context.postedAt, analysisResultJson: context.analysisResultJson,
    images: context.retainedImages.map(({ slideIndex, sourceUrl, checksumSha256, storageId }) => ({ slideIndex, sourceUrl, checksumSha256, storageId })) }))}`;
}
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function parseRecord(value: string): Record<string, unknown> { const parsed = record(JSON.parse(value) as unknown); if (!parsed) throw new Error("Focused review requires object evidence."); return parsed; }
function boundedString(value: unknown, maximum = 500): value is string { return typeof value === "string" && value.length <= maximum; }
function sourceConflicts(event: FocusedSourceConflictEvent) {
  const conflicts = parseRecord(event.normalizedFieldsJson).extractionSourceConflicts;
  if (!Array.isArray(conflicts) || conflicts.length < 1 || conflicts.some((value) => {
    const c = record(value); return !c || !["date", "time", "venue", "title", "artists"].includes(String(c.field)) ||
      !boundedString(c.poster_value, 2000) || !boundedString(c.caption_value, 2000) || !boundedString(c.reason, 4000);
  })) throw new Error("Focused review requires persisted structured conflicts.");
  return conflicts as import("./event-evidence-conflict-policy.ts").EventEvidenceSourceConflict[];
}
export function buildFocusedSourceConflictContextFingerprint(context: FocusedSourceConflictReviewContext): string {
  return sha256Hex(JSON.stringify(context.events.map((event) => ({ id: event.id, title: event.title, date: event.date, time: event.time,
    venue: event.venue, artists: event.artists, rawExtractionJson: event.rawExtractionJson, sourceCaption: event.sourceCaption,
    sourcePostedAt: event.sourcePostedAt ?? "", conflicts: sourceConflicts(event) })).sort((a, b) => a.id.localeCompare(b.id))));
}

export function assertFocusedSourceConflictReviewContext(context: FocusedSourceConflictReviewContext): void {
  if (!context.scrapedPostId || !context.sourceIdentity || !context.sourceFingerprint || !Number.isSafeInteger(context.sourceRevision) ||
      context.sourceRevision < 1 || context.caption.length > 40000 || context.altText.length > 40000 || context.analysisResultJson.length > 512000 ||
      context.events.length < 1 || context.events.length > 8 || context.retainedImages.length < 1 || context.retainedImages.length > 8)
    throw new Error("Focused review exceeds its bounded source contract.");
  const slides = new Set<number>(); let previous = -1;
  for (const image of context.retainedImages) {
    if (!Number.isSafeInteger(image.slideIndex) || image.slideIndex < 0 || image.slideIndex > 19 || image.slideIndex <= previous ||
        slides.has(image.slideIndex) || !/^[a-f0-9]{64}$/u.test(image.checksumSha256) || !image.storageId ||
        !/^https?:\/\//u.test(image.url) || !/^https?:\/\//u.test(image.sourceUrl)) throw new Error("Focused review requires ordered retained image bindings.");
    slides.add(image.slideIndex); previous = image.slideIndex;
  }
  const ids = new Set<string>(); let count = 0;
  for (const event of context.events) {
    if (!boundedString(event.id, 200) || !event.id || ids.has(event.id) || event.status !== "pending" || event.sourceCaption !== context.caption || !Number.isSafeInteger(event.updatedAt) ||
        ![event.title, event.date, event.time, event.venue].every((value) => boundedString(value)) || event.artists.length > 40 ||
        !event.artists.every((artist) => boundedString(artist, 200)) ||
        event.rawExtractionJson !== context.analysisResultJson || event.rawExtractionJson.length > 512000 || event.normalizedFieldsJson.length > 512000)
      throw new Error("Focused review event is not bound to its pending source.");
    ids.add(event.id); count += sourceConflicts(event).length;
  }
  if (count > 8) throw new Error("Focused review cannot truncate conflicts.");
}
export function parseFocusedSourceConflictReviewResult(value: unknown): FocusedSourceConflictReviewResult {
  const root = record(value);
  if (!root || root.policy_version !== FOCUSED_SOURCE_CONFLICT_POLICY || !Array.isArray(root.events) || root.events.length < 1 || root.events.length > 8)
    throw new Error("Focused review response has invalid schema.");
  for (const value of root.events) {
    const event = record(value), facts = record(event?.selected_facts);
    if (!event || !boundedString(event.event_id, 200) || !facts || !["title", "date", "time", "venue"].every((field) => boundedString(facts[field])) ||
        !Array.isArray(facts.artists) || facts.artists.length > 40 || !facts.artists.every((artist) => boundedString(artist, 200)) ||
        !Array.isArray(event.resolutions) || event.resolutions.length < 1 || event.resolutions.length > 8) throw new Error("Focused review response has invalid facts.");
    for (const value of event.resolutions) {
      const r = record(value);
      if (!r || r.event_id !== event.event_id || !Number.isSafeInteger(r.conflict_index) || Number(r.conflict_index) < 0 ||
          !["date", "time", "venue", "title", "artists"].includes(String(r.field)) ||
          !["benign_same_fact", "separate_context", "extraction_error", "unresolved"].includes(String(r.disposition)) ||
          !["selected_value", "poster_quote", "caption_quote", "reason"].every((field) => boundedString(r[field], field === "reason" ? 1200 : 500)) ||
          !(r.slide_index === null || Number.isSafeInteger(r.slide_index) && Number(r.slide_index) >= 0 && Number(r.slide_index) <= 19))
        throw new Error("Focused review response has invalid evidence.");
    }
  }
  return value as FocusedSourceConflictReviewResult;
}
function selectedValue(event: FocusedSourceConflictEvent, field: string): string {
  return field === "artists" ? event.artists.join(" | ") : String(event[field as "title" | "date" | "time" | "venue"]);
}
function quoteContainsClaim(quote: string, claim: string): boolean {
  const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
  const needle = normalize(claim); return needle.length >= 2 && normalize(quote).includes(needle);
}
function slideBelongsToEvent(event: FocusedSourceConflictEvent, index: number): boolean {
  const fields = parseRecord(event.normalizedFieldsJson), raw = parseRecord(event.rawExtractionJson);
  if (!fields.extractionCarouselContractVersion && !raw._carouselContractVersion) return index === 0;
  const rows = raw.schedule_entries, rowIndex = Number(fields.splitEventIndex) - 1;
  const row = Array.isArray(rows) && Number.isInteger(rowIndex) ? record(rows[rowIndex]) : null;
  return Boolean(row && Array.isArray(row.source_slide_indexes) && row.source_slide_indexes.includes(index) &&
    JSON.stringify(row.source_conflicts) === JSON.stringify(sourceConflicts(event)));
}
/** Only a completed server review tied to the exact retained images can supply reread quotes. */
export function validateFocusedSourceConflictReviewResult(
  context: FocusedSourceConflictReviewContext, result: FocusedSourceConflictReviewResult,
): FocusedSourceConflictValidation[] {
  assertFocusedSourceConflictReviewContext(context);
  const parsed = parseFocusedSourceConflictReviewResult(result), ids = new Set(context.events.map((event) => event.id));
  if (parsed.events.length !== ids.size || new Set(parsed.events.map((event) => event.event_id)).size !== ids.size ||
      parsed.events.some((event) => !ids.has(event.event_id))) throw new Error("Focused review must classify each submitted event once.");
  return context.events.map((event) => {
    const reviewed = parsed.events.find((candidate) => candidate.event_id === event.id)!, conflicts = sourceConflicts(event);
    const base = { eventId: event.id, expectedUpdatedAt: event.updatedAt }, indexes = new Set(reviewed.resolutions.map((r) => r.conflict_index));
    if (reviewed.resolutions.length !== conflicts.length || indexes.size !== conflicts.length ||
        reviewed.resolutions.some((r) => conflicts[r.conflict_index]?.field !== r.field)) throw new Error("Focused review must classify each original conflict once.");
    const facts = reviewed.selected_facts;
    if (facts.title !== event.title || facts.date !== event.date || facts.time !== event.time || facts.venue !== event.venue ||
        JSON.stringify(facts.artists) !== JSON.stringify(event.artists) || reviewed.resolutions.some((r) => r.selected_value !== selectedValue(event, r.field)))
      return { ...base, disposition: "requires_saved_post_reprocess", reason: "The reread proposes changed public facts; normal saved-post processing must verify them.", resolvedConflictIndexes: [] };
    const fields = parseRecord(event.normalizedFieldsJson), raw = parseRecord(event.rawExtractionJson);
    const original = buildPendingSourceConflictContext(event, fields, raw), resolved: number[] = [];
    for (const resolution of reviewed.resolutions) {
      const conflict = conflicts[resolution.conflict_index];
      if (resolution.disposition === "unresolved" || resolution.disposition === "extraction_error" || !resolution.poster_quote ||
          !resolution.caption_quote || resolution.slide_index === null || !context.caption.includes(resolution.caption_quote) ||
          !context.retainedImages.some((image) => image.slideIndex === resolution.slide_index) || !slideBelongsToEvent(event, resolution.slide_index) ||
          !quoteContainsClaim(resolution.poster_quote, conflict.poster_value) || !quoteContainsClaim(resolution.caption_quote, conflict.caption_value)) continue;
      // New image observations must name this occurrence on both sources.
      // A short clock quote must not borrow a sibling event's doors time.
      const proofContext = { ...original,
        ...(conflict.field === "time" ? { singleOccurrenceSource: false,
          occurrenceSourceText: original.singleOccurrenceSource ? context.caption : original.occurrenceSourceText } : {}),
        sourcePosterTexts: [...(original.sourcePosterTexts ?? []), ...resolution.poster_quote.split(/\n/u)] };
      if (eventEvidenceConflictIsBenign(conflict, proofContext)) resolved.push(resolution.conflict_index);
    }
    return { ...base, disposition: resolved.length === conflicts.length ? "deterministic_reclassification" : "unresolved",
      reason: resolved.length === conflicts.length ? "Source quotes support unchanged facts and every original conflict passes deterministic policy."
        : "The reread did not establish deterministic source proof for every conflict.", resolvedConflictIndexes: resolved };
  });
}
export function buildFocusedSourceConflictReviewSupplement(context: FocusedSourceConflictReviewContext, result: FocusedSourceConflictReviewResult, eventId: string):
  { posterTexts: Array<{ slideIndex: number; text: string }>; captionQuotes: string[] } | null {
  const validated = validateFocusedSourceConflictReviewResult(context, result).find((item) => item.eventId === eventId);
  if (validated?.disposition !== "deterministic_reclassification") return null;
  const reviewed = result.events.find((item) => item.event_id === eventId)!;
  return { posterTexts: reviewed.resolutions.flatMap((r) => r.poster_quote.split(/\n/u).map((text) => ({ slideIndex: r.slide_index!, text }))), captionQuotes: reviewed.resolutions.map((r) => r.caption_quote) };
}
