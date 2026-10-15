import type { ExtractedEventData } from "@/lib/ai/extract-event-data";
import type { EventTimeProvenance } from "@/lib/events/event-time";
import { buildUnnamedScheduleFallbackTitle, venueValueAppearsInEventEvidence } from "@/lib/events/unnamed-schedule-fallback";
import type { IngestionVenueResolver } from "@/lib/domain/venues/index";
import { findPositiveLocativeVenueHandleEvidence, resolveIngestionVenue } from "@/lib/domain/venues/index";
import type { DateNormalization, EventDateEvidenceSource, EventVariant, SplitEventCandidate } from "@/lib/pipeline/ingestion/contracts";
import { coalesceNightlifeLineupEventVariants } from "@/lib/pipeline/ingestion/occurrence-coalescing";
import { normalizeDateEvidenceForOccurrence } from "@/lib/pipeline/ingestion/parsing-date";
import { buildMeaningfulEventTitle, extractContextualEventTitleCandidate, extractPostAltTextEvidence, isMeaninglessEventTitle, isUsableContextEventTitleCandidate, normalizeContextDerivedTitle } from "@/lib/pipeline/ingestion/parsing-event-text";
import type { normalizeEventTitle } from "@/lib/pipeline/ingestion/parsing-event-title";
import { buildSplitEventDescription } from "@/lib/pipeline/ingestion/parsing-schedule";
import { buildScheduleEntryTimeProvenance, buildTimeProvenance, type resolveEventTimeFromExtractionAndEvidence } from "@/lib/pipeline/ingestion/parsing-time";
import { artistIdentityAppearsInText, extractionEvidenceAppearsInPersistedSource, hasVerifiedSharedScheduleContext, isVerifiedEventVenueEvidence } from "@/lib/pipeline/ingestion/structured-fact-verification";
import { normalizeString } from "@/lib/pipeline/ingestion/values";
import { findScopedBranchVenueEvidence } from "@/lib/pipeline/ingestion/scoped-branch-venue-evidence";
import { canonicalizeVenueNameDetailed, normalizeVenueComparableText, toSearchableText, type VenueNormalization } from "@/lib/pipeline/venue-normalization";
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

function hasPhysicalVenuePlacement(venue: string, evidence: string): boolean {
  const venueTokens = toSearchableText(venue).split(" ").filter(Boolean);
  const evidenceTokens = toSearchableText(evidence).split(" ").filter(Boolean);
  if (venueTokens.length === 0 || evidenceTokens.length === 0) return false;
  const placementCues = new Set(["at", "in", "u", "kod", "na", "venue", "lokacija", "location"]);
  return evidenceTokens.some((token, index) => {
    if (!placementCues.has(token)) return false;
    const nearbyTokens = evidenceTokens.slice(index + 1, index + venueTokens.length + 3);
    return nearbyTokens.some((_, start) => venueTokens.every((venueToken, offset) =>
      venueValueAppearsInEventEvidence(venueToken, nearbyTokens[start + offset] ?? ""),
    ));
  });
}

function venueMentionIsOnlyInRowTitle(
  venue: string,
  title: string,
  sourceLine: string,
): boolean {
  const venueText = toSearchableText(venue);
  const titleText = toSearchableText(title);
  const sourceText = toSearchableText(sourceLine);
  if (
    !venueText ||
    !titleText ||
    !sourceText.includes(titleText) ||
    !venueValueAppearsInEventEvidence(venue, title)
  ) {
    return false;
  }

  // A physical location stated in the title ("Night at Vinyl") is still a
  // direct venue claim. "Open Vinyl Night" is only the name of the event.
  if (hasPhysicalVenuePlacement(venue, sourceText)) return false;

  const sourceWithoutTitle = sourceText.replace(titleText, " ");
  return !venueValueAppearsInEventEvidence(venue, sourceWithoutTitle);
}

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
  const parentCaption = splitEventCandidates.reduce(
    (caption, entry) => caption.replace(entry.sourceLine, " "),
    post.caption ?? "",
  );
  const parentText = toSearchableText(parentCaption);
  const parentLooksLikeSharedProgram = /\b(?:all|every|events?|program|raspored|schedule|doga[dj]aj[iae]?|svi|svak[iae]|sve)\b/u.test(parentText);
  const sourceAccountNames = [
    configuredVenueName,
    ...(ingestionVenueResolver.canonicalVenueAliasesByHandle[normalizedSourceHandle] ?? []),
  ].filter(Boolean);
  const sourceAccountVenueId = ingestionVenueResolver.venueIdByProviderHandle.get(normalizedSourceHandle);
  const sourceAccountRecord = sourceAccountVenueId
    ? ingestionVenueResolver.snapshot.venueById.get(sourceAccountVenueId)
    : undefined;
  const claimMatchesSourceAccount = (claim: string): boolean => {
    if (!normalizeString(claim)) return true;
    if (!sourceAccountRecord) return false;
    const claimText = normalizeVenueComparableText(claim);
    return [sourceAccountRecord.name, ...(sourceAccountRecord.aliases ?? []),
      ...(ingestionVenueResolver.canonicalVenueAliasesByHandle[normalizedSourceHandle] ?? []),
      normalizedSourceHandle, `@${normalizedSourceHandle}`,
    ].some((name) => normalizeVenueComparableText(name) === claimText);
  };
  const configuredCanonicalVenue = configuredVenueName
    ? resolveIngestionVenue(ingestionVenueResolver, {
        allowSourceAccountFallback: false,
        postingProviderHandle: post.username,
        rawVenueClaim: configuredVenueName,
        sourceRole: "promoter",
      }).venue ?? configuredVenueName
    : "";
  const parentScopedVenues = usesSplitEventCandidates && usesStructuredEvidence && parentLooksLikeSharedProgram
    ? [...ingestionVenueResolver.snapshot.venueById.values()].filter((venue) =>
        [venue.name, ...(venue.aliases ?? [])].some((name) =>
          hasPhysicalVenuePlacement(name, parentCaption),
        ),
      )
    : [];
  const parentScopedVenue = parentScopedVenues.length === 1
    ? parentScopedVenues[0].name
    : "";
  const sourcePlacementEvidence = [
    post.caption ?? "",
    extractPostAltTextEvidence(post.altText),
    post.locationName ?? "",
    ...splitEventCandidates.map((entry) => entry.sourceLine),
  ].filter(Boolean).join("\n");
  const locationTagVenue = post.locationName
    ? resolveIngestionVenue(ingestionVenueResolver, {
        allowSourceAccountFallback: false,
        locationName: post.locationName,
        postingProviderHandle: post.username,
        sourceRole: "promoter",
      }).venue ?? ""
    : "";
  const hasOffsiteVenuePlacement = usesSplitEventCandidates && usesStructuredEvidence &&
    sourceRole === "venue" && configuredVenueName
    ? [...ingestionVenueResolver.snapshot.venueById.values()].some((venue) =>
        normalizeVenueComparableText(venue.name) !==
          normalizeVenueComparableText(configuredVenueName) &&
          (
            (Boolean(locationTagVenue) &&
              normalizeVenueComparableText(venue.name) ===
                normalizeVenueComparableText(locationTagVenue)) ||
            [venue.name, ...(venue.aliases ?? [])].some((name) =>
              hasPhysicalVenuePlacement(name, sourcePlacementEvidence),
            )
          ),
      )
    : false;
  const sourceAccountVenue = usesStructuredEvidence && sourceRole === "venue" &&
    sourceAccountRecord && !hasOffsiteVenuePlacement &&
    claimMatchesSourceAccount(rawModelVenue) &&
    claimMatchesSourceAccount(normalizeString(extracted.shared_schedule_context.venue.value))
    ? sourceAccountRecord.name
    : "";
  const rawEventVariants: EventVariant[] = usesSplitEventCandidates
    ? splitEventCandidates.map((entry) => {
        const extractedVariantArtists =
          entry.titleUsedFallback || (entry.artistsWereSanitized && entry.artists.length === 0)
            ? []
            : entry.artists.length > 0 || usesStructuredEvidence
              ? entry.artists
              : extractedArtists;
        const rowVenue = normalizeString(entry.venue);
        const rowVenueIsTitleOnly = venueMentionIsOnlyInRowTitle(
          rowVenue,
          entry.lineTitle,
          entry.sourceLine,
        );
        const carouselRow = extracted._carouselContractVersion === "carousel_evidence_v1" &&
          extracted._carouselMedia && extracted.schedule_entries.length === 1
          ? extracted.schedule_entries[0] : null;
        const carouselPosterVenueGrounded = Boolean(rowVenue && carouselRow && selectedImageUrl &&
          (carouselRow.poster_evidence ?? []).some((snippet) =>
            carouselRow.source_slide_indexes?.includes(snippet.slide_index) &&
            extracted._carouselMedia?.images.some((image) => image.slideIndex === snippet.slide_index) &&
            !venueMentionIsOnlyInRowTitle(rowVenue, entry.lineTitle, snippet.text) &&
            venueValueAppearsInEventEvidence(rowVenue, snippet.text)));
        const rowVenueGrounded = Boolean(
          rowVenue &&
            ((!rowVenueIsTitleOnly && venueValueAppearsInEventEvidence(rowVenue, entry.sourceLine)) ||
              carouselPosterVenueGrounded),
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
        const comparableQuote = (value: string): string => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
        const hasOtherLocativeRowHandle = extracted._extractionPolicyVersion === "event_quality_v1" &&
          sourceRole === "venue" && Object.entries(ingestionVenueResolver.canonicalVenueNamesByHandle).some(([handle, name]) =>
          handle !== normalizedSourceHandle && findPositiveLocativeVenueHandleEvidence({
            evidenceText: entry.sourceLine,
            handle,
            venueNames: [name, ...(ingestionVenueResolver.canonicalVenueAliasesByHandle[handle] ?? [])],
          }),
        );
        const ownLocativeRowEvidence = extracted._extractionPolicyVersion === "event_quality_v1" &&
          sourceRole === "venue" && configuredVenueName &&
          !hasOtherLocativeRowHandle &&
          normalizeVenueComparableText(canonicalRowVenue) === normalizeVenueComparableText(configuredCanonicalVenue) &&
          Boolean(comparableQuote(entry.sourceLine)) &&
          [post.caption ?? "", extractPostAltTextEvidence(post.altText)].some((text) =>
            comparableQuote(text).includes(comparableQuote(entry.sourceLine)),
          )
          ? findPositiveLocativeVenueHandleEvidence({
              evidenceText: entry.sourceLine,
              handle: normalizedSourceHandle,
              venueNames: sourceAccountNames,
            })
          : null;
        const ordinaryRowVenueNormalization = resolveIngestionVenue(
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
        const ownLocativeRowVenueNormalization = ownLocativeRowEvidence
          ? resolveIngestionVenue(ingestionVenueResolver, {
              allowSourceAccountFallback: false,
              postingProviderHandle: "",
              rawVenueClaim: configuredVenueName,
              locationName: "",
              evidenceTexts: [ownLocativeRowEvidence],
              sourceRole: "promoter",
            })
          : null;
        const rowCanonicalVenueNormalization = ownLocativeRowVenueNormalization?.source === "evidence_handle" &&
          normalizeVenueComparableText(ownLocativeRowVenueNormalization.venue ?? "") === normalizeVenueComparableText(configuredCanonicalVenue)
          ? ownLocativeRowVenueNormalization
          : ordinaryRowVenueNormalization;
        const rowCanonicalVenueEvidenceSource =
          rowCanonicalVenueNormalization.source === "evidence_handle" ||
          rowCanonicalVenueNormalization.source === "evidence_name"
            ? rowCanonicalVenueNormalization.source
            : null;
        const rowCanonicalVenueEvidenceBound = Boolean(
          rowCanonicalVenueEvidenceSource &&
            rowCanonicalVenueNormalization.venue &&
            !venueMentionIsOnlyInRowTitle(
              rowCanonicalVenueNormalization.venue,
              entry.lineTitle,
              entry.sourceLine,
            ) &&
            (Boolean(ownLocativeRowEvidence && rowCanonicalVenueNormalization === ownLocativeRowVenueNormalization) ||
              extractionEvidenceAppearsInPersistedSource({
                evidenceText: entry.sourceLine,
                source: rowEvidenceSource,
                post,
                hasPoster: hasPosterEvidence,
              })),
        );
        const rowCanonicalVenue = rowCanonicalVenueEvidenceBound
          ? rowCanonicalVenueNormalization.venue ?? ""
          : "";
        const singleOccurrencePostVenueGrounded = Boolean(
          splitEventCandidates.length === 1 &&
            rowVenue &&
            !rowVenueIsTitleOnly &&
            venueValueAppearsInEventEvidence(
              rowVenue,
              independentPostTextEvidence,
            ),
        );
        const scopedBranchSource = entry.dateEvidence?.source;
        const scopedBranchVenueEvidence = extracted._extractionPolicyVersion === "event_quality_v1" &&
          (scopedBranchSource === "caption" || scopedBranchSource === "alt_text")
          ? findScopedBranchVenueEvidence({
              venue: rowVenue,
              rowSourceText: entry.sourceLine,
              rowDateText: entry.dateEvidence?.exact_text ?? "",
              source: scopedBranchSource,
              sourceText: scopedBranchSource === "caption" ? post.caption ?? "" : post.altText ?? "",
              declaredVenues: extracted.schedule_entries.map((row) => row.venue),
            }) ?? undefined
          : undefined;
        const singleOccurrenceNamedVenueVerified = Boolean(
          splitEventCandidates.length === 1 && rowVenue && !rowVenueIsTitleOnly &&
            isVerifiedEventVenueEvidence({
              venue: rowVenue,
              rawEvidenceValue: rowVenue,
              extracted,
              splitSourceLine: entry.sourceLine,
              splitEvidenceSource: rowEvidenceSource,
              post,
              hasPoster: hasPosterEvidence,
              trustedVenueSource: false,
              sharedVenueVerified: false,
            }),
        );
        const rowVenueIsDirect = rowVenueGrounded || singleOccurrencePostVenueGrounded ||
          singleOccurrenceNamedVenueVerified || Boolean(scopedBranchVenueEvidence);
        const singleOccurrenceModelVenueVerified = Boolean(
          splitEventCandidates.length === 1 && !rowVenue && rawModelVenue &&
            isVerifiedEventVenueEvidence({
              venue: rawModelVenue, rawEvidenceValue: rawModelVenue, extracted,
              splitSourceLine: entry.sourceLine, splitEvidenceSource: rowEvidenceSource,
              post, hasPoster: hasPosterEvidence, trustedVenueSource: false, sharedVenueVerified: false,
            }),
        );
        const scopedRowCanonicalVenue =
          rowVenueIsDirect || sharedVenueValue ? "" : rowCanonicalVenue;
        const singleSplitCanonicalVenueEvidenceSource =
          splitEventCandidates.length === 1 && !rowVenueIsDirect &&
            !venueMentionIsOnlyInRowTitle(
              normalizedVenue,
              entry.lineTitle,
              entry.sourceLine,
            )
            ? canonicalVenueEvidenceSource
            : null;
        const carouselVenueDisagreesWithCanonicalEvidence = Boolean(carouselRow && rowVenue &&
          normalizeVenueComparableText(canonicalRowVenue) !== normalizeVenueComparableText(normalizedVenue));
        const variantCanonicalVenueEvidenceSource = carouselVenueDisagreesWithCanonicalEvidence
          ? null
          : scopedRowCanonicalVenue
          ? rowCanonicalVenueEvidenceSource
          : singleSplitCanonicalVenueEvidenceSource;
        const variantCanonicalVenueEvidenceHandle = carouselVenueDisagreesWithCanonicalEvidence
          ? null
          : scopedRowCanonicalVenue
          ? rowCanonicalVenueNormalization.evidenceHandle ?? null
          : singleSplitCanonicalVenueEvidenceSource === "evidence_handle"
            ? venueNormalization.evidenceHandle ?? null
            : null;
        const trustedVenueAccountFallback = Boolean(
          trustedVenueSource &&
            !hasOffsiteVenuePlacement &&
            claimMatchesSourceAccount(rowVenue) &&
            !venueMentionIsOnlyInRowTitle(
              normalizedVenue,
              entry.lineTitle,
              entry.sourceLine,
            ) &&
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
          ? (rowVenueIsDirect || Boolean(carouselRow && rowVenue))
            ? rowVenueMatchesConfiguredLocation
              ? normalizedVenue
              : rowVenue
            : sharedVenueMatchesConfiguredLocation
              ? normalizedVenue
              : sharedVenueValue ||
                scopedRowCanonicalVenue ||
                parentScopedVenue ||
                (singleOccurrenceModelVenueVerified ? rawModelVenue : "") ||
                (singleSplitCanonicalVenueEvidenceSource ? normalizedVenue : "") ||
                (trustedVenueAccountFallback ? normalizedVenue : "") ||
                (claimMatchesSourceAccount(rowVenue) ? sourceAccountVenue : "")
          : normalizedVenue;
        const variantVenueCanonicalization = variantVenueRaw
          ? canonicalizeVenueNameDetailed(variantVenueRaw, ingestionVenueResolver.snapshot.canonicalVenueNamesByHandle, {
              canonicalVenueAliasesByHandle: ingestionVenueResolver.canonicalVenueAliasesByHandle,
            })
          : null;
        const variantVenue = usesStructuredEvidence && variantVenueCanonicalization?.reason === "compatible"
          ? variantVenueRaw
          : variantVenueRaw
          ? resolveIngestionVenue(ingestionVenueResolver, {
              allowSourceAccountFallback: false,
              postingProviderHandle: post.username,
              rawVenueClaim: variantVenueRaw,
              sourceRole: "promoter",
            }).venue ?? variantVenueRaw
          : "";
        const compactIdentity = (value: string): string => toSearchableText(value).replace(/\s/gu, "");
        const physicalVenueIdentities = new Set(
          [...sourceAccountNames, normalizedSourceHandle].map(compactIdentity).filter(Boolean),
        );
        const captionRowIsBound = Boolean(
          entry.sourceLine.trim() &&
          (post.caption ?? "").normalize("NFKC").replace(/\s+/gu, " ").includes(
            entry.sourceLine.normalize("NFKC").replace(/\s+/gu, " ").trim(),
          ),
        );
        const captionBilledArtists = extractedVariantArtists.filter((artist) =>
          !physicalVenueIdentities.has(compactIdentity(artist)) &&
          artistIdentityAppearsInText(entry.sourceLine, artist),
        );
        // A row-local caption can distinguish its billed act from the venue
        // logo that vision placed in the lineup. Never remove a name that
        // the same caption row actually bills, or borrow another day's act.
        const variantArtists = extracted._extractionPolicyVersion === "event_quality_v1" &&
          usesStructuredEvidence && sourceRole === "venue" &&
          normalizeVenueComparableText(variantVenue) === normalizeVenueComparableText(configuredCanonicalVenue) &&
          captionRowIsBound && captionBilledArtists.length > 0
          ? extractedVariantArtists.filter((artist) =>
              !physicalVenueIdentities.has(compactIdentity(artist)) ||
              artistIdentityAppearsInText(entry.sourceLine, artist),
            )
          : extractedVariantArtists;
        const venueArtistRemoved = variantArtists.length !== extractedVariantArtists.length;
        const rowContextCandidate = entry.titleUsedFallback
          ? extractContextualEventTitleCandidate(entry.description ?? "")
          : null;
        const normalizedRowCandidate = toSearchableText(rowContextCandidate ?? "");
        const candidateAppearsInExactSourceRow = Boolean(
          normalizedRowCandidate &&
          extracted.schedule_entries.some((scheduleEntry) => {
            const sourceText = toSearchableText(scheduleEntry.source_text);
            return Boolean(
              sourceText &&
              toSearchableText(entry.sourceLine).includes(sourceText) &&
              sourceText.includes(normalizedRowCandidate)
            );
          }),
        );
        const sourceBoundRowTitle = rowContextCandidate &&
          isUsableContextEventTitleCandidate(
            rowContextCandidate,
            post,
            { ...venueNormalization, venue: variantVenue },
            { ...ingestionVenueResolver.configuredVenueNamesByHandle },
          ) &&
          candidateAppearsInExactSourceRow
            ? normalizeContextDerivedTitle(rowContextCandidate)
            : "";
        const groundedFallbackTitle = entry.titleUsedFallback
          ? sourceBoundRowTitle || buildUnnamedScheduleFallbackTitle({
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
            ? sourceBoundRowTitle ? entry.source : "unnamed_schedule_fallback"
            : entry.titleSource ?? (usesSplitScheduleTitle ? entry.source : baseTitleSource),
          titleUsedFallback:
            (sourceBoundRowTitle ? false : entry.titleUsedFallback) ??
            (usesSplitScheduleTitle ? false : baseTitleUsedFallback),
          titleDerivedFromContext:
            sourceBoundRowTitle ? true :
              usesSplitScheduleTitle ? false : titleNormalization.source === "context_derived",
          titleContextCandidate:
            sourceBoundRowTitle ? rowContextCandidate :
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
          artistsWereSanitized: venueArtistRemoved || (entry.artistsWereSanitized ?? false),
          description: variantDescription,
          venue: variantVenue,
          venueEvidenceValue:
            rowVenueIsDirect ? rowVenue : sharedVenueValue || scopedRowCanonicalVenue ||
              (singleOccurrenceModelVenueVerified ? rawModelVenue : ""),
          scopedBranchVenueEvidence,
          venueFromSourceAccountFallback: Boolean(
            sourceAccountVenue &&
              variantVenueRaw === sourceAccountVenue &&
              !rowVenueIsDirect &&
              !sharedVenueValue &&
              !scopedRowCanonicalVenue &&
              !parentScopedVenue,
          ),
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
        venue: effectiveNormalizedVenue || sourceAccountVenue,
        venueEvidenceValue: rawModelVenue,
        venueFromSourceAccountFallback: Boolean(sourceAccountVenue &&
          (!effectiveNormalizedVenue ||
            (venueNormalization.source === "handle_map" &&
              normalizeVenueComparableText(effectiveNormalizedVenue) === normalizeVenueComparableText(sourceAccountVenue)))),
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
