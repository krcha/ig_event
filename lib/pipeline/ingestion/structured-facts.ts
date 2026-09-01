import { type ExtractedEventData } from "@/lib/ai/extract-event-data";
import { buildIngestionVenueResolver, type IngestionVenueResolver, type IngestionVenueResolverSnapshotInput, resolveIngestionVenue } from "@/lib/domain/venues/index";
import { canonicalizeVenueName, type CanonicalVenueAliasesByHandle, normalizeExtractedArtists, normalizeExtractedDescription, normalizeHandle, normalizeVenueComparableText, type VenueNormalization } from "@/lib/pipeline/venue-normalization";
import { type InstagramScrapedPost } from "@/lib/scraper/instagram-scraper";
import { canonicalizeEventType } from "@/lib/taxonomy/venue-types";
import { normalizeConfidenceScore } from "@/lib/utils/confidence";
import type { PrepareEventResult } from "@/lib/pipeline/ingestion/contracts";
import { buildExtractionFieldEvidence, buildSkippedExtractionScorecard } from "@/lib/pipeline/ingestion/extraction-scorecard";
import { repairDescriptionForArtistFallback } from "@/lib/pipeline/ingestion/occurrence-coalescing";
import { expandNormalizedDateRange, getEventDateFilterContext, normalizeEventDate } from "@/lib/pipeline/ingestion/parsing-date";
import { buildIndependentPostTextEvidence, buildPostTextEvidence, dedupeArtistDisplayNames, extractPostAltTextEvidence, formatArtistTitleList, titleContainsAlphanumeric } from "@/lib/pipeline/ingestion/parsing-event-text";
import { normalizeEventTitle } from "@/lib/pipeline/ingestion/parsing-event-title";
import { extractSplitEventCandidates, getRecurringModelScheduleContext, hasMalformedCombinedWeekdayDateSchedule, hasRecurringScheduleStartSuspicion } from "@/lib/pipeline/ingestion/parsing-schedule";
import { isHashtagOnlySourceIdentity } from "@/lib/pipeline/ingestion/parsing-source-evidence";
import { normalizeTicketPrice, resolveEventTimeFromExtractionAndEvidence } from "@/lib/pipeline/ingestion/parsing-time";
import { isVerifiedEventVenueEvidence } from "@/lib/pipeline/ingestion/structured-fact-verification";
import { normalizeString } from "@/lib/pipeline/ingestion/values";
import type { StructuredFactExtractionResult } from "@/lib/pipeline/ingestion/structured-fact-contracts";
import { prepareStructuredFactsForPersistence } from "@/lib/pipeline/ingestion/structured-fact-persistence";
import { finalizeStructuredFactVariants } from "@/lib/pipeline/ingestion/structured-fact-finalization";
import { buildStructuredFactVariants } from "@/lib/pipeline/ingestion/structured-fact-variants";
export { CAPTION_ONLY_VIDEO_AUTO_APPROVE_MIN_CONFIDENCE } from "@/lib/pipeline/ingestion/structured-fact-policy";

export function isVideoPostWithoutSelectedImage(
  post: InstagramScrapedPost,
  selectedImageUrl: string | null,
): boolean {
  if (selectedImageUrl) {
    return false;
  }
  const postType = normalizeString(post.postType).toLowerCase();
  return postType.includes("video") || postType.includes("reel");
}

export function normalizeVenue(
  post: InstagramScrapedPost,
  rawModelVenue: string,
  resolver: IngestionVenueResolver,
  sourceRolesByHandle: Record<string, "venue" | "promoter" | "unknown"> = {},
): VenueNormalization {
  const normalizedSourceHandle = normalizeHandle(post.username);
  const sourceRole = sourceRolesByHandle[normalizedSourceHandle];
  return resolveIngestionVenue(resolver, {
    postingProviderHandle: post.username,
    rawVenueClaim: rawModelVenue,
    locationName: post.locationName,
    evidenceTexts: [
      post.caption,
      extractPostAltTextEvidence(post.altText),
    ],
    sourceRole,
  });
}

export function produceStructuredFactsForInsert(
  post: InstagramScrapedPost,
  extracted: ExtractedEventData,
  selectedImageUrl: string | null,
  canonicalVenueNamesByHandle: Record<string, string>,
  _venueNameOverridesByHandle: Record<string, string>,
  configuredVenueNamesByHandle: Record<string, string> = {},
  options: {
    eventDateFilterNow?: Date;
    preserveExplicitDateEvidenceRelativeFlag?: boolean;
    sourceRolesByHandle?: Record<string, "venue" | "promoter" | "unknown">;
    canonicalVenueAliasesByHandle?: CanonicalVenueAliasesByHandle;
    canonicalVenueLocationsByHandle?: Record<string, string>;
    venueResolverSnapshot?: IngestionVenueResolverSnapshotInput;
  } = {},
): StructuredFactExtractionResult[] {
  const extractionContractVersion = normalizeString(extracted.extraction_contract_version);
  const usesStructuredEvidence = extractionContractVersion === "event_evidence_v2";
  const nonEventReason = normalizeString(extracted.non_event_reason);
  if (!extracted.is_event) {
    const normalizedFields: Record<string, unknown> = {
      extractionContractVersion,
      extractionIsEvent: false,
      extractionNonEventReason: nonEventReason,
      extractionSourceConflicts: extracted.source_conflicts,
      extractionSourceConflictCount: extracted.source_conflicts.length,
      dateEvidence: extracted.date_evidence,
      timeEvidence: extracted.time_evidence,
      sharedScheduleContext: extracted.shared_schedule_context,
      sourceGroundingInstagramPostId: normalizeString(post.postId) || null,
      sourceGroundingInstagramPostUrl: normalizeString(post.instagramPostUrl) || null,
      sourceGroundingInstagramHandle: normalizeHandle(post.username) || null,
      normalizedIsValid: false,
      normalizedInvalidReason: "not_event",
      moderationAutoApproved: false,
      moderationAutoApproveRule: null,
      moderationPendingReasons: [],
      moderationSignals: ["not_event"],
      extractionScorecard: buildSkippedExtractionScorecard({
        baseConfidenceScore: normalizeConfidenceScore(extracted.confidence),
        fieldConfirmation: extracted.field_confirmation,
        normalizedInvalidReason: "not_event",
      }),
    };
    return [{ kind: "skip", reason: "not_event", normalizedFields }];
  }
  const eventType = canonicalizeEventType(normalizeString(extracted.category));
  const description = normalizeExtractedDescription(extracted.description);
  const rawExtractedTime = normalizeString(extracted.time ?? undefined);
  const rawExtractedDate = normalizeString(extracted.date);
  const price = normalizeString(extracted.price);
  const currency = normalizeString(extracted.currency);
  const ticketPrice = normalizeTicketPrice(price, currency);
  const confidence = normalizeConfidenceScore(extracted.confidence);
  const canonicalVenueAliasesByHandle = options.canonicalVenueAliasesByHandle ?? {};
  const canonicalVenueLocationsByHandle = options.canonicalVenueLocationsByHandle ?? {};
  const ingestionVenueResolver = buildIngestionVenueResolver({
    canonicalVenueAliasesByHandle,
    canonicalVenueNamesByHandle,
    configuredVenueNamesByHandle,
    venueResolverSnapshot: options.venueResolverSnapshot,
  });
  const venueNormalization = normalizeVenue(
    post,
    extracted.venue,
    ingestionVenueResolver,
    options.sourceRolesByHandle,
  );
  const normalizedVenue = venueNormalization.venue ?? "";
  const canonicalVenueEvidenceSource =
    venueNormalization.source === "evidence_handle" ||
    venueNormalization.source === "evidence_name"
      ? venueNormalization.source
      : null;
  const normalizedSourceHandle = normalizeHandle(post.username);
  const sourceRole = options.sourceRolesByHandle?.[normalizedSourceHandle];
  const configuredVenueName = canonicalVenueNamesByHandle[normalizedSourceHandle];
  const configuredVenueLocation =
    canonicalVenueLocationsByHandle[normalizedSourceHandle] ?? "";
  const configuredSourceName =
    configuredVenueNamesByHandle[normalizedSourceHandle] ?? configuredVenueName ?? "";
  const rawModelVenue = normalizeString(extracted.venue);
  const normalizedRawModelVenue = rawModelVenue
    ? canonicalizeVenueName(rawModelVenue, canonicalVenueNamesByHandle, {
        canonicalVenueAliasesByHandle,
      }) ?? rawModelVenue
    : "";
  const rawModelVenueMatchesConfiguredVenue =
    !normalizedRawModelVenue ||
    normalizeVenueComparableText(normalizedRawModelVenue) ===
      normalizeVenueComparableText(configuredVenueName ?? "");
  const rawModelVenueMatchesConfiguredLocation = Boolean(
    rawModelVenue &&
      configuredVenueLocation &&
      normalizeVenueComparableText(rawModelVenue) ===
        normalizeVenueComparableText(configuredVenueLocation),
  );
  const exactCanonicalVenueSource = Boolean(
    configuredVenueName &&
      normalizeVenueComparableText(normalizedVenue) ===
        normalizeVenueComparableText(configuredVenueName),
  );
  // Only an explicitly configured venue account can use this relaxed
  // publication path. Promoters and unknown accounts must keep the stricter
  // source-grounding rules because their posts can advertise another venue.
  const trustedVenueSource =
    // Older source records can still be `unknown`; an exact configured
    // canonical handle mapping is sufficient. Promoter accounts are never
    // trusted as the venue for this relaxed path.
    (sourceRole === "venue" || sourceRole === "unknown") &&
    exactCanonicalVenueSource &&
    (rawModelVenueMatchesConfiguredVenue ||
      (sourceRole === "venue" && rawModelVenueMatchesConfiguredLocation));
  const titleNormalization = normalizeEventTitle(
    post,
    extracted,
    venueNormalization,
    canonicalVenueNamesByHandle,
    canonicalVenueAliasesByHandle,
    configuredVenueNamesByHandle,
  );
  const title = normalizeString(titleNormalization.title);
  const postTextEvidence = buildPostTextEvidence(post, extracted);
  const independentPostTextEvidence = buildIndependentPostTextEvidence(post);
  const extractedTimeResolution = resolveEventTimeFromExtractionAndEvidence({
    rawDate: rawExtractedDate,
    rawTime: rawExtractedTime,
    textEvidence: [
      { source: "description", text: description },
      { source: "source_caption", text: extracted.source_caption },
      { source: "caption", text: post.caption },
      { source: "post_alt_text", text: extractPostAltTextEvidence(post.altText) },
    ],
  });
  const time = extractedTimeResolution.time;
  const extractedTimeIssues = extractedTimeResolution.issues;
  const dateNormalization = normalizeEventDate(
    normalizeString(extracted.date),
    postTextEvidence,
    post.postedAt,
  );
  const expandedRangeDates = expandNormalizedDateRange(
    rawExtractedDate,
    post.postedAt,
    postTextEvidence,
  );
  let candidateDates =
    expandedRangeDates && expandedRangeDates.length > 1
      ? expandedRangeDates
      : dateNormalization.isoDate
        ? [dateNormalization.isoDate]
        : [];
  const modelScheduleEvidence = extracted.schedule_entries
    .map((entry) => normalizeString(entry.source_text))
    .filter(Boolean);
  const modelRecurringSourceText = modelScheduleEvidence.join("\n");
  const recurringScheduleContext = getRecurringModelScheduleContext(
    post,
    extracted.schedule_entries,
  );
  const recurringScheduleEvidenceText = [
    modelRecurringSourceText,
    post.caption,
    extractPostAltTextEvidence(post.altText),
  ]
    .map((value) => normalizeString(value))
    .filter(Boolean)
    .join("\n");
  const rejectedRecurringModelSchedule =
    hasRecurringScheduleStartSuspicion(recurringScheduleEvidenceText) &&
    (!recurringScheduleContext || recurringScheduleContext.sourcePlanCoverageRejected);
  if (rejectedRecurringModelSchedule) {
    candidateDates = [];
  }
  const malformedCombinedSchedule = hasMalformedCombinedWeekdayDateSchedule(
    [
      normalizeString(post.caption || extracted.source_caption),
      extractPostAltTextEvidence(post.altText),
    ].filter(Boolean).join("\n"),
  );
  const splitEventCandidates =
    malformedCombinedSchedule || rejectedRecurringModelSchedule
      ? []
      : extractSplitEventCandidates(
        post,
        extracted,
        eventType,
        normalizedVenue,
      );
  if (malformedCombinedSchedule) {
    candidateDates = [];
  }
  const usesSplitEventCandidates = splitEventCandidates.length > 0;
  const extractedArtists = dedupeArtistDisplayNames(
    normalizeExtractedArtists(extracted.artists),
    extracted.source_conflicts,
  )
    .filter((artist) => titleContainsAlphanumeric(artist))
    .filter((artist) => !isHashtagOnlySourceIdentity(artist, post, modelScheduleEvidence));
  const artistFallbackTitle = titleNormalization.usedFallback
    ? formatArtistTitleList(extractedArtists)
    : "";
  const baseTitle = artistFallbackTitle || title;
  const baseTitleSource = artistFallbackTitle ? "artist_fallback" : titleNormalization.source;
  const baseTitleUsedFallback = titleNormalization.usedFallback && !artistFallbackTitle;
  const baseDescription = artistFallbackTitle
    ? repairDescriptionForArtistFallback({
        description,
        previousTitle: title,
        artists: extractedArtists,
        eventType,
        venue: normalizedVenue,
      })
    : description;
  const eventDateFilter = getEventDateFilterContext(options.eventDateFilterNow);
  const isCaptionOnlyVideo = isVideoPostWithoutSelectedImage(post, selectedImageUrl);
  const extractionMode = selectedImageUrl ? "poster" : "caption_only";
  const missingImage = !selectedImageUrl;
  const topLevelVenueEvidenceVerified =
    !usesStructuredEvidence ||
    isVerifiedEventVenueEvidence({
      venue: normalizedVenue,
      rawEvidenceValue: rawModelVenue,
      extracted,
      splitSourceLine: null,
      splitEvidenceSource: "unknown",
      post,
      hasPoster: Boolean(selectedImageUrl),
      trustedVenueSource,
      sharedVenueVerified: false,
      canonicalHandleEvidenceVerified:
        canonicalVenueEvidenceSource !== null,
    });
  const explicitModelVenueEvidenceVerified =
    usesStructuredEvidence &&
    Boolean(normalizedRawModelVenue) &&
    normalizeString(normalizedRawModelVenue) !== normalizeString(normalizedVenue) &&
    isVerifiedEventVenueEvidence({
      venue: normalizedRawModelVenue,
      rawEvidenceValue: rawModelVenue,
      extracted,
      splitSourceLine: null,
      splitEvidenceSource: "unknown",
      post,
      hasPoster: Boolean(selectedImageUrl),
      trustedVenueSource: false,
      sharedVenueVerified: false,
    });
  const verifiedNamedModelVenueConflict = Boolean(
    sourceRole === "venue" &&
      exactCanonicalVenueSource &&
      normalizedRawModelVenue &&
      !rawModelVenueMatchesConfiguredVenue &&
      !rawModelVenueMatchesConfiguredLocation &&
      explicitModelVenueEvidenceVerified,
  );
  const effectiveNormalizedVenue = verifiedNamedModelVenueConflict
    ? normalizedRawModelVenue
    : topLevelVenueEvidenceVerified
      ? normalizedVenue
      : explicitModelVenueEvidenceVerified
        ? normalizedRawModelVenue
        : "";
  const effectiveVenueSource = verifiedNamedModelVenueConflict
    ? "model"
    : topLevelVenueEvidenceVerified
      ? venueNormalization.source
      : explicitModelVenueEvidenceVerified
        ? "model"
        : "unsupported_model_venue_cleared";
  const allowMissingImageForModeration =
    isCaptionOnlyVideo || usesStructuredEvidence;
  const normalizedFieldsCommon: Record<string, unknown> = {
    extractionContractVersion,
    extractionIsEvent: extracted.is_event,
    extractionNonEventReason: nonEventReason,
    extractionSourceConflicts: extracted.source_conflicts,
    extractionSourceConflictCount: extracted.source_conflicts.length,
    dateEvidence: extracted.date_evidence,
    timeEvidence: extracted.time_evidence,
    sharedScheduleContext: extracted.shared_schedule_context,
    rawTitle: titleNormalization.rawTitle,
    rawVenue: normalizeString(extracted.venue),
    normalizedVenue: effectiveNormalizedVenue,
    venueSource: effectiveVenueSource,
    canonicalVenueEvidenceHandle: venueNormalization.evidenceHandle ?? null,
    canonicalVenueLocation: configuredVenueLocation || null,
    rawVenueMatchesCanonicalLocation: rawModelVenueMatchesConfiguredLocation,
    venueEvidenceVerified:
      topLevelVenueEvidenceVerified || explicitModelVenueEvidenceVerified,
    locationName: venueNormalization.rawLocationName,
    eventType,
    time,
    rawExtractedTime,
    timeSource: extractedTimeResolution.timeSource,
    timeEvidenceText: extractedTimeResolution.timeEvidence?.text ?? null,
    timeInferredFromText: Boolean(
      extractedTimeResolution.timeSource &&
        extractedTimeResolution.timeSource !== "extracted_time" &&
        extractedTimeResolution.timeSource !== "extracted_time_tbd" &&
        extractedTimeResolution.timeSource !== "extracted_time_unparsed",
    ),
    ticketPrice: ticketPrice || null,
    city: normalizeString(extracted.city),
    country: normalizeString(extracted.country),
    confidence,
    extractionMode,
    postType: normalizeString(post.postType).toLowerCase() || null,
    missingImage,
    malformedCombinedSchedule,
    rejectedRecurringModelSchedule,
    moderationAllowMissingImage: allowMissingImageForModeration,
    moderationMissingImageReason: missingImage
      ? allowMissingImageForModeration
        ? "video_caption_only"
        : "no_selected_image"
      : null,
    reasoningNotes: normalizeString(extracted.reasoning_notes),
    sourceCaptionFromModel: normalizeString(extracted.source_caption),
    sourceUrlFromModel: normalizeString(extracted.source_url),
    postAltText: extractPostAltTextEvidence(post.altText) || null,
    sourceGroundingSourceKind: "caption",
    sourceGroundingSourceCaption: normalizeString(post.caption) || null,
    sourceGroundingInstagramPostId: normalizeString(post.postId) || null,
    sourceGroundingInstagramPostUrl: normalizeString(post.instagramPostUrl) || null,
    sourceGroundingInstagramHandle: normalizeHandle(post.username) || null,
    sourceAccountRole: sourceRole ?? "unknown",
    sourceAccountName: configuredSourceName || null,
    trustedVenueSource,
    fieldConfirmation: extracted.field_confirmation,
    extractionFieldEvidence: buildExtractionFieldEvidence(extracted.field_confirmation),
    postTimestamp: post.postedAt,
    filterDateToday: eventDateFilter.todayIsoDate,
    filterDateMaxFuture: eventDateFilter.maxFutureIsoDate,
    filterMaxDaysAhead: eventDateFilter.maxDaysAhead,
    filterDateTimezone: eventDateFilter.timeZone,
  };

  const referenceSplitCandidate = splitEventCandidates[0];
  const referenceDateNormalization = referenceSplitCandidate?.normalizedDate ?? dateNormalization;
  const referenceRawDate = referenceSplitCandidate?.rawDate ?? normalizeString(extracted.date);
  const referenceTitle =
    usesSplitEventCandidates && referenceSplitCandidate ? referenceSplitCandidate.lineTitle : baseTitle;
  const referenceTitleSource =
    usesSplitEventCandidates && referenceSplitCandidate
      ? referenceSplitCandidate.titleSource ?? referenceSplitCandidate.source
      : baseTitleSource;
  const referenceTitleUsedFallback = usesSplitEventCandidates
    ? referenceSplitCandidate?.titleUsedFallback ?? false
    : baseTitleUsedFallback;
  const referenceTitleDerivedFromContext = usesSplitEventCandidates
    ? false
    : titleNormalization.source === "context_derived";
  const referenceTitleContextCandidate = usesSplitEventCandidates
    ? null
    : titleNormalization.contextCandidate;
  const referenceArtists = referenceSplitCandidate
    ? referenceSplitCandidate.titleUsedFallback ||
      (referenceSplitCandidate.artistsWereSanitized && referenceSplitCandidate.artists.length === 0)
      ? []
      : referenceSplitCandidate.artists.length > 0
        ? referenceSplitCandidate.artists
        : extractedArtists
    : extractedArtists;
  const referenceDescription = referenceSplitCandidate?.description ?? baseDescription;
  const referenceTime = referenceSplitCandidate?.time ?? time;

  if (!usesSplitEventCandidates && candidateDates.length === 0) {
    const normalizedFields: Record<string, unknown> = {
      ...normalizedFieldsCommon,
      time: referenceTime || null,
      title: referenceTitle,
      titleSource: referenceTitleSource,
      titleUsedFallback: referenceTitleUsedFallback,
      titleDerivedFromContext: referenceTitleDerivedFromContext,
      titleContextCandidate: referenceTitleContextCandidate,
      rawDate: referenceRawDate,
      rawExtractedDateText: referenceDateNormalization.rawDateText,
      normalizedDate: null,
      dateSource: referenceDateNormalization.source,
      dateConfidence: referenceDateNormalization.confidence,
      dateDistanceFromPostDays: referenceDateNormalization.distanceFromPostDays,
      dateInferredYear: referenceDateNormalization.inferredYear,
      dateSuspiciousYear: referenceDateNormalization.suspiciousYear,
      dateYearSelectionReason: referenceDateNormalization.yearSelectionReason,
      dateReason: referenceDateNormalization.reason ?? null,
      artists: referenceArtists,
      description: referenceDescription,
      dateRangeExpanded: false,
      dateRangeExpandedCount: 0,
      multiEventSplitDetected: false,
      multiEventSplitCount: 0,
      splitEventIndex: 0,
      splitEventTotal: 0,
      splitSource: referenceSplitCandidate?.source ?? null,
      splitSourceLine: null,
      normalizedIsValid: false,
      normalizedInvalidReason: "invalid_date",
      extractionScorecard: buildSkippedExtractionScorecard({
        baseConfidenceScore: confidence,
        fieldConfirmation: extracted.field_confirmation,
        normalizedInvalidReason: "invalid_date",
      }),
    };
    return [
      {
        kind: "skip",
        reason:
          referenceDateNormalization.reason === "missing_date" ? "missing_date" : "invalid_event",
        normalizedFields,
      },
    ];
  }

  // Legacy cached/test payloads retain the original venue requirement. The
  // evidence-v2 contract deliberately permits a real event whose venue was
  // not stated, as long as its event/date evidence is otherwise verified.
  if (!normalizedVenue && !usesStructuredEvidence) {
    const normalizedFields: Record<string, unknown> = {
      ...normalizedFieldsCommon,
      time: referenceTime || null,
      title: referenceTitle,
      titleSource: referenceTitleSource,
      titleUsedFallback: referenceTitleUsedFallback,
      titleDerivedFromContext: referenceTitleDerivedFromContext,
      titleContextCandidate: referenceTitleContextCandidate,
      rawDate: referenceRawDate,
      rawExtractedDateText: referenceDateNormalization.rawDateText,
      normalizedDate: referenceDateNormalization.isoDate,
      dateSource: referenceDateNormalization.source,
      dateConfidence: referenceDateNormalization.confidence,
      dateDistanceFromPostDays: referenceDateNormalization.distanceFromPostDays,
      dateInferredYear: referenceDateNormalization.inferredYear,
      dateSuspiciousYear: referenceDateNormalization.suspiciousYear,
      dateYearSelectionReason: referenceDateNormalization.yearSelectionReason,
      dateReason: referenceDateNormalization.reason ?? null,
      artists: referenceArtists,
      description: referenceDescription,
      dateRangeExpanded: !usesSplitEventCandidates && candidateDates.length > 1,
      dateRangeExpandedCount: !usesSplitEventCandidates ? candidateDates.length : 1,
      multiEventSplitDetected: usesSplitEventCandidates,
      multiEventSplitCount: usesSplitEventCandidates ? splitEventCandidates.length : 1,
      splitEventIndex: 1,
      splitEventTotal: usesSplitEventCandidates ? splitEventCandidates.length : 1,
      splitSource: referenceSplitCandidate?.source ?? null,
      splitSourceLine: referenceSplitCandidate?.sourceLine ?? null,
      normalizedIsValid: false,
      normalizedInvalidReason: "invalid_venue",
      extractionScorecard: buildSkippedExtractionScorecard({
        baseConfidenceScore: confidence,
        fieldConfirmation: extracted.field_confirmation,
        normalizedInvalidReason: "invalid_venue",
      }),
    };
    return [{ kind: "skip", reason: "missing_venue", normalizedFields }];
  }

  if (!eventType) {
    const normalizedFields: Record<string, unknown> = {
      ...normalizedFieldsCommon,
      time: referenceTime || null,
      title: referenceTitle,
      titleSource: referenceTitleSource,
      titleUsedFallback: referenceTitleUsedFallback,
      titleDerivedFromContext: referenceTitleDerivedFromContext,
      titleContextCandidate: referenceTitleContextCandidate,
      rawDate: referenceRawDate,
      rawExtractedDateText: referenceDateNormalization.rawDateText,
      normalizedDate: referenceDateNormalization.isoDate,
      dateSource: referenceDateNormalization.source,
      dateConfidence: referenceDateNormalization.confidence,
      dateDistanceFromPostDays: referenceDateNormalization.distanceFromPostDays,
      dateInferredYear: referenceDateNormalization.inferredYear,
      dateSuspiciousYear: referenceDateNormalization.suspiciousYear,
      dateYearSelectionReason: referenceDateNormalization.yearSelectionReason,
      dateReason: referenceDateNormalization.reason ?? null,
      artists: referenceArtists,
      description: referenceDescription,
      dateRangeExpanded: !usesSplitEventCandidates && candidateDates.length > 1,
      dateRangeExpandedCount: !usesSplitEventCandidates ? candidateDates.length : 1,
      multiEventSplitDetected: usesSplitEventCandidates,
      multiEventSplitCount: usesSplitEventCandidates ? splitEventCandidates.length : 1,
      splitEventIndex: 1,
      splitEventTotal: usesSplitEventCandidates ? splitEventCandidates.length : 1,
      splitSource: referenceSplitCandidate?.source ?? null,
      splitSourceLine: referenceSplitCandidate?.sourceLine ?? null,
      normalizedIsValid: false,
      normalizedInvalidReason: "missing_required_fields",
      extractionScorecard: buildSkippedExtractionScorecard({
        baseConfidenceScore: confidence,
        fieldConfirmation: extracted.field_confirmation,
        normalizedInvalidReason: "missing_required_fields",
      }),
    };
    return [
      {
        kind: "skip",
        reason: "invalid_event",
        normalizedFields,
      },
    ];
  }

  const { eventVariants, verifiedSharedTime, verifiedSharedVenue } =
    buildStructuredFactVariants({
      baseDescription,
      baseTitle,
      baseTitleSource,
      baseTitleUsedFallback,
      candidateDates,
      canonicalVenueEvidenceSource,
      configuredVenueLocation,
      configuredVenueName,
      dateNormalization,
      effectiveNormalizedVenue,
      eventType,
      extracted,
      extractedArtists,
      extractedTimeIssues,
      extractedTimeResolution,
      independentPostTextEvidence,
      ingestionVenueResolver,
      normalizedSourceHandle,
      normalizedVenue,
      options,
      post,
      rawExtractedTime,
      rawModelVenue,
      selectedImageUrl,
      sourceRole,
      splitEventCandidates,
      time,
      titleNormalization,
      trustedVenueSource,
      usesSplitEventCandidates,
      usesStructuredEvidence,
      venueNormalization,
    });

  return finalizeStructuredFactVariants({
    allowMissingImageForModeration,
    candidateDates,
    canonicalVenueEvidenceSource,
    confidence,
    configuredSourceName,
    configuredVenueLocation,
    configuredVenueName,
    description,
    effectiveVenueSource,
    eventDateFilter,
    eventType,
    eventVariants,
    extracted,
    extractionMode,
    independentPostTextEvidence,
    missingImage,
    normalizedFieldsCommon,
    post,
    postTextEvidence,
    rawModelVenue,
    selectedImageUrl,
    sourceRole,
    splitEventCandidateCount: splitEventCandidates.length,
    ticketPrice,
    trustedVenueSource,
    usesSplitEventCandidates,
    usesStructuredEvidence,
    verifiedSharedTime,
    verifiedSharedVenue,
  });
}

/** Legacy caller compatibility. New ingestion code uses typed fact results. */
export function prepareEventsForInsert(
  ...args: Parameters<typeof produceStructuredFactsForInsert>
): PrepareEventResult[] {
  return prepareStructuredFactsForPersistence(produceStructuredFactsForInsert(...args));
}
