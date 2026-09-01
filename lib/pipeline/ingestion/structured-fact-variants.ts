import type { ExtractedEventData } from "@/lib/ai/extract-event-data";
import type { EventTimeProvenance } from "@/lib/events/event-time";
import { buildUnnamedScheduleFallbackTitle, venueValueAppearsInEventEvidence } from "@/lib/events/unnamed-schedule-fallback";
import type { IngestionVenueResolver } from "@/lib/domain/venues/index";
import { resolveIngestionVenue } from "@/lib/domain/venues/index";
import type { DateNormalization, EventDateEvidenceSource, EventVariant, SplitEventCandidate } from "@/lib/pipeline/ingestion/contracts";
import { coalesceNightlifeLineupEventVariants } from "@/lib/pipeline/ingestion/occurrence-coalescing";
import { normalizeDateEvidenceForOccurrence } from "@/lib/pipeline/ingestion/parsing-date";
import { buildMeaningfulEventTitle, isMeaninglessEventTitle } from "@/lib/pipeline/ingestion/parsing-event-text";
import type { normalizeEventTitle } from "@/lib/pipeline/ingestion/parsing-event-title";
import { buildSplitEventDescription } from "@/lib/pipeline/ingestion/parsing-schedule";
import { buildScheduleEntryTimeProvenance, buildTimeProvenance, type resolveEventTimeFromExtractionAndEvidence } from "@/lib/pipeline/ingestion/parsing-time";
import { extractionEvidenceAppearsInPersistedSource, hasVerifiedSharedScheduleContext } from "@/lib/pipeline/ingestion/structured-fact-verification";
import { normalizeString } from "@/lib/pipeline/ingestion/values";
import { normalizeVenueComparableText, type VenueNormalization } from "@/lib/pipeline/venue-normalization";
import type { InstagramScrapedPost } from "@/lib/scraper/instagram-scraper";

type BuildStructuredFactVariantsInput = {
  baseDescription: string;
  baseTitle: string;
  baseTitleSource: string;
  baseTitleUsedFallback: boolean;
  candidateDates: string[];
  canonicalVenueEvidenceSource: "evidence_handle" | "evidence_name" | null;
  configuredVenueLocation: string;
  configuredVenueName: string;
  dateNormalization: DateNormalization;
  effectiveNormalizedVenue: string;
  eventType: string;
  extracted: ExtractedEventData;
  extractedArtists: string[];
  extractedTimeIssues: EventVariant["consistencyIssues"];
  extractedTimeResolution: ReturnType<typeof resolveEventTimeFromExtractionAndEvidence>;
  independentPostTextEvidence: string;
  ingestionVenueResolver: IngestionVenueResolver;
  normalizedSourceHandle: string;
  normalizedVenue: string;
  options: { preserveExplicitDateEvidenceRelativeFlag?: boolean };
  post: InstagramScrapedPost;
  rawExtractedTime: string;
  rawModelVenue: string;
  selectedImageUrl: string | null;
  sourceRole?: "venue" | "promoter" | "unknown";
  splitEventCandidates: SplitEventCandidate[];
  time: string;
  titleNormalization: ReturnType<typeof normalizeEventTitle>;
  trustedVenueSource: boolean;
  usesSplitEventCandidates: boolean;
  usesStructuredEvidence: boolean;
  venueNormalization: VenueNormalization;
};

export function buildStructuredFactVariants(input: BuildStructuredFactVariantsInput): {
  eventVariants: EventVariant[];
  verifiedSharedTime: boolean;
  verifiedSharedVenue: boolean;
} {
  const {
    baseDescription, baseTitle, baseTitleSource, baseTitleUsedFallback, candidateDates,
    canonicalVenueEvidenceSource, configuredVenueLocation, configuredVenueName, dateNormalization,
    effectiveNormalizedVenue, eventType, extracted, extractedArtists, extractedTimeIssues,
    extractedTimeResolution, independentPostTextEvidence, ingestionVenueResolver, normalizedSourceHandle,
    normalizedVenue, options, post, rawExtractedTime, rawModelVenue, selectedImageUrl, sourceRole,
    splitEventCandidates, time, titleNormalization, trustedVenueSource, usesSplitEventCandidates,
    usesStructuredEvidence, venueNormalization,
  } = input;
  const hasPosterEvidence = Boolean(selectedImageUrl);
  const verifiedSharedVenue = hasVerifiedSharedScheduleContext(
    extracted.shared_schedule_context.venue,
    post,
    hasPosterEvidence,
    "venue",
  );
  const verifiedSharedTime = hasVerifiedSharedScheduleContext(
    extracted.shared_schedule_context.time,
    post,
    hasPosterEvidence,
    "time",
  );
  const sharedVenueValue = verifiedSharedVenue
    ? normalizeString(extracted.shared_schedule_context.venue.value)
    : "";
  const sharedVenueMatchesConfiguredLocation = Boolean(
    sourceRole === "venue" &&
      trustedVenueSource &&
      sharedVenueValue &&
      configuredVenueLocation &&
      normalizeVenueComparableText(sharedVenueValue) ===
        normalizeVenueComparableText(configuredVenueLocation),
  );
  const sharedTimeValue = verifiedSharedTime
    ? normalizeString(extracted.shared_schedule_context.time.value)
    : "";
  const rawEventVariants: EventVariant[] = usesSplitEventCandidates
    ? splitEventCandidates.map((entry) => {
        const variantArtists =
          entry.titleUsedFallback || (entry.artistsWereSanitized && entry.artists.length === 0)
            ? []
            : entry.artists.length > 0 || usesStructuredEvidence
              ? entry.artists
              : extractedArtists;
        const rowVenue = normalizeString(entry.venue);
        const rowVenueGrounded = Boolean(
          rowVenue &&
            venueValueAppearsInEventEvidence(rowVenue, entry.sourceLine),
        );
        const rowVenueMatchesConfiguredLocation = Boolean(
          sourceRole === "venue" &&
            trustedVenueSource &&
            rowVenue &&
            configuredVenueLocation &&
            normalizeVenueComparableText(rowVenue) ===
              normalizeVenueComparableText(configuredVenueLocation),
        );
        const canonicalRowVenue = rowVenue
          ? resolveIngestionVenue(ingestionVenueResolver, {
              allowSourceAccountFallback: false,
              postingProviderHandle: post.username,
              rawVenueClaim: rowVenue,
              sourceRole: "promoter",
            }).venue ?? rowVenue
          : "";
        const rowEvidenceSource: EventDateEvidenceSource =
          entry.source === "caption_schedule"
            ? "caption"
            : entry.source === "alt_text_schedule"
              ? "alt_text"
              : "poster";
        const rowCanonicalVenueNormalization = resolveIngestionVenue(
          ingestionVenueResolver,
          {
            allowSourceAccountFallback: false,
            postingProviderHandle: post.username,
            rawVenueClaim: "",
            locationName: "",
            evidenceTexts: [entry.sourceLine],
            sourceRole,
          },
        );
        const rowCanonicalVenueEvidenceSource =
          rowCanonicalVenueNormalization.source === "evidence_handle" ||
          rowCanonicalVenueNormalization.source === "evidence_name"
            ? rowCanonicalVenueNormalization.source
            : null;
        const rowCanonicalVenueEvidenceBound = Boolean(
          rowCanonicalVenueEvidenceSource &&
            rowCanonicalVenueNormalization.venue &&
            extractionEvidenceAppearsInPersistedSource({
              evidenceText: entry.sourceLine,
              source: rowEvidenceSource,
              post,
              hasPoster: hasPosterEvidence,
            }),
        );
        const rowCanonicalVenue = rowCanonicalVenueEvidenceBound
          ? rowCanonicalVenueNormalization.venue ?? ""
          : "";
        const singleOccurrencePostVenueGrounded = Boolean(
          splitEventCandidates.length === 1 &&
            rowVenue &&
            venueValueAppearsInEventEvidence(
              rowVenue,
              independentPostTextEvidence,
            ),
        );
        const rowVenueIsDirect = rowVenueGrounded || singleOccurrencePostVenueGrounded;
        const scopedRowCanonicalVenue =
          rowVenueIsDirect || sharedVenueValue ? "" : rowCanonicalVenue;
        const singleSplitCanonicalVenueEvidenceSource =
          splitEventCandidates.length === 1 && !rowVenueIsDirect
            ? canonicalVenueEvidenceSource
            : null;
        const variantCanonicalVenueEvidenceSource = scopedRowCanonicalVenue
          ? rowCanonicalVenueEvidenceSource
          : singleSplitCanonicalVenueEvidenceSource;
        const variantCanonicalVenueEvidenceHandle = scopedRowCanonicalVenue
          ? rowCanonicalVenueNormalization.evidenceHandle ?? null
          : singleSplitCanonicalVenueEvidenceSource === "evidence_handle"
            ? venueNormalization.evidenceHandle ?? null
            : null;
        const trustedVenueAccountFallback = Boolean(
          trustedVenueSource &&
            normalizedVenue &&
            (sourceRole === "venue" ||
              (splitEventCandidates.length === 1 &&
                canonicalRowVenue &&
                normalizeString(canonicalRowVenue) === normalizeString(normalizedVenue) &&
                (venueValueAppearsInEventEvidence(
                  configuredVenueName,
                  independentPostTextEvidence,
                ) ||
                  venueValueAppearsInEventEvidence(
                    normalizedSourceHandle,
                    independentPostTextEvidence,
                  )))),
        );
        const variantVenueRaw = usesStructuredEvidence
          ? rowVenueIsDirect
            ? rowVenueMatchesConfiguredLocation
              ? normalizedVenue
              : rowVenue
            : sharedVenueMatchesConfiguredLocation
              ? normalizedVenue
              : sharedVenueValue ||
                scopedRowCanonicalVenue ||
                (singleSplitCanonicalVenueEvidenceSource ? normalizedVenue : "") ||
                (trustedVenueAccountFallback ? normalizedVenue : "")
          : normalizedVenue;
        const variantVenue = variantVenueRaw
          ? resolveIngestionVenue(ingestionVenueResolver, {
              allowSourceAccountFallback: false,
              postingProviderHandle: post.username,
              rawVenueClaim: variantVenueRaw,
              sourceRole: "promoter",
            }).venue ?? variantVenueRaw
          : "";
        const groundedFallbackTitle = entry.titleUsedFallback
          ? buildUnnamedScheduleFallbackTitle({
              eventType,
              venue: variantVenue,
              isoDate: entry.normalizedDate.isoDate,
            })
          : entry.lineTitle;
        const variantTitle = buildMeaningfulEventTitle({
          title: groundedFallbackTitle,
          artists: variantArtists,
          eventType,
          venue: variantVenue,
          baseTitle,
        });
        const usesSplitScheduleTitle =
          normalizeString(variantTitle) !== normalizeString(baseTitle) &&
          !isMeaninglessEventTitle(variantTitle);
        const variantDescription =
          entry.description ??
          buildSplitEventDescription(eventType, variantVenue, variantArtists) ??
          (usesStructuredEvidence ? undefined : baseDescription);
        const derivedEvidenceSource: EventDateEvidenceSource =
          entry.source === "caption_schedule"
            ? "caption"
            : entry.source === "alt_text_schedule"
              ? "alt_text"
              : "poster";
        const rawVariantDateEvidence = entry.dateEvidence ?? {
          exact_text: entry.rawDate,
          source: derivedEvidenceSource,
          is_relative: false,
          resolved_date: entry.normalizedDate.isoDate ?? "",
        };
        const variantDateEvidence = normalizeDateEvidenceForOccurrence(
          rawVariantDateEvidence,
          entry.normalizedDate.isoDate,
          post.postedAt,
          options.preserveExplicitDateEvidenceRelativeFlag,
        );
        const useVerifiedSharedTime =
          usesStructuredEvidence &&
          verifiedSharedTime &&
          !entry.time &&
          (!entry.timeEvidence || entry.timeEvidence.status === "not_stated");
        const variantTimeEvidence = useVerifiedSharedTime
          ? {
              status: "start_time_stated" as const,
              exact_text: normalizeString(extracted.shared_schedule_context.time.evidence),
              source: extracted.shared_schedule_context.time.source,
            }
          : entry.timeEvidence ?? {
              status: entry.time ? "start_time_stated" as const : "not_stated" as const,
              exact_text: entry.rawTime ?? entry.time ?? "",
              source: derivedEvidenceSource,
            };
        const variantTime = usesStructuredEvidence
          ? variantTimeEvidence.status === "start_time_stated"
            ? entry.time || sharedTimeValue
            : ""
          : entry.time ?? "";
        return {
          title: entry.titleUsedFallback
            ? groundedFallbackTitle
            : usesSplitScheduleTitle
              ? variantTitle
              : baseTitle,
          titleSource: entry.titleUsedFallback
            ? "unnamed_schedule_fallback"
            : entry.titleSource ?? (usesSplitScheduleTitle ? entry.source : baseTitleSource),
          titleUsedFallback:
            entry.titleUsedFallback ??
            (usesSplitScheduleTitle ? false : baseTitleUsedFallback),
          titleDerivedFromContext:
            usesSplitScheduleTitle ? false : titleNormalization.source === "context_derived",
          titleContextCandidate:
            usesSplitScheduleTitle ? null : titleNormalization.contextCandidate,
          rawDate: entry.rawDate,
          dateNormalization: entry.normalizedDate,
          dateEvidence: variantDateEvidence,
          time: variantTime,
          rawTime: entry.rawTime ?? variantTime,
          timeEvidence: variantTimeEvidence,
          timeProvenance: useVerifiedSharedTime
            ? ({
                confidence: 0.95,
                evidenceText: normalizeString(
                  extracted.shared_schedule_context.time.evidence,
                ),
                source:
                  extracted.shared_schedule_context.time.source === "alt_text"
                    ? "alt_text"
                    : extracted.shared_schedule_context.time.source === "poster"
                      ? "poster"
                      : "caption",
                status: "confirmed",
              } satisfies EventTimeProvenance)
            : buildScheduleEntryTimeProvenance(entry),
          consistencyIssues: entry.consistencyIssues,
          artists: variantArtists,
          artistsWereSanitized: entry.artistsWereSanitized ?? false,
          description: variantDescription,
          venue: variantVenue,
          venueEvidenceValue:
            rowVenueIsDirect ? rowVenue : sharedVenueValue || scopedRowCanonicalVenue,
          canonicalVenueEvidenceSource: variantCanonicalVenueEvidenceSource,
          canonicalVenueEvidenceHandle: variantCanonicalVenueEvidenceHandle,
          splitSource: entry.source,
          splitSourceLine: entry.sourceLine,
          occurrencePlanUnverified: entry.occurrencePlanUnverified ?? false,
        };
      })
    : candidateDates.map((date) => ({
        title: baseTitle,
        titleSource: baseTitleSource,
        titleUsedFallback: baseTitleUsedFallback,
        titleDerivedFromContext: titleNormalization.source === "context_derived",
        titleContextCandidate: titleNormalization.contextCandidate,
        rawDate: normalizeString(extracted.date),
        dateNormalization: {
          ...dateNormalization,
          isoDate: date,
        } satisfies DateNormalization,
        dateEvidence: normalizeDateEvidenceForOccurrence(
          extracted.date_evidence,
          date,
          post.postedAt,
          options.preserveExplicitDateEvidenceRelativeFlag,
        ),
        time:
          !usesStructuredEvidence || extracted.time_evidence.status === "start_time_stated"
            ? time
            : "",
        rawTime: rawExtractedTime,
        timeEvidence: extracted.time_evidence,
        timeProvenance: buildTimeProvenance({
          extracted,
          resolution: extractedTimeResolution,
        }),
        consistencyIssues: extractedTimeIssues,
        artists: extractedArtists,
        artistsWereSanitized: false,
        description: baseDescription,
        venue: effectiveNormalizedVenue,
        venueEvidenceValue: rawModelVenue,
        canonicalVenueEvidenceSource,
        canonicalVenueEvidenceHandle:
          canonicalVenueEvidenceSource === "evidence_handle"
            ? venueNormalization.evidenceHandle ?? null
            : null,
        splitSource: null,
        splitSourceLine: null,
        occurrencePlanUnverified: false,
      }));
  const eventVariants = coalesceNightlifeLineupEventVariants({
    variants: rawEventVariants,
    extracted,
    verifiedSharedTime,
    post,
    hasPoster: hasPosterEvidence,
  });
  return { eventVariants, verifiedSharedTime, verifiedSharedVenue };
}
