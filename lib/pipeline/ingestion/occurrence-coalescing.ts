import { type ExtractedEventData } from "@/lib/ai/extract-event-data";
import { buildNightlifeLineupCoalescingPlan, type NightlifeLineupSource } from "@/lib/events/nightlife-lineup-coalescing";
import { toSearchableText } from "@/lib/pipeline/venue-normalization";
import { type InstagramScrapedPost } from "@/lib/scraper/instagram-scraper";
import { canonicalizeEventType } from "@/lib/taxonomy/venue-types";
import type { EventVariant } from "@/lib/pipeline/ingestion/contracts";
import { escapeRegExp } from "@/lib/pipeline/ingestion/parsing-date";
import { formatArtistTitleList, isMeaninglessEventTitle } from "@/lib/pipeline/ingestion/parsing-event-text";
import { buildSplitEventDescription } from "@/lib/pipeline/ingestion/parsing-schedule";
import { extractionEvidenceAppearsInPersistedSource, isVerifiedTimeEvidence } from "@/lib/pipeline/ingestion/structured-fact-verification";
import { normalizeString } from "@/lib/pipeline/ingestion/values";

export function coalesceNightlifeLineupEventVariants(options: {
  variants: EventVariant[];
  extracted: ExtractedEventData;
  verifiedSharedTime: boolean;
  post: InstagramScrapedPost;
  hasPoster: boolean;
}): EventVariant[] {
  if (
    normalizeString(options.extracted.extraction_contract_version) !== "event_evidence_v2" ||
    canonicalizeEventType(options.extracted.category) !== "nightlife" ||
    options.variants.length < 2
  ) {
    return options.variants;
  }

  const groups = new Map<string, Array<{ index: number; variant: EventVariant }>>();
  for (const [index, variant] of options.variants.entries()) {
    const date = variant.dateNormalization.isoDate ?? "";
    const venue = toSearchableText(variant.venue);
    const key = `${date}\u0000${venue}`;
    const group = groups.get(key) ?? [];
    group.push({ index, variant });
    groups.set(key, group);
  }

  const replacementByIndex = new Map<number, EventVariant>();
  const consumedIndexes = new Set<number>();
  const resolveLineupSource = (variant: EventVariant): NightlifeLineupSource => {
    const sourceText = normalizeString(variant.splitSourceLine);
    if (
      sourceText &&
      extractionEvidenceAppearsInPersistedSource({
        evidenceText: sourceText,
        source: "caption",
        post: options.post,
        hasPoster: options.hasPoster,
      })
    ) {
      return "caption";
    }
    if (
      sourceText &&
      extractionEvidenceAppearsInPersistedSource({
        evidenceText: sourceText,
        source: "alt_text",
        post: options.post,
        hasPoster: options.hasPoster,
      })
    ) {
      return "alt_text";
    }
    return variant.splitSource === "caption_schedule"
      ? "caption"
      : variant.splitSource === "poster_schedule"
        ? "poster"
        : variant.splitSource === "alt_text_schedule"
          ? "alt_text"
          : variant.timeEvidence.source;
  };
  for (const group of groups.values()) {
    const plan = buildNightlifeLineupCoalescingPlan({
      eventType: "nightlife",
      sourceConflictCount: options.extracted.source_conflicts.length,
      sharedTime: {
        value: normalizeString(options.extracted.shared_schedule_context.time.value),
        verified: options.verifiedSharedTime,
      },
      candidates: group.map(({ index, variant }) => ({
        id: String(index),
        title: variant.title,
        date: variant.dateNormalization.isoDate ?? "",
        time: variant.time,
        venue: variant.venue,
        artists: variant.artists,
        sourceText: variant.splitSourceLine ?? "",
        source: resolveLineupSource(variant),
        sourcePostIdentity:
          normalizeString(options.post.postId) ||
          normalizeString(options.post.instagramPostUrl),
        timeEvidenceText: variant.timeEvidence.exact_text,
        timeEvidenceVerified: isVerifiedTimeEvidence({
          evidence: variant.timeEvidence,
          resolvedStartTime: variant.time || null,
          post: options.post,
          hasPoster: options.hasPoster,
        }),
        timeEvidenceKind: variant.timeEvidence.status,
      })),
    });
    if (!plan) continue;

    const ordered = plan.candidateIds.map((id) => group.find(({ index }) => String(index) === id)!);
    const first = ordered[0]?.variant;
    if (!first) continue;
    const usesSharedTimetable = plan.timingMode === "shared_timetable";
    const sharedTimeSource = options.extracted.shared_schedule_context.time.source;
    const sharedTimeEvidence = normalizeString(
      options.extracted.shared_schedule_context.time.evidence,
    );
    const coalesced: EventVariant = {
      ...first,
      title: plan.title,
      titleSource: first.splitSource ?? first.titleSource,
      titleUsedFallback: false,
      titleDerivedFromContext: false,
      titleContextCandidate: null,
      time: plan.time,
      rawTime: usesSharedTimetable
        ? normalizeString(options.extracted.shared_schedule_context.time.value)
        : first.rawTime,
      timeEvidence: usesSharedTimetable
        ? {
            status: "start_time_stated",
            exact_text: normalizeString(
              options.extracted.shared_schedule_context.time.value,
            ),
            source: sharedTimeSource,
          }
        : first.timeEvidence,
      timeProvenance: usesSharedTimetable
        ? {
            confidence: 0.95,
            evidenceText: sharedTimeEvidence,
            source:
              sharedTimeSource === "alt_text"
                ? "alt_text"
                : sharedTimeSource === "caption"
                  ? "caption"
                  : "poster",
            status: "confirmed",
          }
        : first.timeProvenance,
      consistencyIssues: [
        ...new Set(ordered.flatMap(({ variant }) => variant.consistencyIssues)),
      ],
      artists: plan.artists,
      artistsWereSanitized: ordered.some(
        ({ variant }) => variant.artistsWereSanitized,
      ),
      description: plan.description,
      splitSourceLine: usesSharedTimetable
        ? [sharedTimeEvidence, ...plan.sourceTexts].filter(Boolean).join("\n")
        : first.splitSourceLine,
      occurrencePlanUnverified: ordered.some(
        ({ variant }) => variant.occurrencePlanUnverified,
      ),
      lineupScheduleCoalesced: true,
      lineupScheduleTimingMode: plan.timingMode,
      lineupSourceEvidence: plan.slots.map((slot) => ({
        text: slot.sourceText,
        source: slot.source,
      })),
      lineupSlots: plan.slots,
    };
    const firstIndex = Math.min(...ordered.map(({ index }) => index));
    replacementByIndex.set(firstIndex, coalesced);
    for (const { index } of ordered) consumedIndexes.add(index);
  }

  if (consumedIndexes.size === 0) return options.variants;
  return options.variants.flatMap((variant, index) => {
    const replacement = replacementByIndex.get(index);
    if (replacement) return [replacement];
    return consumedIndexes.has(index) ? [] : [variant];
  });
}

export function repairDescriptionForArtistFallback(options: {
  description: string;
  previousTitle: string;
  artists: string[];
  eventType: string;
  venue: string | null;
}): string {
  const description = normalizeString(options.description);
  const previousTitle = normalizeString(options.previousTitle);
  const artistTitle = formatArtistTitleList(options.artists);
  if (!artistTitle) {
    return description;
  }

  const fallbackDescription = buildSplitEventDescription(
    options.eventType,
    options.venue,
    options.artists,
  ) ?? description;
  if (!description) {
    return fallbackDescription;
  }
  if (!isMeaninglessEventTitle(previousTitle)) {
    return description;
  }

  const pattern = escapeRegExp(previousTitle).replace(/\s+/gu, "\\s+");
  const repaired = description
    .replace(new RegExp(pattern, "giu"), artistTitle)
    .replace(/\s+/gu, " ")
    .trim();
  return repaired && repaired !== description ? repaired : fallbackDescription;
}
