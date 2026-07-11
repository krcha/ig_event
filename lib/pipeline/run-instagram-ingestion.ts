import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import {
  extractEventDataFromInstagramPost,
  type ExtractedEventData,
} from "@/lib/ai/extract-event-data";
import {
  buildCanonicalVenueNamesByHandle,
  canonicalizeVenueName,
  getConfiguredVenueNameForHandle,
  isLowConfidenceVenue,
  normalizeExtractedArtists,
  normalizeExtractedDescription,
  normalizeHandle,
  normalizeVenueFromEvidence,
  toSearchableText,
  type CanonicalVenueRecord,
  type VenueNormalization,
} from "@/lib/pipeline/venue-normalization";
import {
  downloadImage,
  isInstagramOrFbCdnUrl,
  normalizeToJpeg,
  resolveBestImageUrl,
  toDataUrl,
} from "@/lib/ai/prepare-image-for-openai";
import {
  loadRecentApifyRunPosts,
  scrapeInstagramAccount,
  type InstagramScrapedPost,
} from "@/lib/scraper/instagram-scraper";
import {
  AUTO_APPROVE_CONFIDENCE_THRESHOLD,
  CORE_EVENT_AUTO_APPROVE_CONFIDENCE_THRESHOLD,
  calculateModerationConfidenceScore,
  normalizeConfidencePayload,
  normalizeConfidenceScore,
  shouldAutoApproveConfidenceScore,
} from "@/lib/utils/confidence";
import {
  runApprovedEventAutoMerge,
  type ApprovedEventAutoMergeSummary,
} from "@/lib/events/approved-event-automerge";
import {
  checkEventConsistency,
  findNamedWeekday,
  sanitizeTimeAgainstDate,
  type EventConsistencyIssue,
} from "@/lib/events/event-validation";
import {
  extractEventTimeFromText,
  isTbdEventTime,
  TBD_EVENT_TIME,
} from "@/lib/events/event-time";
import { canonicalizeEventType } from "@/lib/taxonomy/venue-types";
import {
  areCompatibleTitleFamilySlugs,
  buildTitleFamilySlug,
  collectComparableTextValues,
  collectComparableIdentityValues,
  collectInstagramHandles,
  countSharedValues,
  hasContextCandidateSupport,
  hasVenueContextSupport,
} from "@/lib/events/deduplication-shared";
import { loadVenueNameOverridesByHandle } from "@/lib/pipeline/venue-name-overrides";
import { getRequiredEnv } from "@/lib/utils/env";

type RunInstagramIngestionOptions = {
  handles: string[];
  resultsLimit?: number;
  daysBack?: number;
  mode?: IngestionRunMode;
  serviceSecret?: string;
};

export type IngestionRunMode = "full_scrape" | "saved_posts";
const MAX_EVENT_DAYS_AHEAD = 90;

type HandleSummary = {
  handle: string;
  fetchedPosts: number;
  fetched_posts: number;
  insertedEvents: number;
  inserted_events: number;
  insertedApprovedEvents: number;
  insertedPendingEvents: number;
  skippedDuplicates: number;
  skipped_duplicates: number;
  skipped_duplicates_clean: number;
  skippedNoImage: number;
  skipped_missing_date: number;
  skipped_missing_venue: number;
  skipped_video: number;
  skipped_invalid_event: number;
  skipped_past_event: number;
  skipped_far_future_event: number;
  updated_duplicates_bad_data: number;
  duplicate_update_failed: number;
  failedDownloads: number;
  failed_downloads: number;
  failedConversions: number;
  failed_conversions: number;
  failedExtractions: number;
  failed_extractions: number;
  failed_extraction: number;
  errors: string[];
};

export type IngestionSummary = {
  startedAt: string;
  finishedAt: string;
  handles: HandleSummary[];
  approvedDuplicateCleanup?: ApprovedEventAutoMergeSummary;
  runContext?: IngestionRunContext;
};

export type IngestionRunContext = {
  activeVenueCount?: number;
  selectedHandleCount?: number;
  skippedRecentlyAttempted?: number;
  skippedDueToRunLimit?: number;
  fullScrapeCooldownHours?: number;
  maxHandlesPerRun?: number;
  resultsLimit?: number;
  daysBack?: number;
  source?: string;
  mode?: IngestionRunMode;
};

export type IngestionBatchState = {
  stateVersion?: number;
  handleIndex: number;
  currentHandle: string | null;
  currentPostIndex: number;
  currentHandlePosts: InstagramScrapedPost[];
  currentScrapedPostCursor?: string | null;
  currentScrapedPostIds?: string[];
  currentScrapedPostIdIndex?: number;
  currentScrapedPostPageDone?: boolean;
  seenSourceKeysByHandle: Record<string, string[]>;
};

export type IngestionBatchStepOptions = {
  handles: string[];
  summary: IngestionSummary;
  state: IngestionBatchState;
  resultsLimit?: number;
  daysBack?: number;
  batchSize?: number;
  mode?: IngestionRunMode;
  postStepLimit?: number;
  scrapedPostPageSize?: number;
  serviceSecret?: string;
};

export type IngestionBatchStepResult = {
  summary: IngestionSummary;
  state: IngestionBatchState;
  done: boolean;
};

export type ActiveVenueIngestionResult = {
  venueHandles: string[];
  summary: IngestionSummary;
};

export type RecentApifyImportSummary = {
  handles: string[];
  runsScanned: number;
  importedPosts: number;
  handlesWithImportedPosts: number;
};

export type ExistingEventImportSummary = {
  handles: string[];
  importedPosts: number;
  handlesWithImportedPosts: number;
  scannedEvents: number;
  skippedPastEvents: number;
  skippedMissingVenue: number;
  skippedMissingSource: number;
};

type IngestionVenueContext = {
  canonicalVenueNamesByHandle: Record<string, string>;
  venueNameOverridesByHandle: Record<string, string>;
  configuredVenueNamesByHandle: Record<string, string>;
};

const getByInstagramPostIdQuery =
  "events:getByInstagramPostId" as unknown as FunctionReference<"query">;
const getByInstagramPostUrlQuery =
  "events:getByInstagramPostUrl" as unknown as FunctionReference<"query">;
const listByInstagramPostIdQuery =
  "events:listByInstagramPostId" as unknown as FunctionReference<"query">;
const listByInstagramPostUrlQuery =
  "events:listByInstagramPostUrl" as unknown as FunctionReference<"query">;
const listByStatusQuery =
  "events:listByStatus" as unknown as FunctionReference<"query">;
const listByDateQuery =
  "events:listByDate" as unknown as FunctionReference<"query">;
const createEventMutation =
  "events:createEvent" as unknown as FunctionReference<"mutation">;
const updateEventMutation =
  "events:updateEvent" as unknown as FunctionReference<"mutation">;
const listActiveVenuesQuery =
  "venues:listActiveVenues" as unknown as FunctionReference<"query">;
const listVenuesQuery =
  "venues:listVenues" as unknown as FunctionReference<"query">;
const listScrapedPostsByHandleQuery =
  "scrapedPosts:listByHandle" as unknown as FunctionReference<"query">;
const listScrapedPostsByHandlePaginatedQuery =
  "scrapedPosts:listByHandlePaginated" as unknown as FunctionReference<"query">;
const getScrapedPostsManyByIdsQuery =
  "scrapedPosts:getManyByIds" as unknown as FunctionReference<"query">;
const upsertScrapedPostsByHandleMutation =
  "scrapedPosts:upsertManyByHandle" as unknown as FunctionReference<"mutation">;
const SCRAPED_POST_UPSERT_BATCH_SIZE = 25;
const DEFAULT_SCRAPED_POST_PAGE_SIZE = 25;
const MAX_SCRAPED_POST_PAGE_SIZE = 100;
const DEFAULT_INGESTION_POST_STEP_LIMIT = 8;
const MAX_INGESTION_POST_STEP_LIMIT = 50;
const DEFAULT_DIRECT_FULL_SCRAPE_CONCURRENCY = 4;
const MAX_DIRECT_FULL_SCRAPE_CONCURRENCY = 16;
const MAX_INGESTION_BATCH_SIZE = 64;
const EXISTING_EVENT_IMPORT_LIMIT_PER_STATUS = 1000;
const STATIC_VENUE_BY_HANDLE: Record<string, string> = {
  "20_44.nightclub": "Klub 20/44",
  kcgrad: "KC Grad",
};
const GENERIC_EVENT_TITLE_PATTERNS = [
  /^(open\s+)?jam\s+session$/i,
  /^[a-z&/+ -]+jam\s+session$/i,
  /^(live\s+music|concert|party|event|session)$/i,
  /^(techno|house|jazz|blues|rock|metal|hip hop|hip-hop|drum and bass|dnb)(\s+(night|session|party))?$/i,
];
const WEAK_EVENT_TITLE_SECTION_TERMS = new Set([
  "aktivnosti",
  "activities",
  "program",
  "lineup",
  "radionice",
  "workshop",
  "workshops",
  "satnica",
  "schedule",
  "raspored",
  "detalji",
  "details",
  "info",
  "informacije",
  "gosti",
  "guests",
  "predavanja",
  "projekcije",
  "screenings",
]);
const CONTEXT_EVENT_TITLE_KEYWORDS = new Set([
  "festival",
  "fest",
  "party",
  "session",
  "night",
  "showcase",
  "weekender",
  "concert",
  "koncert",
  "afterparty",
  "after",
  "takeover",
  "opening",
  "closing",
  "premiere",
  "premijera",
  "birthday",
  "anniversary",
  "matinee",
  "matine",
]);
const CONTEXT_TITLE_STOP_WORDS = new Set([
  "the",
  "this",
  "that",
  "our",
  "your",
  "their",
  "a",
  "an",
  "one",
  "ovaj",
  "ova",
  "ovo",
  "ovde",
  "dobrodosli",
  "dodjite",
  "dodite",
  "join",
  "us",
  "for",
  "na",
  "u",
  "uz",
]);
const CONTEXT_EVENT_TITLE_REGEX =
  /([\p{L}\d][\p{L}\d'’.+/&-]*(?:\s+[\p{L}\d][\p{L}\d'’.+/&-]*){0,4}\s+(festival|fest|party|session|night|showcase|weekender|concert|koncert|afterparty|after|takeover|opening|closing|premiere|premijera|birthday|anniversary|matinee|matine))\b/iu;

type EventStatus = "pending" | "approved" | "rejected";

type PreparedEvent = {
  title: string;
  date: string;
  time?: string;
  venue: string;
  artists: string[];
  description?: string;
  imageUrl?: string;
  instagramPostUrl: string;
  instagramPostId: string;
  ticketPrice?: string;
  eventType: string;
  sourceCaption?: string;
  sourcePostedAt?: string;
  rawExtractionJson?: string;
  normalizedFieldsJson?: string;
  status: EventStatus;
};

type DateSource = "model" | "caption";
type DateConfidence = "high" | "medium" | "low";

type DateCandidate = {
  isoDate: string;
  source: DateSource;
  confidence: DateConfidence;
  distanceFromPostDays: number | null;
  inferredYear: boolean;
  year: number;
  rawYearProvided: boolean;
  raw: string;
  relativeWeekday?: boolean;
  relativeDayOffset?: boolean;
};

type DateNormalization = {
  isoDate: string | null;
  source: DateSource | null;
  confidence: DateConfidence | null;
  distanceFromPostDays: number | null;
  inferredYear: boolean;
  rawDateText: string | null;
  yearSelectionReason: string;
  suspiciousYear: boolean;
  reason?: "missing_date" | "low_confidence" | "implausible_date";
};

type SplitEventCandidateSource = "caption_schedule" | "poster_schedule" | "alt_text_schedule";

type SplitEventCandidate = {
  rawDate: string;
  normalizedDate: DateNormalization;
  lineTitle: string;
  artists: string[];
  time?: string;
  rawTime?: string;
  consistencyIssues: EventConsistencyIssue[];
  description?: string;
  sourceLine: string;
  source: SplitEventCandidateSource;
};

type PrepareEventResult =
  | {
      kind: "ok";
      event: PreparedEvent;
      normalizedFields: Record<string, unknown>;
    }
  | {
      kind: "skip";
      reason:
        | "missing_date"
        | "missing_venue"
        | "invalid_event"
        | "past_event"
        | "far_future";
      normalizedFields: Record<string, unknown>;
    };

type ExistingEventRecord = {
  _id: string;
  title: string;
  date: string;
  time?: string;
  venue: string;
  artists: string[];
  description?: string;
  imageUrl?: string;
  instagramPostUrl?: string;
  instagramPostId?: string;
  ticketPrice?: string;
  eventType: string;
  sourceCaption?: string;
  sourcePostedAt?: string;
  rawExtractionJson?: string;
  normalizedFieldsJson?: string;
  status: EventStatus;
  reviewedAt?: number;
  reviewedBy?: string;
  moderationNote?: string;
};

type ExistingSourceMatch = {
  existingEvent: ExistingEventRecord;
  matchedBy: "post_id" | "shortcode" | "post_url" | "same_date_semantic";
  matchedValue: string;
};

type DuplicateQualityReason =
  | "wrong_year"
  | "bad_venue"
  | "low_confidence"
  | "invalid_required_fields"
  | "invalid_normalized_fields";

type ExistingEventQuality = {
  isLowQuality: boolean;
  primaryReason: DuplicateQualityReason | null;
  reasons: DuplicateQualityReason[];
  details: Record<string, unknown>;
};

type DuplicateUpdateLogEvent =
  | "duplicate_updated_wrong_year"
  | "duplicate_updated_bad_venue"
  | "duplicate_updated_low_confidence"
  | "duplicate_updated_bad_data";

type IngestionStep =
  | "fetch_posts"
  | "normalize_posts"
  | "duplicate_lookup"
  | "extract_event"
  | "update_existing_event"
  | "insert_new_event";

type IngestionPostContext = {
  handle: string;
  sourcePostId: string | null;
  shortcode: string | null;
  instagramUrl: string;
};

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const MONTH_ALIASES: Record<string, number> = {
  ...MONTHS,
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
  januar: 1,
  januara: 1,
  februar: 2,
  februara: 2,
  mart: 3,
  marta: 3,
  aprila: 4,
  maj: 5,
  maja: 5,
  jun: 6,
  juna: 6,
  jul: 7,
  jula: 7,
  avg: 8,
  avgust: 8,
  avgusta: 8,
  septembar: 9,
  septembra: 9,
  okt: 10,
  oktobar: 10,
  oktobra: 10,
  novembar: 11,
  novembra: 11,
  decembar: 12,
  decembra: 12,
  јануар: 1,
  јануара: 1,
  фебруар: 2,
  фебруара: 2,
  март: 3,
  марта: 3,
  април: 4,
  априла: 4,
  мај: 5,
  маја: 5,
  јун: 6,
  јуна: 6,
  јул: 7,
  јула: 7,
  август: 8,
  августа: 8,
  септембар: 9,
  септембра: 9,
  октобар: 10,
  октобра: 10,
  новембар: 11,
  новембра: 11,
  децембар: 12,
  децембра: 12,
};
const DATE_MONTH_WORD_PATTERN = "[A-Za-zČĆŠĐŽčćšđžА-Яа-яЈј]{3,14}";

type RelativeWeekdayQualifier = "this" | "next" | "bare_list";

type RelativeWeekdayMatch = {
  raw: string;
  weekday: number;
  qualifier: RelativeWeekdayQualifier;
};

type RelativeDayOffsetMatch = {
  raw: string;
  offsetDays: number;
};

const RELATIVE_WEEKDAY_ALIASES: Array<{ aliases: string[]; weekday: number }> = [
  {
    aliases: ["monday", "mon", "ponedeljak", "ponedeljka", "pon", "понедељак", "понедељка", "пон"],
    weekday: 1,
  },
  {
    aliases: ["tuesday", "tue", "utorak", "utorka", "uto", "уторак", "уторка", "уто"],
    weekday: 2,
  },
  {
    aliases: ["wednesday", "wed", "sreda", "sredu", "srede", "sre", "среда", "среду", "среде", "сре"],
    weekday: 3,
  },
  {
    aliases: ["thursday", "thu", "cetvrtak", "četvrtak", "cetvrtka", "četvrtka", "cet", "čet", "четвртак", "четвртка", "чет"],
    weekday: 4,
  },
  {
    aliases: ["friday", "fri", "petak", "petka", "pet", "петак", "петка", "пет"],
    weekday: 5,
  },
  {
    aliases: ["saturday", "sat", "subota", "subotu", "subote", "sub", "субота", "суботу", "суботе", "суб"],
    weekday: 6,
  },
  {
    aliases: ["sunday", "sun", "nedelja", "nedjelja", "nedelju", "nedjelju", "ned", "недеља", "недељу", "нед"],
    weekday: 0,
  },
];

const RELATIVE_DAY_OFFSET_ALIASES: Array<{ aliases: string[]; offsetDays: number }> = [
  {
    aliases: ["today", "danas", "данас", "tonight", "veceras", "večeras", "вечерас"],
    offsetDays: 0,
  },
  {
    aliases: ["tomorrow", "sutra", "сутра"],
    offsetDays: 1,
  },
  {
    aliases: ["day after tomorrow", "prekosutra", "prekosjutra", "прекосутра"],
    offsetDays: 2,
  },
];

const MAX_DATE_DISTANCE_DAYS = 180;
const EXISTING_EVENT_CONFIDENCE_THRESHOLD = 0.55;
const DEFAULT_EVENT_TIMEZONE = "Europe/Belgrade";
const DUPLICATE_TEXT_TOKEN_SIMILARITY_THRESHOLD = 0.72;
const DUPLICATE_VENUE_TOKEN_SIMILARITY_THRESHOLD = 0.72;
const CAPTION_ONLY_VIDEO_AUTO_APPROVE_MIN_CONFIDENCE = 0.8;

type ModerationDecision = {
  confidenceScore: number | null;
  autoApproved: boolean;
  autoApproveRule:
    | "confidence_threshold"
    | "caption_only_video_core_fields"
    | "core_event_fields"
    | null;
  pendingReasons: string[];
  signals: string[];
  allowMissingImage: boolean;
};

const UNVERIFIED_POSTER_SCHEDULE_TBD_REASON = "unverified_poster_schedule_tbd";
const NON_EVENT_CLOSURE_NOTICE_REASON = "non_event_closure_notice";

const EXTRACTION_FIELD_LABELS: Array<{
  key: keyof ExtractedEventData["field_confirmation"];
  label: string;
}> = [
  { key: "title", label: "Title" },
  { key: "location", label: "Location" },
  { key: "location_name", label: "Venue" },
  { key: "price", label: "Price" },
  { key: "start_time", label: "Start time" },
  { key: "short_description", label: "Description" },
  { key: "artists", label: "Artists" },
];

function isVideoPostWithoutSelectedImage(
  post: InstagramScrapedPost,
  selectedImageUrl: string | null,
): boolean {
  if (selectedImageUrl) {
    return false;
  }
  const postType = normalizeString(post.postType).toLowerCase();
  return postType.includes("video") || postType.includes("reel");
}

function buildModerationDecision(options: {
  baseConfidenceScore: number | null;
  missingImage: boolean;
  allowMissingImage: boolean;
  titleUsedFallback: boolean;
  missingTime: boolean;
  suspiciousYear: boolean;
  dateConfidence: DateConfidence | null;
  hasDate: boolean;
  hasVenue: boolean;
  extractionMode: "poster" | "caption_only";
  isVideoPost: boolean;
  autoApprovalBlockers?: string[];
}): ModerationDecision {
  const confidenceScore = calculateModerationConfidenceScore(options.baseConfidenceScore, {
    hasSuspectedDuplicates: false,
    missingImage: options.missingImage,
    allowMissingImage: options.allowMissingImage,
  });
  const autoApprovalBlockers = [...new Set(options.autoApprovalBlockers ?? [])];
  const hasAutoApprovalBlockers = autoApprovalBlockers.length > 0;
  const timeTbdApplies = options.missingTime && options.hasDate;
  const signals = [
    ...(options.missingImage ? ["missing_image"] : []),
    ...(options.allowMissingImage ? ["missing_image_allowed"] : []),
    ...(options.titleUsedFallback ? ["fallback_title"] : []),
    ...(timeTbdApplies ? ["time_tbd"] : []),
    ...(options.suspiciousYear ? ["suspicious_year"] : []),
    ...(confidenceScore !== null && confidenceScore < 0.7 ? ["low_confidence"] : []),
    ...autoApprovalBlockers,
  ];

  const qualifiesForStrictConfidence =
    !hasAutoApprovalBlockers && shouldAutoApproveConfidenceScore(confidenceScore);
  const qualifiesForCaptionOnlyVideo =
    !hasAutoApprovalBlockers &&
    options.extractionMode === "caption_only" &&
    options.isVideoPost &&
    options.hasDate &&
    options.hasVenue &&
    !options.suspiciousYear &&
    options.dateConfidence !== "low" &&
    confidenceScore !== null &&
    confidenceScore >= CAPTION_ONLY_VIDEO_AUTO_APPROVE_MIN_CONFIDENCE;
  const qualifiesForCoreEventFields =
    !hasAutoApprovalBlockers &&
    options.hasDate &&
    options.hasVenue &&
    !options.suspiciousYear &&
    options.dateConfidence !== "low" &&
    confidenceScore !== null &&
    confidenceScore >= CORE_EVENT_AUTO_APPROVE_CONFIDENCE_THRESHOLD;
  const autoApproveRule = qualifiesForStrictConfidence
    ? "confidence_threshold"
    : qualifiesForCaptionOnlyVideo
      ? "caption_only_video_core_fields"
      : qualifiesForCoreEventFields
        ? "core_event_fields"
        : null;
  const autoApproved = autoApproveRule !== null;
  const pendingReasons = autoApproved
    ? []
    : [
        ...autoApprovalBlockers,
        ...(confidenceScore === null ? ["missing_confidence"] : []),
        ...(confidenceScore !== null && confidenceScore < CORE_EVENT_AUTO_APPROVE_CONFIDENCE_THRESHOLD
          ? ["below_auto_approve_threshold"]
          : []),
        ...(options.missingImage && !options.allowMissingImage ? ["missing_image"] : []),
        ...(options.suspiciousYear ? ["suspicious_year"] : []),
        ...(options.dateConfidence === "low" ? ["low_date_confidence"] : []),
      ];

  return {
    confidenceScore,
    autoApproved,
    autoApproveRule,
    pendingReasons,
    signals,
    allowMissingImage: options.allowMissingImage,
  };
}

function buildExtractionFieldEvidence(
  fieldConfirmation: ExtractedEventData["field_confirmation"],
) {
  return EXTRACTION_FIELD_LABELS.map(({ key, label }) => {
    const entry = fieldConfirmation[key];
    return {
      field: key,
      label,
      confidence: normalizeConfidenceScore(entry.confidence),
      foundIn: entry.found_in,
      evidence: normalizeString(entry.evidence),
      evidenceSnippets: entry.evidence_snippets
        .map((snippet) => ({
          source: snippet.source,
          text: normalizeString(snippet.text),
        }))
        .filter((snippet) => snippet.text.length > 0),
      notes: normalizeString(entry.notes),
    };
  });
}

function getWeakExtractionFields(
  fieldEvidence: ReturnType<typeof buildExtractionFieldEvidence>,
) {
  return fieldEvidence
    .filter((field) => {
      const hasEvidence =
        field.evidence.length > 0 || field.evidenceSnippets.some((snippet) => snippet.text.length > 0);
      return field.confidence === null || field.confidence < 0.7 || !hasEvidence;
    })
    .map((field) => field.field);
}

function buildSkippedExtractionScorecard(options: {
  baseConfidenceScore: number | null;
  fieldConfirmation: ExtractedEventData["field_confirmation"];
  normalizedInvalidReason: string;
}) {
  const fieldEvidence = buildExtractionFieldEvidence(options.fieldConfirmation);

  return {
    agent: "event_extraction",
    version: 1,
    baseConfidenceScore: options.baseConfidenceScore,
    finalModerationConfidenceScore: null,
    normalizedIsValid: false,
    normalizedInvalidReason: options.normalizedInvalidReason,
    autoApproved: false,
    autoApproveRule: null,
    pendingReasons: [options.normalizedInvalidReason],
    signals: ["normalization_failed"],
    weakFields: getWeakExtractionFields(fieldEvidence),
    fieldEvidence,
  };
}

function buildExtractionScorecard(options: {
  baseConfidenceScore: number | null;
  moderationDecision: ModerationDecision;
  fieldConfirmation: ExtractedEventData["field_confirmation"];
  normalizedIsValid: boolean;
  normalizedInvalidReason: string | null;
}) {
  const fieldEvidence = buildExtractionFieldEvidence(options.fieldConfirmation);

  return {
    agent: "event_extraction",
    version: 1,
    baseConfidenceScore: options.baseConfidenceScore,
    finalModerationConfidenceScore: options.moderationDecision.confidenceScore,
    normalizedIsValid: options.normalizedIsValid,
    normalizedInvalidReason: options.normalizedInvalidReason,
    autoApproved: options.moderationDecision.autoApproved,
    autoApproveRule: options.moderationDecision.autoApproveRule,
    pendingReasons: options.moderationDecision.pendingReasons,
    signals: options.moderationDecision.signals,
    weakFields: getWeakExtractionFields(fieldEvidence),
    fieldEvidence,
  };
}

function logInfo(event: string, payload: Record<string, unknown>) {
  console.info(
    JSON.stringify({
      level: "info",
      event,
      ...payload,
    }),
  );
}

function logError(event: string, payload: Record<string, unknown>) {
  console.error(
    JSON.stringify({
      level: "error",
      event,
      ...payload,
    }),
  );
}

function normalizeDirectFullScrapeConcurrency(
  value: string | undefined = process.env.INGESTION_FULL_SCRAPE_CONCURRENCY,
): number {
  if (!value) {
    return DEFAULT_DIRECT_FULL_SCRAPE_CONCURRENCY;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_DIRECT_FULL_SCRAPE_CONCURRENCY;
  }

  return Math.min(parsed, MAX_DIRECT_FULL_SCRAPE_CONCURRENCY);
}

function normalizeBoundedPositiveInteger(options: {
  value: number | string | undefined;
  defaultValue: number;
  maxValue: number;
}): number {
  if (options.value === undefined || options.value === null || options.value === "") {
    return options.defaultValue;
  }

  const parsed =
    typeof options.value === "number"
      ? options.value
      : Number.parseInt(String(options.value), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return options.defaultValue;
  }

  return Math.min(Math.trunc(parsed), options.maxValue);
}

function normalizeIngestionPostStepLimit(value?: number): number {
  return normalizeBoundedPositiveInteger({
    value: value ?? process.env.INGESTION_POST_STEP_LIMIT,
    defaultValue: DEFAULT_INGESTION_POST_STEP_LIMIT,
    maxValue: MAX_INGESTION_POST_STEP_LIMIT,
  });
}

function normalizeScrapedPostPageSize(value?: number): number {
  return normalizeBoundedPositiveInteger({
    value: value ?? process.env.SCRAPED_POST_PAGE_SIZE,
    defaultValue: DEFAULT_SCRAPED_POST_PAGE_SIZE,
    maxValue: MAX_SCRAPED_POST_PAGE_SIZE,
  });
}

function getConfiguredServiceSecret(explicitSecret?: string): string {
  const serviceSecret = explicitSecret ?? process.env.CRON_SECRET?.trim();
  if (!serviceSecret) {
    throw new Error("CRON_SECRET is required for ingestion Convex writes.");
  }
  return serviceSecret;
}

function withServiceSecret<T extends Record<string, unknown>>(
  args: T,
  serviceSecret: string,
): T & { serviceSecret: string } {
  return {
    ...args,
    serviceSecret,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}

function getPostContext(handle: string, post: InstagramScrapedPost): IngestionPostContext {
  const sourcePostId = normalizeString(post.postId) || null;
  const instagramUrl = normalizeString(post.instagramPostUrl) || "";
  return {
    handle,
    sourcePostId,
    shortcode: extractShortcodeFromPostUrl(instagramUrl),
    instagramUrl,
  };
}

function getConvexClient(): ConvexHttpClient {
  const convexUrl = getRequiredEnv("NEXT_PUBLIC_CONVEX_URL");
  return new ConvexHttpClient(convexUrl);
}

type ActiveVenueRecord = {
  name: string;
  instagramHandle: string;
};

type VenueRecord = CanonicalVenueRecord;

type EventImportRecord = {
  _id: string;
  title: string;
  date: string;
  time?: string;
  venue: string;
  artists: string[];
  description?: string;
  imageUrl?: string;
  instagramPostUrl?: string;
  instagramPostId?: string;
  sourceCaption?: string;
  sourcePostedAt?: string;
};

type SavedScrapedPostRecord = {
  _id: string;
  handle: string;
  postId: string;
  caption?: string;
  altText?: string;
  imageUrl?: string;
  imageUrls: string[];
  postType?: string;
  locationName?: string;
  instagramPostUrl: string;
  postedAt?: string;
  postedAtMs?: number;
  sourceKey?: string;
  username: string;
  createdAt: number;
  updatedAt: number;
};

type ScrapedPostsPage = {
  page: SavedScrapedPostRecord[];
  isDone: boolean;
  continueCursor: string;
};

async function loadCanonicalVenueNamesByHandle(
  client: ConvexHttpClient,
  serviceSecret: string,
): Promise<Record<string, string>> {
  const venues = (await client.query(
    listVenuesQuery,
    withServiceSecret({}, serviceSecret),
  )) as VenueRecord[];
  return buildCanonicalVenueNamesByHandle(venues);
}

function buildConfiguredVenueNamesByHandle(
  canonicalVenueNamesByHandle: Record<string, string>,
  venueNameOverridesByHandle: Record<string, string>,
): Record<string, string> {
  return {
    ...canonicalVenueNamesByHandle,
    ...venueNameOverridesByHandle,
  };
}

function humanizeHandle(
  handle: string,
  configuredVenueNamesByHandle: Record<string, string>,
): string {
  const normalized = normalizeHandle(handle);
  const mappedVenue = getConfiguredVenueNameForHandle(
    handle,
    configuredVenueNamesByHandle,
    STATIC_VENUE_BY_HANDLE,
  );
  if (mappedVenue) {
    return mappedVenue;
  }

  const tokens = normalized
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    return normalized;
  }

  return tokens
    .map((token) => {
      const lower = token.toLowerCase();
      if (lower === "i" || lower === "x" || lower === "b2b") {
        return lower;
      }
      if (lower.length <= 3 && /^[a-z0-9]+$/.test(lower)) {
        return lower.toUpperCase();
      }
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

function buildFallbackTitle(
  post: InstagramScrapedPost,
  venue: VenueNormalization,
  canonicalVenueNamesByHandle: Record<string, string>,
  configuredVenueNamesByHandle: Record<string, string>,
): string {
  const mappedVenue = getConfiguredVenueNameForHandle(
    post.username,
    configuredVenueNamesByHandle,
    STATIC_VENUE_BY_HANDLE,
  );
  if (mappedVenue) {
    return mappedVenue;
  }

  const locationName = normalizeString(post.locationName);
  if (locationName) {
    return (
      canonicalizeVenueName(locationName, canonicalVenueNamesByHandle, {
        preferredVenue: mappedVenue || null,
        staticVenueByHandle: STATIC_VENUE_BY_HANDLE,
      }) ??
      locationName
    );
  }

  if (venue.source === "handle_map" && venue.venue) {
    return venue.venue;
  }

  return humanizeHandle(post.username, configuredVenueNamesByHandle);
}

function isGenericEventTitle(value: string): boolean {
  return GENERIC_EVENT_TITLE_PATTERNS.some((pattern) => pattern.test(value.trim()));
}

function trimTitleCandidate(value: string): string {
  return value.replace(/^[\s"'“”‘’]+|[\s"'“”‘’.,:;!?]+$/gu, "").trim();
}

function getWeakEventTitleSectionParts(
  value: string,
): { baseTitle: string; sectionTerm: string } | null {
  const trimmed = normalizeString(value);
  if (!trimmed) {
    return null;
  }

  const tokens = trimmed.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return null;
  }

  const lastToken = tokens[tokens.length - 1] ?? "";
  if (WEAK_EVENT_TITLE_SECTION_TERMS.has(toSearchableText(lastToken))) {
    return {
      baseTitle: tokens.slice(0, -1).join(" "),
      sectionTerm: lastToken,
    };
  }

  if (tokens.length === 1 && WEAK_EVENT_TITLE_SECTION_TERMS.has(toSearchableText(tokens[0]))) {
    return {
      baseTitle: "",
      sectionTerm: tokens[0],
    };
  }

  return null;
}

function isWeakEventTitleSectionHeading(value: string): boolean {
  const parts = getWeakEventTitleSectionParts(value);
  if (!parts) {
    return false;
  }
  return parts.baseTitle.length === 0 || parts.baseTitle.split(/\s+/).length <= 4;
}

function extractContextEventTitleKeyword(value: string): string | null {
  const tokens = toSearchableText(value).split(" ").filter((token) => token.length > 0);
  const lastToken = tokens[tokens.length - 1] ?? "";
  return CONTEXT_EVENT_TITLE_KEYWORDS.has(lastToken) ? lastToken : null;
}

function formatContextEventTitleKeyword(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function normalizeContextDerivedTitle(value: string): string {
  const trimmed = trimTitleCandidate(value);
  if (!trimmed) {
    return "";
  }

  const tokens = trimmed.split(/\s+/);
  const keyword = extractContextEventTitleKeyword(trimmed);
  if (!keyword || tokens.length === 0) {
    return trimmed;
  }

  tokens[tokens.length - 1] = formatContextEventTitleKeyword(keyword);
  return tokens.join(" ");
}

function extractContextualEventTitleCandidate(value: string): string | null {
  const trimmed = normalizeString(value);
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(CONTEXT_EVENT_TITLE_REGEX);
  if (!match) {
    return null;
  }

  return trimTitleCandidate(match[1] ?? "");
}

function isUsableContextEventTitleCandidate(
  candidate: string,
  post: InstagramScrapedPost,
  venue: VenueNormalization,
  configuredVenueNamesByHandle: Record<string, string>,
): boolean {
  const normalizedCandidate = toSearchableText(candidate);
  if (!normalizedCandidate) {
    return false;
  }

  const candidateTokens = normalizedCandidate.split(" ").filter((token) => token.length > 0);
  if (candidateTokens.length < 2 || candidateTokens.length > 6) {
    return false;
  }

  if (isGenericEventTitle(candidate) || isWeakEventTitleSectionHeading(candidate)) {
    return false;
  }

  const keyword = extractContextEventTitleKeyword(candidate);
  if (!keyword) {
    return false;
  }

  const baseTokens = candidateTokens
    .slice(0, -1)
    .filter((token) => !CONTEXT_TITLE_STOP_WORDS.has(token));
  if (baseTokens.length === 0) {
    return false;
  }

  const normalizedVenue = toSearchableText(venue.venue ?? "");
  if (normalizedVenue && normalizedCandidate === normalizedVenue) {
    return false;
  }

  const normalizedHandleTitle = toSearchableText(
    humanizeHandle(post.username, configuredVenueNamesByHandle),
  );
  if (normalizedHandleTitle && normalizedCandidate === normalizedHandleTitle) {
    return false;
  }

  return true;
}

function buildContextDerivedEventTitle(
  rawTitle: string,
  extracted: ExtractedEventData,
  post: InstagramScrapedPost,
  venue: VenueNormalization,
  configuredVenueNamesByHandle: Record<string, string>,
): { title: string; contextCandidate: string } | null {
  const rawTitleParts = getWeakEventTitleSectionParts(rawTitle);
  const contextSources = [
    normalizeString(extracted.description),
    normalizeString(post.caption),
  ];

  for (const sourceText of contextSources) {
    const candidate = extractContextualEventTitleCandidate(sourceText);
    if (
      !candidate ||
      !isUsableContextEventTitleCandidate(
        candidate,
        post,
        venue,
        configuredVenueNamesByHandle,
      )
    ) {
      continue;
    }

    const keyword = extractContextEventTitleKeyword(candidate);
    const normalizedRawBaseTitle = toSearchableText(rawTitleParts?.baseTitle ?? "");
    const normalizedVenue = toSearchableText(venue.venue ?? "");
    const normalizedHandleTitle = toSearchableText(
      humanizeHandle(post.username, configuredVenueNamesByHandle),
    );
    if (
      rawTitleParts?.baseTitle &&
      keyword &&
      normalizedRawBaseTitle &&
      normalizedRawBaseTitle !== normalizedVenue &&
      normalizedRawBaseTitle !== normalizedHandleTitle &&
      !isGenericEventTitle(rawTitleParts.baseTitle) &&
      !isWeakEventTitleSectionHeading(rawTitleParts.baseTitle)
    ) {
      return {
        title: `${rawTitleParts.baseTitle} ${formatContextEventTitleKeyword(keyword)}`.trim(),
        contextCandidate: candidate,
      };
    }

    return {
      title: normalizeContextDerivedTitle(candidate),
      contextCandidate: candidate,
    };
  }

  return null;
}

function normalizeEventTitle(
  post: InstagramScrapedPost,
  extracted: ExtractedEventData,
  venue: VenueNormalization,
  canonicalVenueNamesByHandle: Record<string, string>,
  configuredVenueNamesByHandle: Record<string, string>,
): {
  title: string;
  source: "model" | "context_derived" | "handle_fallback";
  rawTitle: string;
  usedFallback: boolean;
  contextCandidate: string | null;
} {
  const rawTitle = normalizeString(extracted.title);
  const captionText = normalizeString(post.caption);
  const normalizedRawTitle = toSearchableText(rawTitle);
  const normalizedCaption = toSearchableText(captionText);
  const titleAppearsInCaption =
    normalizedRawTitle.length > 0 && normalizedCaption.includes(normalizedRawTitle);
  const weakSectionTitle = isWeakEventTitleSectionHeading(rawTitle);

  if (
    rawTitle &&
    !weakSectionTitle &&
    (!isGenericEventTitle(rawTitle) || titleAppearsInCaption)
  ) {
    return {
      title: rawTitle,
      source: "model",
      rawTitle,
      usedFallback: false,
      contextCandidate: null,
    };
  }

  const contextDerivedTitle = buildContextDerivedEventTitle(
    rawTitle,
    extracted,
    post,
    venue,
    configuredVenueNamesByHandle,
  );
  if (contextDerivedTitle) {
    return {
      title: contextDerivedTitle.title,
      source: "context_derived",
      rawTitle,
      usedFallback: false,
      contextCandidate: contextDerivedTitle.contextCandidate,
    };
  }

  return {
    title: buildFallbackTitle(
      post,
      venue,
      canonicalVenueNamesByHandle,
      configuredVenueNamesByHandle,
    ),
    source: "handle_fallback",
    rawTitle,
    usedFallback: true,
    contextCandidate: null,
  };
}

function cleanSplitCaptionEntryText(value: string): string {
  return trimTitleCandidate(
    normalizeString(value)
      .replace(/@\S+/g, "")
      .replace(/\s*[•·|]+\s*/g, " ")
      .replace(/\s+/g, " "),
  );
}

const SPLIT_ENTRY_WEEKDAY_PREFIX_REGEX =
  /^(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|ponedeljak|pon|utorak|uto|sreda|sre|cetvrtak|četvrtak|cet|čet|petak|pet|subota|sub|nedelja|nedjelja|ned)\b[\s,.:;-]*/iu;

function stripSplitEntryDateText(value: string, rawDate: string): string {
  let stripped = normalizeString(value);
  const normalizedRawDate = normalizeString(rawDate);
  if (normalizedRawDate) {
    stripped = stripped.replace(normalizedRawDate, " ");
  }

  return stripped
    .replace(SPLIT_ENTRY_WEEKDAY_PREFIX_REGEX, "")
    .replace(/\b(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|ponedeljak|pon|utorak|uto|sreda|sre|cetvrtak|četvrtak|cet|čet|petak|pet|subota|sub|nedelja|nedjelja|ned)\b/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelyCaptionContextTitle(value: string): boolean {
  const normalized = cleanSplitCaptionEntryText(value);
  if (!normalized || normalized.length > 80) {
    return false;
  }
  if (findNamedWeekday(normalized) !== null) {
    return false;
  }
  if (collectDateCandidates(normalized, "caption", null).length > 0) {
    return false;
  }
  if (/^(?:video|photo|poster|tickets?|karte?|info|ulaz|free|gratis)$/iu.test(normalized)) {
    return false;
  }
  return /[\p{L}\p{N}]/u.test(normalized);
}

function extractPostAltTextEvidence(value: string | null | undefined): string {
  const normalized = normalizeString(value);
  if (!normalized) {
    return "";
  }

  const explicitTextMatch = normalized.match(/\btext that says\s*['"]?(.+?)['"]?\.?$/iu);
  if (explicitTextMatch?.[1]) {
    return normalizeString(explicitTextMatch[1]);
  }

  return normalized
    .replace(/^photo by .*? on .*?\.\s*/iu, "")
    .replace(/^may be an image of .*?\btext that says\s*/iu, "")
    .replace(/^['"]|['"]$/g, "")
    .trim();
}

function buildIndependentPostTextEvidence(post: InstagramScrapedPost): string {
  return [...new Set([
    normalizeString(post.caption),
    extractPostAltTextEvidence(post.altText),
  ])]
    .filter((value) => value.length > 0)
    .join("\n");
}

function buildPostTextEvidence(
  post: InstagramScrapedPost,
  extracted?: Pick<ExtractedEventData, "source_caption">,
): string {
  return [...new Set([
    buildIndependentPostTextEvidence(post),
    normalizeString(extracted?.source_caption),
  ])]
    .filter((value) => value.length > 0)
    .join("\n");
}

export function getPosterScheduleAutoApprovalBlockers(options: {
  splitSource: string | null | undefined;
  independentTextEvidence: string | null | undefined;
  hasTime: boolean;
}): string[] {
  if (
    options.splitSource === "poster_schedule" &&
    !normalizeString(options.independentTextEvidence) &&
    !options.hasTime
  ) {
    return [UNVERIFIED_POSTER_SCHEDULE_TBD_REASON];
  }
  return [];
}

export function isNonEventClosureNotice(value: string | null | undefined): boolean {
  const text = normalizeString(value);
  if (!text) {
    return false;
  }

  return /\bclosed\s+for\s+vacation\b|\bcollective\s+vacation\b|\bkolektivni\s+godi[sš]nji\s+odmor\b|\bgodi[sš]nji\s+odmor\b|\bzatvoreno\s+(?:zbog|radi|od)\b/iu.test(
    text,
  );
}

export function getNonEventAutoApprovalBlockers(value: string | null | undefined): string[] {
  return isNonEventClosureNotice(value) ? [NON_EVENT_CLOSURE_NOTICE_REASON] : [];
}

function parseSplitCaptionEntryArtists(value: string): string[] {
  return [...new Set(
    value
      .split(/\s*(?:,|&|\+|\bb2b\b|\band\b)\s*/iu)
      .map((item) => trimTitleCandidate(item))
      .filter((item) => item.length > 0),
  )];
}

function hasMultipleResolvedSplitDates(entries: SplitEventCandidate[]): boolean {
  const uniqueResolvedDates = new Set(
    entries
      .map((entry) => entry.normalizedDate.isoDate)
      .filter((value): value is string => Boolean(value)),
  );

  return uniqueResolvedDates.size >= 2;
}

function buildSplitEventSourceLine(parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => normalizeString(part))
    .filter((part) => part.length > 0)
    .join(" | ");
}

function extractSplitEntryTime(value: string): string | undefined {
  return extractEventTimeFromText(value);
}

function stripSplitEntryTime(value: string): string {
  return value
    .replace(/\b\d{1,2}\s*[-–—]\s*\d{1,2}\s*h\b/giu, " ")
    .replace(/\b\d{1,2}\s*h\b/giu, " ")
    .replace(/\b\d{1,2}[:.]\d{2}\b/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractModelSplitEventCandidates(
  post: InstagramScrapedPost,
  extracted: ExtractedEventData,
): SplitEventCandidate[] {
  if (extracted.schedule_entries.length === 0) {
    return [];
  }

  const entries: SplitEventCandidate[] = [];
  const seenEntries = new Set<string>();
  const rawResolvedDates = new Set<string>();

  for (const scheduleEntry of extracted.schedule_entries) {
    const rawDate = normalizeString(scheduleEntry.date);
    const normalizedArtists = normalizeExtractedArtists(scheduleEntry.artists);
    const rawTitle = cleanSplitCaptionEntryText(scheduleEntry.title);
    const lineTitle = rawTitle || normalizedArtists.join(", ");
    if (!rawDate || !lineTitle) {
      continue;
    }

    const description = normalizeExtractedDescription(scheduleEntry.description);
    const rawScheduleTime = normalizeString(scheduleEntry.time);
    const sourceLine =
      normalizeString(scheduleEntry.source_text) ||
      buildSplitEventSourceLine([rawDate, rawTitle, rawScheduleTime, description]);
    const timeResolution = resolveEventTimeFromExtractionAndEvidence({
      rawDate,
      rawTime: rawScheduleTime,
      textEvidence: [
        { source: "description", text: description },
        { source: "source_caption", text: sourceLine },
      ],
    });
    const rawTime = timeResolution.rawTime;
    const normalizedDate = normalizeEventDate(rawDate, sourceLine || rawDate, post.postedAt);
    if (normalizedDate.isoDate) {
      rawResolvedDates.add(normalizedDate.isoDate);
    }
    const consistency = checkEventConsistency({
      isoDate: normalizedDate.isoDate,
      rawDateText: rawDate,
      time: timeResolution.time,
      weekdayEvidence: sourceLine,
    });
    const time = consistency.sanitizedTime;
    const dedupeKey = `${normalizedDate.isoDate ?? rawDate}:${toSearchableText(lineTitle)}`;
    if (seenEntries.has(dedupeKey)) {
      continue;
    }
    seenEntries.add(dedupeKey);

    entries.push({
      rawDate,
      normalizedDate,
      lineTitle,
      artists:
        normalizedArtists.length > 0 ? normalizedArtists : parseSplitCaptionEntryArtists(lineTitle),
      ...(time ? { time } : {}),
      rawTime,
      consistencyIssues: consistency.issues,
      ...(description ? { description } : {}),
      sourceLine,
      source: "poster_schedule",
    });
  }

  return hasMultipleResolvedSplitDates(entries) || rawResolvedDates.size >= 2 ? entries : [];
}

function extractCaptionSplitEventCandidates(
  post: InstagramScrapedPost,
  extracted: ExtractedEventData,
): SplitEventCandidate[] {
  const captionText = normalizeString(post.caption || extracted.source_caption);
  if (!captionText) {
    return [];
  }

  const entries: SplitEventCandidate[] = [];
  const seenEntries = new Set<string>();
  const postDate = parsePostedAt(post.postedAt);
  let previousContextTitle = "";

  for (const rawLine of captionText.split(/\r?\n/)) {
    const line = normalizeString(rawLine);
    if (!line) {
      continue;
    }

    const explicitScheduleMatch = line.match(
      /^(\d{1,2}[./-]\d{1,2}(?:[./-](?:\d{2}|\d{4}))?)\s*[•·|:\-–—]+\s*(.+)$/u,
    );

    const normalizedDate = explicitScheduleMatch
      ? normalizeEventDate(normalizeString(explicitScheduleMatch[1]), line, post.postedAt)
      : normalizeEventDate(line, line, post.postedAt);
    const rawDate = explicitScheduleMatch
      ? normalizeString(explicitScheduleMatch[1])
      : normalizeString(
          collectDateCandidates(line, "caption", postDate)[0]?.raw ??
            normalizedDate.rawDateText,
        );

    if (!normalizedDate.isoDate || !rawDate) {
      if (isLikelyCaptionContextTitle(line)) {
        previousContextTitle = cleanSplitCaptionEntryText(line);
      }
      continue;
    }

    const rawTime = extractSplitEntryTime(line);
    const time = sanitizeTimeAgainstDate(rawTime, rawDate);
    const rawTitle = explicitScheduleMatch
      ? explicitScheduleMatch[2] ?? ""
      : stripSplitEntryTime(stripSplitEntryDateText(line, rawDate));
    const lineTitle = cleanSplitCaptionEntryText(rawTitle) || previousContextTitle;
    if (!lineTitle) {
      continue;
    }

    const consistency = checkEventConsistency({
      isoDate: normalizedDate.isoDate,
      rawDateText: rawDate,
      time,
      weekdayEvidence: line,
    });

    const dedupeKey = `${normalizedDate.isoDate}:${toSearchableText(lineTitle)}`;
    if (seenEntries.has(dedupeKey)) {
      continue;
    }
    seenEntries.add(dedupeKey);

    entries.push({
      rawDate,
      normalizedDate,
      lineTitle,
      artists: parseSplitCaptionEntryArtists(lineTitle),
      ...(consistency.sanitizedTime ? { time: consistency.sanitizedTime } : {}),
      rawTime,
      consistencyIssues: consistency.issues,
      sourceLine: line,
      source: "caption_schedule",
    });
  }

  return hasMultipleResolvedSplitDates(entries) ? entries : [];
}

function extractAltTextSplitEventCandidates(
  post: InstagramScrapedPost,
): SplitEventCandidate[] {
  const altText = extractPostAltTextEvidence(post.altText);
  if (!altText) {
    return [];
  }

  const compactText = altText.replace(/\s+/g, " ").trim();
  const dateMatches = [...compactText.matchAll(
    /\b(\d{1,2}[./-]\d{1,2}(?:[./-](?:\d{2}|\d{4}))?)\b/gu,
  )];
  if (dateMatches.length < 2) {
    return [];
  }

  const entries: SplitEventCandidate[] = [];
  const seenEntries = new Set<string>();

  for (const [index, match] of dateMatches.entries()) {
    const rawDate = normalizeString(match[1]);
    const startIndex = (match.index ?? 0) + match[0].length;
    const endIndex = dateMatches[index + 1]?.index ?? compactText.length;
    const rawSegment = compactText
      .slice(startIndex, endIndex)
      .replace(/^[\s•·|:\-–—]+/u, "")
      .replace(/\b\d{6,}\b.*$/u, "")
      .trim();
    const rawTime = extractSplitEntryTime(rawSegment);
    const time = sanitizeTimeAgainstDate(rawTime, rawDate);
    const lineTitle = cleanSplitCaptionEntryText(stripSplitEntryTime(rawSegment));
    if (!rawDate || !lineTitle) {
      continue;
    }

    const sourceLine = buildSplitEventSourceLine([rawDate, lineTitle, time]);
    const normalizedDate = normalizeEventDate(rawDate, sourceLine || rawSegment, post.postedAt);
    const consistency = checkEventConsistency({
      isoDate: normalizedDate.isoDate,
      rawDateText: rawDate,
      time,
      weekdayEvidence: sourceLine,
    });
    const dedupeKey = `${normalizedDate.isoDate ?? rawDate}:${toSearchableText(lineTitle)}`;
    if (seenEntries.has(dedupeKey)) {
      continue;
    }
    seenEntries.add(dedupeKey);

    entries.push({
      rawDate,
      normalizedDate,
      lineTitle,
      artists: parseSplitCaptionEntryArtists(lineTitle),
      ...(consistency.sanitizedTime ? { time: consistency.sanitizedTime } : {}),
      rawTime,
      consistencyIssues: consistency.issues,
      sourceLine,
      source: "alt_text_schedule",
    });
  }

  return hasMultipleResolvedSplitDates(entries) ? entries : [];
}

function extractSplitEventCandidates(
  post: InstagramScrapedPost,
  extracted: ExtractedEventData,
): SplitEventCandidate[] {
  const modelCandidates = extractModelSplitEventCandidates(post, extracted);
  if (modelCandidates.length > 0) {
    return modelCandidates;
  }

  const captionCandidates = extractCaptionSplitEventCandidates(post, extracted);
  if (captionCandidates.length > 1) {
    return captionCandidates;
  }

  const altTextCandidates = extractAltTextSplitEventCandidates(post);
  return altTextCandidates.length > 1 ? altTextCandidates : [];
}

function buildSplitEventDescription(
  eventType: string,
  venue: string | null,
  artists: string[],
): string | undefined {
  const normalizedArtists = artists.map((artist) => normalizeString(artist)).filter(Boolean);
  if (normalizedArtists.length === 0) {
    return undefined;
  }

  const normalizedEventType = normalizeString(eventType);
  const humanizedEventType = normalizedEventType
    ? `${normalizedEventType.charAt(0).toUpperCase()}${normalizedEventType.slice(1)}`
    : "Event";
  const eventLabel =
    humanizedEventType === "Event" || /\bevent\b/i.test(humanizedEventType)
      ? humanizedEventType
      : `${humanizedEventType} event`;
  const venueSuffix = venue ? ` at ${venue}` : "";
  return `${eventLabel} with ${normalizedArtists.join(", ")}${venueSuffix}.`;
}

function createEmptyHandleSummary(handle: string): HandleSummary {
  return {
    handle,
    fetchedPosts: 0,
    fetched_posts: 0,
    insertedEvents: 0,
    inserted_events: 0,
    insertedApprovedEvents: 0,
    insertedPendingEvents: 0,
    skippedDuplicates: 0,
    skipped_duplicates: 0,
    skipped_duplicates_clean: 0,
    skippedNoImage: 0,
    skipped_missing_date: 0,
    skipped_missing_venue: 0,
    skipped_video: 0,
    skipped_invalid_event: 0,
    skipped_past_event: 0,
    skipped_far_future_event: 0,
    updated_duplicates_bad_data: 0,
    duplicate_update_failed: 0,
    failedDownloads: 0,
    failed_downloads: 0,
    failedConversions: 0,
    failed_conversions: 0,
    failedExtractions: 0,
    failed_extractions: 0,
    failed_extraction: 0,
    errors: [],
  };
}

function getOrCreateHandleSummary(summary: IngestionSummary, handle: string): HandleSummary {
  const existing = summary.handles.find((entry) => entry.handle === handle);
  if (existing) {
    Object.assign(existing, {
      ...createEmptyHandleSummary(handle),
      ...existing,
      errors: Array.isArray(existing.errors) ? existing.errors : [],
    });
    return existing;
  }
  const created = createEmptyHandleSummary(handle);
  summary.handles.push(created);
  return created;
}

export function createEmptyIngestionSummary(
  handles: string[],
  runContext?: IngestionRunContext,
): IngestionSummary {
  const now = new Date().toISOString();
  return {
    startedAt: now,
    finishedAt: now,
    handles: handles.map((handle) => createEmptyHandleSummary(handle)),
    ...(runContext ? { runContext } : {}),
  };
}

export function createInitialIngestionBatchState(): IngestionBatchState {
  return {
    stateVersion: 2,
    handleIndex: 0,
    currentHandle: null,
    currentPostIndex: 0,
    currentHandlePosts: [],
    currentScrapedPostCursor: null,
    currentScrapedPostIds: [],
    currentScrapedPostIdIndex: 0,
    currentScrapedPostPageDone: false,
    seenSourceKeysByHandle: {},
  };
}

async function runApprovedDuplicateCleanupForIngestion(
  client: ConvexHttpClient,
  summary: IngestionSummary,
  options: {
    mode: IngestionRunMode;
    handles: string[];
    serviceSecret: string;
  },
): Promise<void> {
  try {
    const cleanupSummary = await runApprovedEventAutoMerge(client, {
      serviceSecret: options.serviceSecret,
    });
    summary.approvedDuplicateCleanup = cleanupSummary;

    logInfo("ingestion.approved_duplicates.auto_merged", {
      mode: options.mode,
      handles: options.handles,
      approvedCount: cleanupSummary.approvedCount,
      scannedEventCount: cleanupSummary.scannedEventCount,
      duplicateGroupCount: cleanupSummary.duplicateGroupCount,
      mergedGroupCount: cleanupSummary.mergedGroupCount,
      mergedDuplicateCount: cleanupSummary.mergedDuplicateCount,
      remainingGroupCount: cleanupSummary.remainingGroupCount,
      failedCount: cleanupSummary.failedCount,
      passes: cleanupSummary.passes,
    });
  } catch (error) {
    const message = getErrorMessage(error);
    summary.approvedDuplicateCleanup = {
      approvedCount: 0,
      finalApprovedCount: 0,
      scannedEventCount: 0,
      duplicateGroupCount: 0,
      mergedGroupCount: 0,
      mergedDuplicateCount: 0,
      remainingGroupCount: 0,
      failedCount: 1,
      failures: [],
      passes: 0,
      error: message,
    };

    logError("ingestion.approved_duplicates.auto_merge_failed", {
      mode: options.mode,
      handles: options.handles,
      error: message,
    });
  }
}

async function loadIngestionVenueContext(
  client: ConvexHttpClient,
  serviceSecret: string,
): Promise<IngestionVenueContext> {
  let canonicalVenueNamesByHandle: Record<string, string> = {};
  let venueNameOverridesByHandle: Record<string, string> = {};
  let configuredVenueNamesByHandle: Record<string, string> = {};

  try {
    canonicalVenueNamesByHandle = await loadCanonicalVenueNamesByHandle(
      client,
      serviceSecret,
    );
    try {
      venueNameOverridesByHandle = await loadVenueNameOverridesByHandle();
    } catch (error) {
      logError("ingestion.venues.override_load_failed", {
        step: "normalize_posts" satisfies IngestionStep,
        error: getErrorMessage(error),
      });
    }
    configuredVenueNamesByHandle = buildConfiguredVenueNamesByHandle(
      canonicalVenueNamesByHandle,
      venueNameOverridesByHandle,
    );
  } catch (error) {
    logError("ingestion.venues.load_failed", {
      step: "normalize_posts" satisfies IngestionStep,
      error: getErrorMessage(error),
    });
  }

  return {
    canonicalVenueNamesByHandle,
    venueNameOverridesByHandle,
    configuredVenueNamesByHandle,
  };
}

function chunkItems<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function persistScrapedPostsForHandle(
  client: ConvexHttpClient,
  handle: string,
  posts: InstagramScrapedPost[],
  serviceSecret: string,
): Promise<void> {
  if (posts.length === 0) {
    return;
  }

  for (const postBatch of chunkItems(posts, SCRAPED_POST_UPSERT_BATCH_SIZE)) {
    await client.mutation(
      upsertScrapedPostsByHandleMutation,
      withServiceSecret(
        {
          handle,
          posts: postBatch.map((post) => ({
            handle,
            postId: post.postId,
            ...(post.caption ? { caption: post.caption } : {}),
            ...(post.altText ? { altText: post.altText } : {}),
            ...(post.imageUrl ? { imageUrl: post.imageUrl } : {}),
            imageUrls: post.imageUrls,
            ...(post.postType ? { postType: post.postType } : {}),
            ...(post.locationName ? { locationName: post.locationName } : {}),
            instagramPostUrl: post.instagramPostUrl,
            ...(post.postedAt ? { postedAt: post.postedAt } : {}),
            username: post.username,
          })),
        },
        serviceSecret,
      ),
    );
  }
}

async function loadSavedScrapedPostsForHandle(
  client: ConvexHttpClient,
  handle: string,
  resultsLimit: number | undefined,
  daysBack: number | undefined,
  serviceSecret: string,
): Promise<InstagramScrapedPost[]> {
  const savedPosts = (await client.query(
    listScrapedPostsByHandleQuery,
    withServiceSecret({ handle }, serviceSecret),
  )) as SavedScrapedPostRecord[];

  const filtered = savedPosts
    .map(mapSavedScrapedPostToInstagramPost)
    .filter((post) => isPostWithinDaysBack(post.postedAt, daysBack))
    .sort((left, right) => comparePostedAtDescending(left.postedAt, right.postedAt));

  if (!resultsLimit || resultsLimit < 1) {
    return filtered;
  }

  return filtered.slice(0, resultsLimit);
}

async function loadSavedScrapedPostPageForHandle(options: {
  client: ConvexHttpClient;
  handle: string;
  cursor: string | null;
  pageSize: number;
  daysBack: number | undefined;
  alreadyAcceptedCount: number;
  resultsLimit: number | undefined;
  serviceSecret: string;
}): Promise<{
  candidateIds: string[];
  continueCursor: string;
  isDone: boolean;
  shouldCompleteHandle: boolean;
  acceptedCount: number;
}> {
  const page = (await options.client.query(
    listScrapedPostsByHandlePaginatedQuery,
    withServiceSecret(
      {
        handle: options.handle,
        paginationOpts: {
          cursor: options.cursor,
          numItems: options.pageSize,
        },
      },
      options.serviceSecret,
    ),
  )) as ScrapedPostsPage;
  const candidateIds: string[] = [];
  let acceptedCount = options.alreadyAcceptedCount;
  let hitDaysBackBoundary = false;

  for (const record of page.page) {
    if (!isPostWithinDaysBack(record.postedAt ?? null, options.daysBack)) {
      hitDaysBackBoundary = true;
      continue;
    }
    if (options.resultsLimit && options.resultsLimit > 0 && acceptedCount >= options.resultsLimit) {
      break;
    }
    candidateIds.push(record._id);
    acceptedCount += 1;
  }

  const reachedResultLimit =
    Boolean(options.resultsLimit && options.resultsLimit > 0) &&
    acceptedCount >= (options.resultsLimit ?? 0);

  return {
    candidateIds,
    continueCursor: page.continueCursor,
    isDone: page.isDone,
    shouldCompleteHandle: page.isDone || reachedResultLimit || hitDaysBackBoundary,
    acceptedCount,
  };
}

async function loadScrapedPostsByIds(
  client: ConvexHttpClient,
  ids: string[],
  serviceSecret: string,
): Promise<InstagramScrapedPost[]> {
  if (ids.length === 0) {
    return [];
  }
  const posts = (await client.query(
    getScrapedPostsManyByIdsQuery,
    withServiceSecret({ ids }, serviceSecret),
  )) as SavedScrapedPostRecord[];
  return posts
    .map(mapSavedScrapedPostToInstagramPost)
    .sort((left, right) => comparePostedAtDescending(left.postedAt, right.postedAt));
}

function normalizeBatchSize(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 2;
  }
  const rounded = Math.trunc(value as number);
  return Math.max(1, Math.min(MAX_INGESTION_BATCH_SIZE, rounded));
}

function normalizeString(value: string | null | undefined): string {
  return (value ?? "").trim();
}

type EventTimeEvidenceSource =
  | "caption"
  | "description"
  | "extracted_time"
  | "post_alt_text"
  | "source_caption";

type EventTimeEvidence = {
  source: EventTimeEvidenceSource;
  text: string;
  time: string;
};

function findEventTimeEvidence(
  candidates: Array<{ source: EventTimeEvidenceSource; text: string | null | undefined }>,
): EventTimeEvidence | null {
  const seenText = new Set<string>();
  for (const candidate of candidates) {
    const text = normalizeString(candidate.text).replace(/\s+/g, " ");
    const dedupeKey = text.toLocaleLowerCase();
    if (!text || seenText.has(dedupeKey)) {
      continue;
    }
    seenText.add(dedupeKey);

    const time = extractEventTimeFromText(text);
    if (time) {
      return {
        source: candidate.source,
        text,
        time,
      };
    }
  }

  return null;
}

function resolveEventTimeFromExtractionAndEvidence(options: {
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

function normalizeTicketPrice(price: string, currency: string): string {
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

function normalizeScrapedPost(post: InstagramScrapedPost): InstagramScrapedPost {
  const normalizedImageUrls = (post.imageUrls ?? [])
    .map((url) => normalizeString(url))
    .filter((url) => url.length > 0);

  return {
    postId: normalizeString(post.postId) || post.postId,
    caption: normalizeString(post.caption) || null,
    altText: normalizeString(post.altText) || null,
    imageUrl: normalizeString(post.imageUrl) || null,
    imageUrls: normalizedImageUrls,
    postType: normalizeString(post.postType).toLowerCase() || null,
    locationName: normalizeString(post.locationName) || null,
    instagramPostUrl: normalizeString(post.instagramPostUrl) || post.instagramPostUrl,
    postedAt: normalizeString(post.postedAt) || null,
    username: normalizeString(post.username) || post.username,
  };
}

function buildVenueHandleByCanonicalVenueName(
  canonicalVenueNamesByHandle: Record<string, string>,
): Map<string, string> {
  const handlesByVenueName = new Map<string, string>();

  for (const [handle, venueName] of Object.entries(canonicalVenueNamesByHandle)) {
    const key = toSearchableText(venueName);
    if (!key || handlesByVenueName.has(key)) {
      continue;
    }
    handlesByVenueName.set(key, handle);
  }

  return handlesByVenueName;
}

function buildSyntheticVenueHandle(venue: string, fallbackId: string): string {
  const normalizedVenue = toSearchableText(venue).replace(/\s+/g, "_");
  return normalizedVenue ? `event_import_${normalizedVenue}` : `event_import_${fallbackId}`;
}

function resolveImportedEventHandle(
  venue: string,
  fallbackId: string,
  canonicalVenueNamesByHandle: Record<string, string>,
  handlesByVenueName: Map<string, string>,
): string {
  const canonicalVenueName = canonicalizeVenueName(venue, canonicalVenueNamesByHandle, {
    staticVenueByHandle: STATIC_VENUE_BY_HANDLE,
  });
  if (canonicalVenueName) {
    const matchedHandle = handlesByVenueName.get(toSearchableText(canonicalVenueName));
    if (matchedHandle) {
      return matchedHandle;
    }
  }

  return buildSyntheticVenueHandle(venue, fallbackId);
}

function buildImportedEventFallbackText(event: EventImportRecord): string | null {
  const lines = [
    normalizeString(event.title),
    normalizeExtractedArtists(event.artists).join(", "),
    normalizeString(event.venue),
    [normalizeString(event.date), normalizeString(event.time)].filter(Boolean).join(" "),
    normalizeString(event.description),
  ].filter((value) => value.length > 0);

  if (lines.length > 0) {
    return lines.join("\n");
  }

  const minimalTitle = normalizeString(event.title) || `Event ${event._id}`;
  const minimalDate = normalizeString(event.date) || "Date TBA";
  const minimalVenue = normalizeString(event.venue) || "Venue TBA";
  return [minimalTitle, minimalVenue, minimalDate].join("\n");
}

function buildImportedEventInstagramPostUrl(event: EventImportRecord): string {
  const existingUrl = normalizeString(event.instagramPostUrl);
  if (existingUrl) {
    return existingUrl;
  }

  const postId = normalizeString(event.instagramPostId);
  if (postId) {
    return `https://www.instagram.com/p/${postId}/`;
  }

  return `https://www.instagram.com/p/event-${event._id}/`;
}

function mapImportedEventToSavedScrapedPost(
  event: EventImportRecord,
  handle: string,
): InstagramScrapedPost | null {
  const fallbackText = buildImportedEventFallbackText(event);
  const instagramPostUrl = buildImportedEventInstagramPostUrl(event);
  const imageUrl = normalizeString(event.imageUrl);
  const postId =
    normalizeString(event.instagramPostId) ||
    extractShortcodeFromPostUrl(instagramPostUrl) ||
    `event_${event._id}`;
  const caption = normalizeString(event.sourceCaption) || fallbackText;

  return normalizeScrapedPost({
    postId,
    caption: caption || null,
    altText: !imageUrl ? fallbackText : null,
    imageUrl: imageUrl || null,
    imageUrls: imageUrl ? [imageUrl] : [],
    postType: imageUrl ? "image" : "video",
    locationName: normalizeString(event.venue) || null,
    instagramPostUrl,
    postedAt: normalizeString(event.sourcePostedAt) || null,
    username: handle,
  });
}

function scoreSavedScrapedPostCandidate(post: InstagramScrapedPost): number {
  let score = 0;

  if (post.imageUrl) {
    score += 30;
  }
  if (post.caption) {
    score += 20 + Math.min(post.caption.length, 500) / 50;
  }
  if (post.postedAt) {
    score += 5;
  }

  return score;
}

function parseJsonRecord(value: string | undefined): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function readJsonBoolean(record: Record<string, unknown> | null, key: string): boolean | null {
  const value = record?.[key];
  return typeof value === "boolean" ? value : null;
}

function readJsonString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readJsonNumber(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function normalizeIsoDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return parsed.toISOString().slice(0, 10);
}

function parsePostedAt(postedAt: string | null): Date | null {
  if (!postedAt) {
    return null;
  }
  const parsed = Date.parse(postedAt);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return new Date(parsed);
}

function comparePostedAtDescending(left: string | null, right: string | null): number {
  return (
    (parsePostedAt(right)?.getTime() ?? Number.NEGATIVE_INFINITY) -
    (parsePostedAt(left)?.getTime() ?? Number.NEGATIVE_INFINITY)
  );
}

function isPostWithinDaysBack(postedAt: string | null, daysBack: number | undefined): boolean {
  if (!daysBack || daysBack <= 0) {
    return true;
  }
  const parsed = parsePostedAt(postedAt);
  if (!parsed) {
    return true;
  }
  const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  return parsed.getTime() >= cutoff;
}

function mapSavedScrapedPostToInstagramPost(
  record: SavedScrapedPostRecord,
): InstagramScrapedPost {
  return {
    postId: record.postId,
    caption: record.caption ?? null,
    altText: record.altText ?? null,
    imageUrl: record.imageUrl ?? null,
    imageUrls: record.imageUrls,
    postType: record.postType ?? null,
    locationName: record.locationName ?? null,
    instagramPostUrl: record.instagramPostUrl,
    postedAt: record.postedAt ?? null,
    username: record.username,
  };
}

function getConfiguredEventTimezone(): string {
  const configured = normalizeString(process.env.EVENTS_TIMEZONE);
  return configured || DEFAULT_EVENT_TIMEZONE;
}

function getIsoDateInTimeZone(timeZone: string, now = new Date(Date.now())): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    return now.toISOString().slice(0, 10);
  }
  return `${year}-${month}-${day}`;
}

function getEventDateFilterContext(now = new Date(Date.now())): {
  todayIsoDate: string;
  maxFutureIsoDate: string;
  maxDaysAhead: number;
  timeZone: string;
} {
  const maxFutureDate = new Date(
    now.getTime() + MAX_EVENT_DAYS_AHEAD * 24 * 60 * 60 * 1000,
  );
  const timeZone = getConfiguredEventTimezone();
  try {
    return {
      todayIsoDate: getIsoDateInTimeZone(timeZone, now),
      maxFutureIsoDate: getIsoDateInTimeZone(timeZone, maxFutureDate),
      maxDaysAhead: MAX_EVENT_DAYS_AHEAD,
      timeZone,
    };
  } catch {
    return {
      todayIsoDate: now.toISOString().slice(0, 10),
      maxFutureIsoDate: maxFutureDate.toISOString().slice(0, 10),
      maxDaysAhead: MAX_EVENT_DAYS_AHEAD,
      timeZone: "UTC",
    };
  }
}

function daysBetween(a: Date, b: Date): number {
  return Math.abs(Math.round((a.getTime() - b.getTime()) / (24 * 60 * 60 * 1000)));
}

function getSuspiciousYearDifference(
  parsedYear: number,
  postDate: Date | null,
): { isSuspicious: boolean; yearDistanceFromPost: number | null } {
  if (!postDate) {
    return { isSuspicious: false, yearDistanceFromPost: null };
  }
  const yearDistanceFromPost = Math.abs(parsedYear - postDate.getUTCFullYear());
  return { isSuspicious: yearDistanceFromPost >= 2, yearDistanceFromPost };
}

function normalizeYear(rawYear: string): number {
  if (rawYear.length === 2) {
    return 2000 + Number.parseInt(rawYear, 10);
  }
  return Number.parseInt(rawYear, 10);
}

function buildDateWithPossibleYearInference(
  day: number,
  month: number,
  rawYear: string | undefined,
  postDate: Date | null,
  isAmbiguousNumeric: boolean,
  source: DateSource,
  raw: string,
): DateCandidate | null {
  if (rawYear) {
    const year = normalizeYear(rawYear);
    const isoDate = normalizeIsoDate(year, month, day);
    if (!isoDate) {
      return null;
    }
    const parsed = new Date(`${isoDate}T00:00:00.000Z`);
    return {
      isoDate,
      source,
      confidence: isAmbiguousNumeric ? "medium" : "high",
      distanceFromPostDays: postDate ? daysBetween(parsed, postDate) : null,
      inferredYear: false,
      year,
      rawYearProvided: true,
      raw,
    };
  }

  if (!postDate) {
    return null;
  }

  const candidateYears = [postDate.getUTCFullYear() - 1, postDate.getUTCFullYear(), postDate.getUTCFullYear() + 1];
  let bestCandidate: DateCandidate | null = null;

  for (const year of candidateYears) {
    const isoDate = normalizeIsoDate(year, month, day);
    if (!isoDate) {
      continue;
    }
    const parsed = new Date(`${isoDate}T00:00:00.000Z`);
    const candidate: DateCandidate = {
      isoDate,
      source,
      confidence: isAmbiguousNumeric ? "low" : "medium",
      distanceFromPostDays: daysBetween(parsed, postDate),
      inferredYear: true,
      year,
      rawYearProvided: false,
      raw,
    };
    if (!bestCandidate) {
      bestCandidate = candidate;
      continue;
    }
    if (
      (candidate.distanceFromPostDays ?? Number.POSITIVE_INFINITY) <
      (bestCandidate.distanceFromPostDays ?? Number.POSITIVE_INFINITY)
    ) {
      bestCandidate = candidate;
    }
  }

  return bestCandidate;
}

function getMonthNumber(rawMonth: string): number | null {
  const normalizedMonth = normalizeString(rawMonth).toLowerCase();
  if (!normalizedMonth) {
    return null;
  }
  return (
    MONTH_ALIASES[normalizedMonth] ??
    MONTH_ALIASES[normalizedMonth.slice(0, 3)] ??
    null
  );
}

function foldRelativeDateText(value: string): string {
  return normalizeString(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const RELATIVE_WEEKDAY_ALIAS_PATTERN = RELATIVE_WEEKDAY_ALIASES
  .flatMap((entry) => entry.aliases)
  .map((alias) => foldRelativeDateText(alias))
  .sort((left, right) => right.length - left.length)
  .map(escapeRegExp)
  .join("|");

const RELATIVE_DAY_OFFSET_ALIAS_PATTERN = RELATIVE_DAY_OFFSET_ALIASES
  .flatMap((entry) => entry.aliases)
  .map((alias) => foldRelativeDateText(alias))
  .sort((left, right) => right.length - left.length)
  .map(escapeRegExp)
  .join("|");

const RELATIVE_TEXT_LEFT_BOUNDARY = String.raw`(?<![\p{L}\p{N}_])`;
const RELATIVE_TEXT_RIGHT_BOUNDARY = String.raw`(?![\p{L}\p{N}_])`;

function resolveRelativeWeekdayAlias(rawAlias: string): number | null {
  const foldedAlias = foldRelativeDateText(rawAlias);
  for (const entry of RELATIVE_WEEKDAY_ALIASES) {
    if (entry.aliases.some((alias) => foldRelativeDateText(alias) === foldedAlias)) {
      return entry.weekday;
    }
  }
  return null;
}

function resolveRelativeDayOffsetAlias(rawAlias: string): number | null {
  const foldedAlias = foldRelativeDateText(rawAlias);
  for (const entry of RELATIVE_DAY_OFFSET_ALIASES) {
    if (entry.aliases.some((alias) => foldRelativeDateText(alias) === foldedAlias)) {
      return entry.offsetDays;
    }
  }
  return null;
}

function dedupeRelativeWeekdayMatches(matches: RelativeWeekdayMatch[]): RelativeWeekdayMatch[] {
  const seen = new Set<string>();
  const deduped: RelativeWeekdayMatch[] = [];
  for (const match of matches) {
    const key = `${match.qualifier}:${match.weekday}:${match.raw}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(match);
  }
  return deduped;
}

function dedupeRelativeDayOffsetMatches(matches: RelativeDayOffsetMatch[]): RelativeDayOffsetMatch[] {
  const seen = new Set<string>();
  const deduped: RelativeDayOffsetMatch[] = [];
  for (const match of matches) {
    const key = `${match.offsetDays}:${match.raw}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(match);
  }
  return deduped;
}

function collectRelativeDayOffsetMatches(text: string): RelativeDayOffsetMatch[] {
  const foldedText = foldRelativeDateText(text);
  if (!foldedText) {
    return [];
  }

  const matches: RelativeDayOffsetMatch[] = [];
  const dayOffsetPattern = new RegExp(
    String.raw`${RELATIVE_TEXT_LEFT_BOUNDARY}(${RELATIVE_DAY_OFFSET_ALIAS_PATTERN})${RELATIVE_TEXT_RIGHT_BOUNDARY}`,
    "giu",
  );
  for (const match of foldedText.matchAll(dayOffsetPattern)) {
    const offsetDays = resolveRelativeDayOffsetAlias(match[1]);
    if (offsetDays !== null) {
      matches.push({ raw: match[0], offsetDays });
    }
  }

  return dedupeRelativeDayOffsetMatches(matches);
}

function collectWeekdayAliasesFromText(
  foldedText: string,
  qualifier: RelativeWeekdayQualifier,
): RelativeWeekdayMatch[] {
  const matches: RelativeWeekdayMatch[] = [];
  const weekdayPattern = new RegExp(
    String.raw`${RELATIVE_TEXT_LEFT_BOUNDARY}(${RELATIVE_WEEKDAY_ALIAS_PATTERN})${RELATIVE_TEXT_RIGHT_BOUNDARY}`,
    "giu",
  );
  for (const match of foldedText.matchAll(weekdayPattern)) {
    const weekday = resolveRelativeWeekdayAlias(match[1]);
    if (weekday === null) {
      continue;
    }
    matches.push({ raw: match[0], weekday, qualifier });
  }
  return matches;
}

function collectRelativeWeekdayMatches(text: string): RelativeWeekdayMatch[] {
  const foldedText = foldRelativeDateText(text);
  if (!foldedText) {
    return [];
  }

  const matches: RelativeWeekdayMatch[] = [];
  const thisWeekdayPattern = new RegExp(
    String.raw`${RELATIVE_TEXT_LEFT_BOUNDARY}(?:this|ovog|ovoga|ove|ovu|ovaj|овог|овога|ове|ову|овај)\s+(${RELATIVE_WEEKDAY_ALIAS_PATTERN})${RELATIVE_TEXT_RIGHT_BOUNDARY}`,
    "giu",
  );
  for (const match of foldedText.matchAll(thisWeekdayPattern)) {
    const weekday = resolveRelativeWeekdayAlias(match[1]);
    if (weekday !== null) {
      matches.push({ raw: match[0], weekday, qualifier: "this" });
    }
  }

  const nextWeekdayPattern = new RegExp(
    String.raw`${RELATIVE_TEXT_LEFT_BOUNDARY}(?:next|sledece|sljedece|naredne|narednog|narednu|iduce|следеће|следеце|сљедеће|сљедеце|наредне|наредног|наредну|идуће|идуце)\s+(${RELATIVE_WEEKDAY_ALIAS_PATTERN})${RELATIVE_TEXT_RIGHT_BOUNDARY}`,
    "giu",
  );
  for (const match of foldedText.matchAll(nextWeekdayPattern)) {
    const weekday = resolveRelativeWeekdayAlias(match[1]);
    if (weekday !== null) {
      matches.push({ raw: match[0], weekday, qualifier: "next" });
    }
  }

  const onWeekdayPattern = new RegExp(
    String.raw`${RELATIVE_TEXT_LEFT_BOUNDARY}(?:on|u|у)\s+(${RELATIVE_WEEKDAY_ALIAS_PATTERN})${RELATIVE_TEXT_RIGHT_BOUNDARY}`,
    "giu",
  );
  for (const match of foldedText.matchAll(onWeekdayPattern)) {
    const weekday = resolveRelativeWeekdayAlias(match[1]);
    if (weekday !== null) {
      matches.push({ raw: match[0], weekday, qualifier: "this" });
    }
  }

  const currentWeekContextPattern = new RegExp(
    String.raw`${RELATIVE_TEXT_LEFT_BOUNDARY}(?:this\s+week|ove\s+(?:nedelje|nedjelje|sedmice)|ове\s+(?:недеље|недјеље|седмице))${RELATIVE_TEXT_RIGHT_BOUNDARY}`,
    "giu",
  );
  const textWithoutWeekContext = foldedText.replace(currentWeekContextPattern, " ");
  if (textWithoutWeekContext !== foldedText) {
    matches.push(...collectWeekdayAliasesFromText(textWithoutWeekContext, "this"));
  }

  const bareWeekdayMatches = collectWeekdayAliasesFromText(textWithoutWeekContext, "bare_list");
  if (bareWeekdayMatches.length >= 2) {
    const firstIndex = foldedText.indexOf(bareWeekdayMatches[0].raw);
    const lastIndex = foldedText.lastIndexOf(bareWeekdayMatches[bareWeekdayMatches.length - 1].raw);
    const betweenWeekdays = firstIndex >= 0 && lastIndex > firstIndex
      ? foldedText.slice(firstIndex, lastIndex)
      : "";
    const hasListSeparator = /(?:\/|,|&|\+|(?<![\p{L}\p{N}_])i(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])и(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])and(?![\p{L}\p{N}_])|\s[-–—]\s)/u.test(betweenWeekdays);
    if (hasListSeparator) {
      matches.push(...bareWeekdayMatches);
    }
  }

  const leadingBareWeekdayPattern = new RegExp(
    String.raw`^\s*(${RELATIVE_WEEKDAY_ALIAS_PATTERN})${RELATIVE_TEXT_RIGHT_BOUNDARY}\s*(?:[:|•·,;-]|$)`,
    "iu",
  );
  const leadingBareMatch = foldedText.match(leadingBareWeekdayPattern);
  if (leadingBareMatch?.[1]) {
    const weekday = resolveRelativeWeekdayAlias(leadingBareMatch[1]);
    if (weekday !== null) {
      matches.push({ raw: leadingBareMatch[0].trim(), weekday, qualifier: "bare_list" });
    }
  }

  return dedupeRelativeWeekdayMatches(matches);
}

function parseIsoDateParts(value: string): { year: number; month: number; day: number } | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  return { year, month, day };
}

function getUtcMiddayForIsoDate(isoDate: string): Date | null {
  const parts = parseIsoDateParts(isoDate);
  if (!parts) {
    return null;
  }
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0, 0));
}

function addDaysToIsoDate(isoDate: string, days: number): string | null {
  const date = getUtcMiddayForIsoDate(isoDate);
  if (!date) {
    return null;
  }
  date.setUTCDate(date.getUTCDate() + days);
  return toIsoDateUtc(date);
}

function getPostIsoDateForRelativeParsing(postDate: Date): string {
  const timeZone = getConfiguredEventTimezone();
  try {
    return getIsoDateInTimeZone(timeZone, postDate);
  } catch {
    return toIsoDateUtc(postDate);
  }
}

function buildRelativeDayOffsetCandidate(
  match: RelativeDayOffsetMatch,
  postDate: Date | null,
  source: DateSource,
): DateCandidate | null {
  if (!postDate) {
    return null;
  }

  const postIsoDate = getPostIsoDateForRelativeParsing(postDate);
  const isoDate = addDaysToIsoDate(postIsoDate, match.offsetDays);
  const parsed = isoDate ? getUtcMiddayForIsoDate(isoDate) : null;
  if (!isoDate || !parsed) {
    return null;
  }

  return {
    isoDate,
    source,
    confidence: "high",
    distanceFromPostDays: match.offsetDays,
    inferredYear: true,
    year: parsed.getUTCFullYear(),
    rawYearProvided: false,
    raw: match.raw,
    relativeDayOffset: true,
  };
}

function buildRelativeWeekdayCandidate(
  match: RelativeWeekdayMatch,
  postDate: Date | null,
  source: DateSource,
): DateCandidate | null {
  if (!postDate) {
    return null;
  }

  const postIsoDate = getPostIsoDateForRelativeParsing(postDate);
  const postLocalDate = getUtcMiddayForIsoDate(postIsoDate);
  if (!postLocalDate) {
    return null;
  }

  let offsetDays = (match.weekday - postLocalDate.getUTCDay() + 7) % 7;
  if (match.qualifier === "next" && offsetDays === 0) {
    offsetDays = 7;
  }
  const isoDate = addDaysToIsoDate(postIsoDate, offsetDays);
  const parsed = isoDate ? getUtcMiddayForIsoDate(isoDate) : null;
  if (!isoDate || !parsed) {
    return null;
  }

  return {
    isoDate,
    source,
    confidence: match.qualifier === "bare_list" ? "medium" : "high",
    distanceFromPostDays: offsetDays,
    inferredYear: true,
    year: parsed.getUTCFullYear(),
    rawYearProvided: false,
    raw: match.raw,
    relativeWeekday: true,
  };
}

function hasExplicitDateText(text: string): boolean {
  const normalizedText = normalizeString(text);
  if (!normalizedText) {
    return false;
  }
  if (/\b20\d{2}[./-]\d{1,2}[./-]\d{1,2}\b/u.test(normalizedText)) {
    return true;
  }
  if (/\b\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\b/u.test(normalizedText)) {
    return true;
  }
  const dayMonthPattern = new RegExp(
    String.raw`\b\d{1,2}(?:st|nd|rd|th|\.)?\s+${DATE_MONTH_WORD_PATTERN}\b`,
    "iu",
  );
  const monthDayPattern = new RegExp(
    String.raw`\b${DATE_MONTH_WORD_PATTERN}\s+\d{1,2}(?:st|nd|rd|th)?\b`,
    "iu",
  );
  return dayMonthPattern.test(normalizedText) || monthDayPattern.test(normalizedText);
}

function collectRelativeDates(
  text: string,
  postDate: Date | null,
  source: DateSource,
): string[] {
  const candidates = [
    ...collectRelativeDayOffsetMatches(text).map((match) =>
      buildRelativeDayOffsetCandidate(match, postDate, source),
    ),
    ...collectRelativeWeekdayMatches(text).map((match) =>
      buildRelativeWeekdayCandidate(match, postDate, source),
    ),
  ];
  const dates = candidates
    .map((candidate) => candidate?.isoDate ?? null)
    .filter((value): value is string => Boolean(value));
  return [...new Set(dates)].sort();
}

function collectDateCandidates(
  text: string,
  source: DateSource,
  postDate: Date | null,
): DateCandidate[] {
  const candidates: DateCandidate[] = [];
  const normalizedText = normalizeString(text);
  if (!normalizedText) {
    return candidates;
  }

  const appendCandidate = (candidate: DateCandidate | null) => {
    if (!candidate) {
      return;
    }
    candidates.push(candidate);
  };

  for (const match of normalizedText.matchAll(/\b(20\d{2})[./-](\d{1,2})[./-](\d{1,2})\b/g)) {
    appendCandidate(
      buildDateWithPossibleYearInference(
        Number.parseInt(match[3], 10),
        Number.parseInt(match[2], 10),
        match[1],
        postDate,
        false,
        source,
        match[0],
      ),
    );
  }

  for (const match of normalizedText.matchAll(/\b(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?\b/g)) {
    const first = Number.parseInt(match[1], 10);
    const second = Number.parseInt(match[2], 10);
    const rawYear = match[3];
    const dayMonthCandidate = buildDateWithPossibleYearInference(
      first,
      second,
      rawYear,
      postDate,
      first <= 12 && second <= 12,
      source,
      match[0],
    );
    if (!rawYear && dayMonthCandidate && first <= 12 && second <= 12) {
      // Serbian/European event captions use D.M. order. Keep a bare caption
      // like "11.7." strong enough to beat a model-generated off-by-one
      // normalized date, while still retaining the US-style M.D. alternative
      // below as low-confidence fallback only.
      dayMonthCandidate.confidence = "medium";
    }
    appendCandidate(dayMonthCandidate);

    if (first <= 12 && second <= 12) {
      const monthDayCandidate = buildDateWithPossibleYearInference(
        second,
        first,
        rawYear,
        postDate,
        true,
        source,
        match[0],
      );
      if (monthDayCandidate) {
        monthDayCandidate.confidence = "low";
      }
      appendCandidate(monthDayCandidate);
    }
  }

  for (const match of normalizedText.matchAll(
    new RegExp(
      String.raw`\b(\d{1,2})(?:st|nd|rd|th|\.)?\s+(${DATE_MONTH_WORD_PATTERN})(?:\s*,?\s*(\d{4}))?\b`,
      "giu",
    ),
  )) {
    const month = getMonthNumber(match[2]);
    if (!month) {
      continue;
    }
    appendCandidate(
      buildDateWithPossibleYearInference(
        Number.parseInt(match[1], 10),
        month,
        match[3],
        postDate,
        false,
        source,
        match[0],
      ),
    );
  }

  for (const match of normalizedText.matchAll(
    new RegExp(
      String.raw`\b(${DATE_MONTH_WORD_PATTERN})\s+(\d{1,2})(?!\s*[-–—]\s*\d{1,2}\s*h\b)(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?\b`,
      "giu",
    ),
  )) {
    const month = getMonthNumber(match[1]);
    if (!month) {
      continue;
    }
    appendCandidate(
      buildDateWithPossibleYearInference(
        Number.parseInt(match[2], 10),
        month,
        match[3],
        postDate,
        false,
        source,
        match[0],
      ),
    );
  }

  for (const match of collectRelativeDayOffsetMatches(normalizedText)) {
    appendCandidate(buildRelativeDayOffsetCandidate(match, postDate, source));
  }

  for (const match of collectRelativeWeekdayMatches(normalizedText)) {
    appendCandidate(buildRelativeWeekdayCandidate(match, postDate, source));
  }

  return candidates;
}

export function normalizeEventDate(
  rawModelDate: string,
  caption: string | null,
  postedAt: string | null,
): DateNormalization {
  const postDate = parsePostedAt(postedAt);
  const candidates = [
    ...collectDateCandidates(rawModelDate, "model", postDate),
    ...collectDateCandidates(caption ?? "", "caption", postDate),
  ];

  if (candidates.length === 0) {
    return {
      isoDate: null,
      source: null,
      confidence: null,
      distanceFromPostDays: null,
      inferredYear: false,
      rawDateText: null,
      yearSelectionReason: "no_date_candidate",
      suspiciousYear: false,
      reason: "missing_date",
    };
  }

  candidates.sort((a, b) => {
    const relativeWeightA = a.relativeWeekday || a.relativeDayOffset ? 1 : 0;
    const relativeWeightB = b.relativeWeekday || b.relativeDayOffset ? 1 : 0;
    if (relativeWeightA !== relativeWeightB) {
      return relativeWeightA - relativeWeightB;
    }

    const confidenceOrder: Record<DateConfidence, number> = {
      high: 0,
      medium: 1,
      low: 2,
    };
    const confidenceWeight = confidenceOrder[a.confidence] - confidenceOrder[b.confidence];
    if (confidenceWeight !== 0) {
      return confidenceWeight;
    }

    const distanceA = a.distanceFromPostDays ?? Number.POSITIVE_INFINITY;
    const distanceB = b.distanceFromPostDays ?? Number.POSITIVE_INFINITY;
    if (distanceA !== distanceB) {
      return distanceA - distanceB;
    }

    const sourceWeightA = a.source === "model" ? 0 : 1;
    const sourceWeightB = b.source === "model" ? 0 : 1;
    return sourceWeightA - sourceWeightB;
  });

  const selected = candidates[0];
  const yearSanity = getSuspiciousYearDifference(selected.year, postDate);
  const yearDistanceFromPost = yearSanity.yearDistanceFromPost;
  const suspiciousYear = yearSanity.isSuspicious;

  const yearSelectionReason = selected.rawYearProvided
    ? "explicit_year_from_text"
    : selected.relativeWeekday
      ? "relative_weekday_from_post_timestamp"
      : selected.relativeDayOffset
        ? "relative_day_from_post_timestamp"
        : "year_inferred_from_post_timestamp_nearest";

  if (selected.confidence === "low") {
    return {
      isoDate: null,
      source: selected.source,
      confidence: selected.confidence,
      distanceFromPostDays: selected.distanceFromPostDays,
      inferredYear: selected.inferredYear,
      rawDateText: selected.raw,
      yearSelectionReason,
      suspiciousYear,
      reason: "low_confidence",
    };
  }

  const allowLongDistanceForVeryHighConfidence =
    selected.confidence === "high" &&
    selected.rawYearProvided &&
    yearDistanceFromPost !== null &&
    yearDistanceFromPost <= 1;

  if (
    postDate &&
    selected.distanceFromPostDays !== null &&
    selected.distanceFromPostDays > MAX_DATE_DISTANCE_DAYS &&
    !allowLongDistanceForVeryHighConfidence
  ) {
    return {
      isoDate: null,
      source: selected.source,
      confidence: selected.confidence,
      distanceFromPostDays: selected.distanceFromPostDays,
      inferredYear: selected.inferredYear,
      rawDateText: selected.raw,
      yearSelectionReason,
      suspiciousYear,
      reason: "implausible_date",
    };
  }

  if (suspiciousYear) {
    return {
      isoDate: null,
      source: selected.source,
      confidence: selected.confidence,
      distanceFromPostDays: selected.distanceFromPostDays,
      inferredYear: selected.inferredYear,
      rawDateText: selected.raw,
      yearSelectionReason,
      suspiciousYear: true,
      reason: "low_confidence",
    };
  }

  return {
    isoDate: selected.isoDate,
    source: selected.source,
    confidence: selected.confidence,
    distanceFromPostDays: selected.distanceFromPostDays,
    inferredYear: selected.inferredYear,
    rawDateText: selected.raw,
    yearSelectionReason,
    suspiciousYear,
  };
}

function parseIsoDateUtc(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function toIsoDateUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function expandDateRangeFromCandidates(
  startCandidate: DateCandidate | null,
  endCandidate: DateCandidate | null,
): string[] | null {
  if (!startCandidate || !endCandidate) {
    return null;
  }

  const start = parseIsoDateUtc(startCandidate.isoDate);
  const end = parseIsoDateUtc(endCandidate.isoDate);
  if (!start || !end) {
    return null;
  }

  const distanceDays = Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
  if (distanceDays < 1 || distanceDays > 14) {
    return null;
  }

  const dates: string[] = [];
  for (let offset = 0; offset <= distanceDays; offset += 1) {
    dates.push(toIsoDateUtc(new Date(start.getTime() + offset * 24 * 60 * 60 * 1000)));
  }

  return dates;
}

function buildDateRangeFromParts(options: {
  startDay: number;
  startMonth: number;
  endDay: number;
  endMonth: number;
  rawYear: string | undefined;
  postDate: Date | null;
  source: DateSource;
  raw: string;
}): string[] | null {
  const startCandidate = buildDateWithPossibleYearInference(
    options.startDay,
    options.startMonth,
    options.rawYear,
    options.postDate,
    false,
    options.source,
    options.raw,
  );
  const endCandidate = buildDateWithPossibleYearInference(
    options.endDay,
    options.endMonth,
    options.rawYear,
    options.postDate,
    false,
    options.source,
    options.raw,
  );

  return expandDateRangeFromCandidates(startCandidate, endCandidate);
}

function collectExplicitDateRangeDates(
  text: string,
  postDate: Date | null,
  source: DateSource,
): string[] | null {
  const normalizedText = normalizeString(text);
  if (!normalizedText) {
    return null;
  }

  const sharedMonthRangePattern = new RegExp(
    String.raw`(?:^|[^\p{L}\p{N}_])(?:od\s+)?(\d{1,2})\.?\s*(?:do|to|through|thru|[-–—])\s*(\d{1,2})\.?\s+(${DATE_MONTH_WORD_PATTERN})(?:\s*,?\s*(\d{2,4}))?`,
    "giu",
  );
  for (const match of normalizedText.matchAll(sharedMonthRangePattern)) {
    const month = getMonthNumber(match[3]);
    if (!month) {
      continue;
    }
    const dates = buildDateRangeFromParts({
      startDay: Number.parseInt(match[1], 10),
      startMonth: month,
      endDay: Number.parseInt(match[2], 10),
      endMonth: month,
      rawYear: match[4],
      postDate,
      source,
      raw: match[0].trim(),
    });
    if (dates) {
      return dates;
    }
  }

  const sharedNumericMonthRangePattern =
    /(?:^|[^\p{L}\p{N}_])(?:od\s+)?(\d{1,2})\.?\s*(?:do|to|through|thru|[-–—])\s*(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\.?/giu;
  for (const match of normalizedText.matchAll(sharedNumericMonthRangePattern)) {
    const dates = buildDateRangeFromParts({
      startDay: Number.parseInt(match[1], 10),
      startMonth: Number.parseInt(match[3], 10),
      endDay: Number.parseInt(match[2], 10),
      endMonth: Number.parseInt(match[3], 10),
      rawYear: match[4],
      postDate,
      source,
      raw: match[0].trim(),
    });
    if (dates) {
      return dates;
    }
  }

  const numericRangePattern =
    /(?:^|[^\p{L}\p{N}_])(?:od\s+)?(\d{1,2})[./](\d{1,2})\.?\s*(?:do|to|through|thru|[-–—])\s*(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\.?/giu;
  for (const match of normalizedText.matchAll(numericRangePattern)) {
    const dates = buildDateRangeFromParts({
      startDay: Number.parseInt(match[1], 10),
      startMonth: Number.parseInt(match[2], 10),
      endDay: Number.parseInt(match[3], 10),
      endMonth: Number.parseInt(match[4], 10),
      rawYear: match[5],
      postDate,
      source,
      raw: match[0].trim(),
    });
    if (dates) {
      return dates;
    }
  }

  return null;
}

function expandNormalizedDateRange(
  rawModelDate: string,
  postedAt: string | null,
  caption: string | null = null,
): string[] | null {
  const normalizedRawDate = normalizeString(rawModelDate);
  const normalizedCaption = normalizeString(caption);
  const postDate = parsePostedAt(postedAt);
  const explicitModelRangeDates = collectExplicitDateRangeDates(
    normalizedRawDate,
    postDate,
    "model",
  );
  if (explicitModelRangeDates) {
    return explicitModelRangeDates;
  }

  const explicitCaptionRangeDates = collectExplicitDateRangeDates(
    normalizedCaption,
    postDate,
    "caption",
  );
  if (explicitCaptionRangeDates) {
    return explicitCaptionRangeDates;
  }

  if (normalizedRawDate && !hasExplicitDateText(normalizedRawDate)) {
    const relativeModelDates = collectRelativeDates(
      normalizedRawDate,
      postDate,
      "model",
    );
    if (relativeModelDates.length >= 2) {
      return relativeModelDates;
    }
  }

  if (normalizedCaption && !hasExplicitDateText(normalizedCaption)) {
    const relativeCaptionDates = collectRelativeDates(
      normalizedCaption,
      postDate,
      "caption",
    );
    if (relativeCaptionDates.length >= 2) {
      return relativeCaptionDates;
    }
  }

  if (!normalizedRawDate) {
    return null;
  }

  const hasRangeHint =
    /\b(to|through|thru|do)\b/i.test(normalizedRawDate) ||
    /[–—]/.test(normalizedRawDate) ||
    /\s-\s/.test(normalizedRawDate);
  if (!hasRangeHint) {
    return null;
  }

  const candidates = collectDateCandidates(normalizedRawDate, "model", postDate);
  const uniqueDates = [...new Set(candidates.map((candidate) => candidate.isoDate))].sort();
  if (uniqueDates.length < 2) {
    return null;
  }

  const start = parseIsoDateUtc(uniqueDates[0]);
  const end = parseIsoDateUtc(uniqueDates[uniqueDates.length - 1]);
  if (!start || !end) {
    return null;
  }

  const distanceDays = Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
  if (distanceDays < 1 || distanceDays > 14) {
    return null;
  }

  const dates: string[] = [];
  for (let offset = 0; offset <= distanceDays; offset += 1) {
    dates.push(toIsoDateUtc(new Date(start.getTime() + offset * 24 * 60 * 60 * 1000)));
  }

  return dates;
}

function normalizeVenue(
  post: InstagramScrapedPost,
  rawModelVenue: string,
  canonicalVenueNamesByHandle: Record<string, string>,
  venueNameOverridesByHandle: Record<string, string>,
): VenueNormalization {
  return normalizeVenueFromEvidence({
    handle: post.username,
    rawModelVenue,
    locationName: post.locationName,
    canonicalVenueNamesByHandle,
    handleVenueNamesByHandle: venueNameOverridesByHandle,
    staticVenueByHandle: STATIC_VENUE_BY_HANDLE,
  });
}

function extractShortcodeFromPostUrl(url: string): string | null {
  const match = url.match(/instagram\.com\/(?:p|reel|reels|tv)\/([^/?#]+)/i);
  return match?.[1]?.trim() || null;
}

function getSourceIdentityKey(post: InstagramScrapedPost): string | null {
  const postId = normalizeString(post.postId);
  if (postId) {
    return `post_id:${postId}`;
  }
  const shortcode = extractShortcodeFromPostUrl(post.instagramPostUrl);
  if (shortcode) {
    return `shortcode:${shortcode}`;
  }
  const postUrl = normalizeString(post.instagramPostUrl);
  if (postUrl) {
    return `post_url:${postUrl}`;
  }
  return null;
}

function parseEventYear(date: string | undefined): number | null {
  if (!date) {
    return null;
  }
  const match = date.match(/^(\d{4})-\d{2}-\d{2}$/);
  if (!match) {
    return null;
  }
  return Number.parseInt(match[1], 10);
}

function mapDuplicateReasonToLogEvent(reason: DuplicateQualityReason): DuplicateUpdateLogEvent {
  if (reason === "wrong_year") return "duplicate_updated_wrong_year";
  if (reason === "bad_venue") return "duplicate_updated_bad_venue";
  if (reason === "low_confidence") return "duplicate_updated_low_confidence";
  return "duplicate_updated_bad_data";
}

function isLowQualityExistingEvent(
  existing: ExistingEventRecord,
  postTimestamp: string | null,
): ExistingEventQuality {
  const reasons = new Set<DuplicateQualityReason>();
  const normalizedFields = parseJsonRecord(existing.normalizedFieldsJson);
  const postDate = parsePostedAt(postTimestamp ?? existing.sourcePostedAt ?? null);
  const eventYear = parseEventYear(existing.date);
  const explicitYearHighConfidence =
    readJsonString(normalizedFields, "dateYearSelectionReason") === "explicit_year_from_text" &&
    readJsonString(normalizedFields, "dateConfidence") === "high";
  const confidence = normalizeConfidenceScore(readJsonNumber(normalizedFields, "confidence"));

  if (!normalizeString(existing.title) || !normalizeString(existing.date) || !normalizeString(existing.venue) || !normalizeString(existing.eventType)) {
    reasons.add("invalid_required_fields");
  }

  if (readJsonBoolean(normalizedFields, "dateSuspiciousYear")) {
    reasons.add("wrong_year");
  }

  if (postDate && eventYear !== null) {
    const postYear = postDate.getUTCFullYear();
    if (Math.abs(eventYear - postYear) >= 2) {
      reasons.add("wrong_year");
    }
    if (eventYear < postYear && !explicitYearHighConfidence) {
      reasons.add("wrong_year");
    }
  }

  if (
    readJsonString(normalizedFields, "dateReason") !== null ||
    readJsonString(normalizedFields, "normalizedDate") === null ||
    readJsonBoolean(normalizedFields, "normalizedIsValid") === false
  ) {
    reasons.add("invalid_normalized_fields");
  }

  if (isLowConfidenceVenue(existing.venue)) {
    reasons.add("bad_venue");
  }

  const normalizedVenue = existing.venue.toLowerCase().replace(/\s+/g, " ").trim();
  if (normalizedVenue === "unknown venue" || normalizedVenue === "20_44 nightclub") {
    reasons.add("bad_venue");
  }

  if (confidence !== null && confidence < EXISTING_EVENT_CONFIDENCE_THRESHOLD) {
    reasons.add("low_confidence");
  }

  const orderedReasons: DuplicateQualityReason[] = [];
  if (reasons.has("wrong_year")) orderedReasons.push("wrong_year");
  if (reasons.has("bad_venue")) orderedReasons.push("bad_venue");
  if (reasons.has("low_confidence")) orderedReasons.push("low_confidence");
  if (reasons.has("invalid_required_fields")) orderedReasons.push("invalid_required_fields");
  if (reasons.has("invalid_normalized_fields")) orderedReasons.push("invalid_normalized_fields");

  return {
    isLowQuality: orderedReasons.length > 0,
    primaryReason: orderedReasons[0] ?? null,
    reasons: orderedReasons,
    details: {
      postTimestamp: postTimestamp ?? existing.sourcePostedAt ?? null,
      existingDate: existing.date,
      existingVenue: existing.venue,
      existingStatus: existing.status,
      confidence,
      explicitYearHighConfidence,
      normalizedDateReason: readJsonString(normalizedFields, "dateReason"),
      normalizedDate: readJsonString(normalizedFields, "normalizedDate"),
      normalizedInvalidReason: readJsonString(normalizedFields, "normalizedInvalidReason"),
    },
  };
}

function shouldReprocessExistingSourcePosts(): boolean {
  return normalizeString(process.env.INGESTION_REPROCESS_EXISTING_SOURCE_POSTS).toLowerCase() === "true";
}

type SourceDuplicateSkipDecision = {
  match: ExistingSourceMatch;
  quality: ExistingEventQuality;
  reason: "already_processed_source" | "clean_existing_source";
};

function getPreExtractionSourceDuplicateSkipDecision(
  matches: ExistingSourceMatch[],
  post: InstagramScrapedPost,
): SourceDuplicateSkipDecision | null {
  const firstMatch = matches[0];
  if (!firstMatch) {
    return null;
  }

  if (!shouldReprocessExistingSourcePosts()) {
    return {
      match: firstMatch,
      quality: isLowQualityExistingEvent(firstMatch.existingEvent, post.postedAt),
      reason: "already_processed_source",
    };
  }

  for (const match of matches) {
    const quality = isLowQualityExistingEvent(match.existingEvent, post.postedAt);
    if (!quality.isLowQuality) {
      return {
        match,
        quality,
        reason: "clean_existing_source",
      };
    }
  }

  return null;
}

function recordSourceDuplicateSkip(
  summary: HandleSummary,
  decision: SourceDuplicateSkipDecision,
): void {
  summary.skippedDuplicates += 1;
  summary.skipped_duplicates += 1;
  if (!decision.quality.isLowQuality) {
    summary.skipped_duplicates_clean += 1;
  }
}

function normalizeArtistsForComparison(artists: string[]): string[] {
  return artists.map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0).sort();
}

function normalizeCompactComparisonText(value: string | null | undefined): string {
  return toSearchableText(normalizeString(value)).replace(/\s+/g, "");
}

function getTextTokenSimilarity(left: string | null | undefined, right: string | null | undefined): number {
  const normalizedLeft = toSearchableText(normalizeString(left));
  const normalizedRight = toSearchableText(normalizeString(right));
  if (!normalizedLeft || !normalizedRight) {
    return 0;
  }

  const leftTokens = [...new Set(normalizedLeft.split(" ").filter((token) => token.length > 1))];
  const rightTokens = [...new Set(normalizedRight.split(" ").filter((token) => token.length > 1))];
  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return 0;
  }

  const rightTokenSet = new Set(rightTokens);
  let sharedTokens = 0;
  for (const token of leftTokens) {
    if (rightTokenSet.has(token)) {
      sharedTokens += 1;
    }
  }

  return sharedTokens / Math.min(leftTokens.length, rightTokens.length);
}

function areComparableVenueTexts(left: string | null | undefined, right: string | null | undefined): boolean {
  const normalizedLeft = toSearchableText(normalizeString(left));
  const normalizedRight = toSearchableText(normalizeString(right));
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  if (normalizedLeft === normalizedRight) {
    return true;
  }
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) {
    return true;
  }
  return (
    getTextTokenSimilarity(normalizedLeft, normalizedRight) >=
    DUPLICATE_VENUE_TOKEN_SIMILARITY_THRESHOLD
  );
}

function areComparableEventTexts(left: string | null | undefined, right: string | null | undefined): boolean {
  const normalizedLeft = toSearchableText(normalizeString(left));
  const normalizedRight = toSearchableText(normalizeString(right));
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  if (normalizedLeft === normalizedRight) {
    return true;
  }

  const compactLeft = normalizeCompactComparisonText(left);
  const compactRight = normalizeCompactComparisonText(right);
  const shorterCompactLength = Math.min(compactLeft.length, compactRight.length);
  if (
    shorterCompactLength >= 6 &&
    (compactLeft.includes(compactRight) || compactRight.includes(compactLeft))
  ) {
    return true;
  }

  return (
    getTextTokenSimilarity(normalizedLeft, normalizedRight) >=
    DUPLICATE_TEXT_TOKEN_SIMILARITY_THRESHOLD
  );
}

function hasComparableTextOverlap(leftValues: string[], rightValues: string[]): boolean {
  for (const left of leftValues) {
    for (const right of rightValues) {
      if (areComparableEventTexts(left, right)) {
        return true;
      }
    }
  }
  return false;
}

function extractComparableTimeParts(value: string | undefined): string[] {
  const matches = normalizeString(value).match(/\d{1,2}(?::\d{2})?/g) ?? [];
  return matches.map((match) => {
    const [hours, minutes = "00"] = match.split(":");
    return `${hours.padStart(2, "0")}:${minutes.padStart(2, "0")}`;
  });
}

function areTimesCompatible(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeString(left);
  const normalizedRight = normalizeString(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  if (normalizedLeft === normalizedRight) {
    return true;
  }

  const leftParts = extractComparableTimeParts(left);
  const rightParts = extractComparableTimeParts(right);
  if (leftParts.length === 0 || rightParts.length === 0) {
    return false;
  }

  return JSON.stringify(leftParts) === JSON.stringify(rightParts);
}

function getComparableVenueCandidates(
  event: Pick<ExistingEventRecord | PreparedEvent, "venue">,
  normalizedFields: Record<string, unknown> | null,
): string[] {
  return collectComparableTextValues([
    event.venue,
    readJsonString(normalizedFields, "normalizedVenue"),
    readJsonString(normalizedFields, "locationName"),
    readJsonString(normalizedFields, "rawVenue"),
  ]);
}

function getComparableTitleCandidates(
  event: Pick<ExistingEventRecord | PreparedEvent, "title">,
  normalizedFields: Record<string, unknown> | null,
): string[] {
  return collectComparableTextValues([
    event.title,
    readJsonString(normalizedFields, "rawTitle"),
    readJsonString(normalizedFields, "titleContextCandidate"),
  ]);
}

function getComparableArtistCandidates(
  event: Pick<ExistingEventRecord | PreparedEvent, "artists">,
): string[] {
  return collectComparableIdentityValues(event.artists);
}

function getComparableEvidenceCandidates(
  event: Pick<
    ExistingEventRecord | PreparedEvent,
    "title" | "description" | "sourceCaption"
  >,
  normalizedFields: Record<string, unknown> | null,
): string[] {
  return collectComparableTextValues([
    event.title,
    event.description,
    event.sourceCaption,
    readJsonString(normalizedFields, "rawTitle"),
    readJsonString(normalizedFields, "titleContextCandidate"),
    readJsonString(normalizedFields, "description"),
    readJsonString(normalizedFields, "sourceCaptionFromModel"),
    readJsonString(normalizedFields, "postAltText"),
    readJsonString(normalizedFields, "splitSourceLine"),
    readJsonString(normalizedFields, "reasoningNotes"),
  ]);
}

function getComparableContextCandidates(
  event: Pick<
    ExistingEventRecord | PreparedEvent,
    "title" | "description" | "sourceCaption" | "venue" | "artists"
  >,
  normalizedFields: Record<string, unknown> | null,
): string[] {
  return collectComparableTextValues([
    event.title,
    event.venue,
    event.description,
    event.sourceCaption,
    ...event.artists,
    readJsonString(normalizedFields, "rawTitle"),
    readJsonString(normalizedFields, "titleContextCandidate"),
    readJsonString(normalizedFields, "normalizedVenue"),
    readJsonString(normalizedFields, "locationName"),
    readJsonString(normalizedFields, "rawVenue"),
    readJsonString(normalizedFields, "description"),
    readJsonString(normalizedFields, "sourceCaptionFromModel"),
    readJsonString(normalizedFields, "postAltText"),
    readJsonString(normalizedFields, "splitSourceLine"),
    readJsonString(normalizedFields, "reasoningNotes"),
  ]);
}

function getComparableTitleFamilyCandidates(
  event: Pick<ExistingEventRecord | PreparedEvent, "title">,
  normalizedFields: Record<string, unknown> | null,
): string[] {
  return [
    ...new Set(
      [
        event.title,
        readJsonString(normalizedFields, "rawTitle"),
        readJsonString(normalizedFields, "titleContextCandidate"),
      ]
        .map((value) => buildTitleFamilySlug(normalizeString(value)))
        .filter(Boolean),
    ),
  ];
}

function getComparableIdentityCandidates(
  event: Pick<ExistingEventRecord | PreparedEvent, "title" | "artists" | "venue">,
  normalizedFields: Record<string, unknown> | null,
): string[] {
  return collectComparableIdentityValues(
    [
      event.title,
      ...event.artists,
      readJsonString(normalizedFields, "rawTitle"),
      readJsonString(normalizedFields, "titleContextCandidate"),
    ],
    {
      ignoredValues: getComparableVenueCandidates(event, normalizedFields),
    },
  );
}

function getComparableMentionHandles(
  event: Pick<ExistingEventRecord | PreparedEvent, "description" | "sourceCaption" | "artists">,
  normalizedFields: Record<string, unknown> | null,
): string[] {
  return collectInstagramHandles([
    event.description,
    event.sourceCaption,
    ...event.artists,
    readJsonString(normalizedFields, "sourceCaptionFromModel"),
    readJsonString(normalizedFields, "description"),
    readJsonString(normalizedFields, "reasoningNotes"),
  ]);
}

function hasUnreliableComparableTitle(normalizedFields: Record<string, unknown> | null): boolean {
  return (
    readJsonBoolean(normalizedFields, "titleUsedFallback") === true ||
    readJsonBoolean(normalizedFields, "titleDerivedFromContext") === true
  );
}

function getSemanticDuplicateMatchScore(
  existing: ExistingEventRecord,
  next: PreparedEvent,
  nextNormalizedFields: Record<string, unknown>,
): number {
  if (normalizeString(existing.date) !== next.date) {
    return -1;
  }

  const existingNormalizedFields = parseJsonRecord(existing.normalizedFieldsJson);
  const existingVenueCandidates = getComparableVenueCandidates(existing, existingNormalizedFields);
  const nextVenueCandidates = getComparableVenueCandidates(next, nextNormalizedFields);
  const venueMatches = existingVenueCandidates.some((left) =>
    nextVenueCandidates.some((right) => areComparableVenueTexts(left, right)),
  );
  const existingTitleCandidates = getComparableTitleCandidates(existing, existingNormalizedFields);
  const nextTitleCandidates = getComparableTitleCandidates(next, nextNormalizedFields);
  const existingArtistCandidates = getComparableArtistCandidates(existing);
  const nextArtistCandidates = getComparableArtistCandidates(next);
  const existingEvidenceCandidates = getComparableEvidenceCandidates(
    existing,
    existingNormalizedFields,
  );
  const nextEvidenceCandidates = getComparableEvidenceCandidates(next, nextNormalizedFields);
  const existingTitleFamilyCandidates = getComparableTitleFamilyCandidates(
    existing,
    existingNormalizedFields,
  );
  const nextTitleFamilyCandidates = getComparableTitleFamilyCandidates(
    next,
    nextNormalizedFields,
  );
  const existingIdentityCandidates = getComparableIdentityCandidates(
    existing,
    existingNormalizedFields,
  );
  const nextIdentityCandidates = getComparableIdentityCandidates(next, nextNormalizedFields);
  const sharedMentionHandleCount = countSharedValues(
    getComparableMentionHandles(existing, existingNormalizedFields),
    getComparableMentionHandles(next, nextNormalizedFields),
  );

  const titleMatches = hasComparableTextOverlap(existingTitleCandidates, nextTitleCandidates);
  const artistMatches = hasComparableTextOverlap(existingArtistCandidates, nextArtistCandidates);
  const crossFieldMatches =
    hasComparableTextOverlap(existingTitleCandidates, nextArtistCandidates) ||
    hasComparableTextOverlap(existingArtistCandidates, nextTitleCandidates);
  const evidenceMatches = hasComparableTextOverlap(
    existingEvidenceCandidates,
    nextEvidenceCandidates,
  );
  const timeMatches = areTimesCompatible(existing.time, next.time);
  const hasFallbackTitle =
    hasUnreliableComparableTitle(existingNormalizedFields) ||
    hasUnreliableComparableTitle(nextNormalizedFields);
  const strongTitleFamilyMatches =
    !hasFallbackTitle &&
    existingTitleFamilyCandidates.some((left) =>
      nextTitleFamilyCandidates.some((right) => areCompatibleTitleFamilySlugs(left, right)),
    );
  const contextualVenueMatches =
    strongTitleFamilyMatches &&
    (hasVenueContextSupport(
      getComparableContextCandidates(existing, existingNormalizedFields),
      nextVenueCandidates,
    ) ||
      hasVenueContextSupport(
        getComparableContextCandidates(next, nextNormalizedFields),
        existingVenueCandidates,
      ));
  const contextualIdentityMatches =
    hasContextCandidateSupport(
      getComparableContextCandidates(existing, existingNormalizedFields),
      nextIdentityCandidates,
    ) ||
    hasContextCandidateSupport(
      getComparableContextCandidates(next, nextNormalizedFields),
      existingIdentityCandidates,
    );

  if (!venueMatches && !contextualVenueMatches) {
    return -1;
  }

  if (
    !titleMatches &&
    !artistMatches &&
    !crossFieldMatches &&
    !evidenceMatches &&
    !strongTitleFamilyMatches &&
    sharedMentionHandleCount === 0 &&
    !contextualIdentityMatches
  ) {
    return -1;
  }

  let score = 0;
  if (titleMatches) score += 4;
  if (crossFieldMatches) score += 4;
  if (artistMatches) score += 3;
  if (strongTitleFamilyMatches) score += 2;
  if (sharedMentionHandleCount >= 2) score += 2;
  else if (sharedMentionHandleCount === 1) score += 1;
  if (evidenceMatches) score += 1;
  if (timeMatches) score += 1;
  if (contextualIdentityMatches) score += 1;
  if (!venueMatches && contextualVenueMatches) {
    score += 1;
  }
  if (hasFallbackTitle && (crossFieldMatches || artistMatches || evidenceMatches)) {
    score += 1;
  }
  if (contextualIdentityMatches && (hasFallbackTitle || timeMatches)) {
    score += 1;
  }

  return score;
}

function isMultiEventNormalizedFields(
  normalizedFields: Record<string, unknown> | null,
): boolean {
  return (
    readJsonBoolean(normalizedFields, "multiEventSplitDetected") === true ||
    (readJsonNumber(normalizedFields, "multiEventSplitCount") ?? 0) > 1
  );
}

function allowsDateOnlySourceIdentityMatch(
  existing: ExistingEventRecord,
  nextNormalizedFields: Record<string, unknown>,
): boolean {
  if (isMultiEventNormalizedFields(nextNormalizedFields)) {
    return false;
  }

  const existingNormalizedFields = parseJsonRecord(existing.normalizedFieldsJson);
  return !isMultiEventNormalizedFields(existingNormalizedFields);
}

function choosePreferredDescription(
  existing: string | undefined,
  next: string | undefined,
  nextNormalizedFieldsJson?: string,
): string | undefined {
  const normalizedExisting = normalizeString(existing);
  const normalizedNext = normalizeString(next);
  const nextNormalizedFields = parseJsonRecord(nextNormalizedFieldsJson);

  if (!normalizedExisting) {
    return normalizedNext || undefined;
  }

  if (!normalizedNext) {
    return normalizedExisting;
  }

  if (normalizedExisting === normalizedNext) {
    return normalizedExisting;
  }

  if (readJsonBoolean(nextNormalizedFields, "multiEventSplitDetected") && normalizedNext) {
    return normalizedNext;
  }

  if (normalizedNext.length >= normalizedExisting.length * 1.25) {
    return normalizedNext;
  }

  return normalizedExisting;
}

function hasMaterialEventChange(
  existing: ExistingEventRecord,
  next: PreparedEvent,
  nextDescription: string | undefined = next.description,
): boolean {
  if (normalizeString(existing.title) !== normalizeString(next.title)) return true;
  if (normalizeString(existing.date) !== normalizeString(next.date)) return true;
  if (normalizeString(existing.time) !== normalizeString(next.time)) return true;
  if (normalizeString(existing.venue) !== normalizeString(next.venue)) return true;
  if (normalizeString(existing.eventType) !== normalizeString(next.eventType)) return true;
  if (normalizeString(existing.ticketPrice) !== normalizeString(next.ticketPrice)) return true;
  if (normalizeString(existing.description) !== normalizeString(nextDescription)) return true;
  if (normalizeString(existing.imageUrl) !== normalizeString(next.imageUrl)) return true;
  if (
    JSON.stringify(normalizeArtistsForComparison(existing.artists)) !==
    JSON.stringify(normalizeArtistsForComparison(next.artists))
  ) {
    return true;
  }
  return false;
}

function buildDuplicateUpdatePatch(
  existing: ExistingEventRecord,
  next: PreparedEvent,
): {
  patch: {
    title?: string;
    date?: string;
    time?: string;
    venue?: string;
    artists?: string[];
    description?: string;
    imageUrl?: string;
    instagramPostUrl?: string;
    instagramPostId?: string;
    ticketPrice?: string;
    eventType?: string;
    sourceCaption?: string;
    sourcePostedAt?: string;
    rawExtractionJson?: string;
    normalizedFieldsJson?: string;
    status?: EventStatus;
    reviewedAt?: number;
    reviewedBy?: string;
    moderationNote?: string;
  };
  materiallyChanged: boolean;
  statusResetToPending: boolean;
  statusAutoApproved: boolean;
} {
  const preferredDescription = choosePreferredDescription(
    existing.description,
    next.description,
    next.normalizedFieldsJson,
  );
  const materiallyChanged = hasMaterialEventChange(existing, next, preferredDescription);
  const statusAutoApproved = next.status === "approved" && existing.status !== "approved";
  // Keep previously approved events out of moderation on re-scrape.
  const statusResetToPending =
    materiallyChanged && existing.status === "rejected" && next.status !== "approved";
  const nextStatus: EventStatus =
    next.status === "approved"
      ? "approved"
      : statusResetToPending
        ? "pending"
        : existing.status;
  const descriptionChanged =
    normalizeString(existing.description) !== normalizeString(preferredDescription);

  return {
    patch: {
      title: next.title,
      date: next.date,
      ...(next.time ? { time: next.time } : {}),
      venue: next.venue,
      artists: next.artists,
      ...(descriptionChanged && preferredDescription
        ? { description: preferredDescription }
        : {}),
      ...(next.imageUrl ? { imageUrl: next.imageUrl } : {}),
      instagramPostUrl: next.instagramPostUrl,
      instagramPostId: next.instagramPostId,
      ...(next.ticketPrice ? { ticketPrice: next.ticketPrice } : {}),
      eventType: next.eventType,
      ...(next.sourceCaption ? { sourceCaption: next.sourceCaption } : {}),
      ...(next.sourcePostedAt ? { sourcePostedAt: next.sourcePostedAt } : {}),
      ...(next.rawExtractionJson ? { rawExtractionJson: next.rawExtractionJson } : {}),
      ...(next.normalizedFieldsJson ? { normalizedFieldsJson: next.normalizedFieldsJson } : {}),
      ...(nextStatus !== existing.status ? { status: nextStatus } : {}),
      ...(statusResetToPending || statusAutoApproved
        ? {
            reviewedAt: undefined,
            reviewedBy: undefined,
            moderationNote: undefined,
          }
        : {}),
    },
    materiallyChanged,
    statusResetToPending,
    statusAutoApproved,
  };
}

async function listExistingEventsBySourceIdentity(
  client: ConvexHttpClient,
  post: InstagramScrapedPost,
  serviceSecret: string,
): Promise<ExistingSourceMatch[]> {
  const postContext = getPostContext(normalizeHandle(post.username), post);
  const matchesById = new Map<string, ExistingSourceMatch>();

  const loadMatchesByPostId = async (
    candidate: string,
    matchedBy: "post_id" | "shortcode",
  ): Promise<ExistingSourceMatch[]> => {
    try {
      const records = (await client.query(listByInstagramPostIdQuery, {
        instagramPostId: candidate,
        serviceSecret,
      })) as ExistingEventRecord[];
      return records.map((existingEvent) => ({
        existingEvent,
        matchedBy,
        matchedValue: candidate,
      }));
    } catch (listError) {
      logError("ingestion.duplicate_lookup.list_failed", {
        step: "duplicate_lookup" satisfies IngestionStep,
        lookup: "events:listByInstagramPostId",
        ...postContext,
        candidate,
        matchedBy,
        error: getErrorMessage(listError),
      });

      try {
        const fallback = (await client.query(getByInstagramPostIdQuery, {
          instagramPostId: candidate,
          serviceSecret,
        })) as ExistingEventRecord | null;
        if (!fallback) {
          return [];
        }
        return [
          {
            existingEvent: fallback,
            matchedBy,
            matchedValue: candidate,
          },
        ];
      } catch (fallbackError) {
        logError("ingestion.duplicate_lookup.fallback_failed", {
          step: "duplicate_lookup" satisfies IngestionStep,
          lookup: "events:getByInstagramPostId",
          ...postContext,
          candidate,
          matchedBy,
          error: getErrorMessage(fallbackError),
        });
        return [];
      }
    }
  };

  const loadMatchesByPostUrl = async (postUrl: string): Promise<ExistingSourceMatch[]> => {
    try {
      const records = (await client.query(listByInstagramPostUrlQuery, {
        instagramPostUrl: postUrl,
        serviceSecret,
      })) as ExistingEventRecord[];
      return records.map((existingEvent) => ({
        existingEvent,
        matchedBy: "post_url" as const,
        matchedValue: postUrl,
      }));
    } catch (listError) {
      logError("ingestion.duplicate_lookup.list_failed", {
        step: "duplicate_lookup" satisfies IngestionStep,
        lookup: "events:listByInstagramPostUrl",
        ...postContext,
        postUrl,
        matchedBy: "post_url",
        error: getErrorMessage(listError),
      });

      try {
        const fallback = (await client.query(getByInstagramPostUrlQuery, {
          instagramPostUrl: postUrl,
          serviceSecret,
        })) as ExistingEventRecord | null;
        if (!fallback) {
          return [];
        }
        return [
          {
            existingEvent: fallback,
            matchedBy: "post_url",
            matchedValue: postUrl,
          },
        ];
      } catch (fallbackError) {
        logError("ingestion.duplicate_lookup.fallback_failed", {
          step: "duplicate_lookup" satisfies IngestionStep,
          lookup: "events:getByInstagramPostUrl",
          ...postContext,
          postUrl,
          matchedBy: "post_url",
          error: getErrorMessage(fallbackError),
        });
        return [];
      }
    }
  };

  const identityCandidates = new Set<string>();
  if (post.postId) {
    identityCandidates.add(post.postId);
  }
  const shortcode = extractShortcodeFromPostUrl(post.instagramPostUrl);
  if (shortcode) {
    identityCandidates.add(shortcode);
  }

  for (const candidate of identityCandidates) {
    const matchedBy = candidate === post.postId ? "post_id" : "shortcode";
    const matches = await loadMatchesByPostId(candidate, matchedBy);
    for (const match of matches) {
      matchesById.set(match.existingEvent._id, match);
    }
  }

  const postUrl = normalizeString(post.instagramPostUrl);
  if (postUrl) {
    const matches = await loadMatchesByPostUrl(postUrl);
    for (const match of matches) {
      matchesById.set(match.existingEvent._id, match);
    }
  }

  return [...matchesById.values()];
}

async function listExistingEventsByPreparedDates(
  client: ConvexHttpClient,
  post: InstagramScrapedPost,
  preparedResults: PrepareEventResult[],
  serviceSecret: string,
): Promise<ExistingSourceMatch[]> {
  const postContext = getPostContext(normalizeHandle(post.username), post);
  const matchesById = new Map<string, ExistingSourceMatch>();
  const dates = [...new Set(
    preparedResults
      .filter((prepared): prepared is Extract<PrepareEventResult, { kind: "ok" }> => prepared.kind === "ok")
      .map((prepared) => prepared.event.date),
  )];

  for (const date of dates) {
    try {
      const records = (await client.query(listByDateQuery, {
        date,
        serviceSecret,
      })) as ExistingEventRecord[];
      for (const existingEvent of records) {
        if (matchesById.has(existingEvent._id)) {
          continue;
        }
        matchesById.set(existingEvent._id, {
          existingEvent,
          matchedBy: "same_date_semantic",
          matchedValue: date,
        });
      }
    } catch (error) {
      logError("ingestion.duplicate_lookup.list_failed", {
        step: "duplicate_lookup" satisfies IngestionStep,
        lookup: "events:listByDate",
        ...postContext,
        date,
        matchedBy: "same_date_semantic",
        error: getErrorMessage(error),
      });
    }
  }

  return [...matchesById.values()];
}

function normalizeTitleKey(value: string | undefined): string {
  return normalizeString(value).toLowerCase().replace(/\s+/g, " ");
}

function findBestExistingMatchForPreparedEvent(
  existingMatches: ExistingSourceMatch[],
  nextEvent: PreparedEvent,
  nextNormalizedFields: Record<string, unknown>,
): ExistingSourceMatch | null {
  const sourceIdentityMatches = existingMatches.filter(
    (existing) => existing.matchedBy !== "same_date_semantic",
  );
  const titleKey = normalizeTitleKey(nextEvent.title);
  const exactMatch = sourceIdentityMatches.find(
    (existing) =>
      normalizeString(existing.existingEvent.date) === nextEvent.date &&
      normalizeTitleKey(existing.existingEvent.title) === titleKey,
  );
  if (exactMatch) {
    return exactMatch;
  }

  const sameDateMatch = sourceIdentityMatches.find(
    (existing) =>
      normalizeString(existing.existingEvent.date) === nextEvent.date &&
      allowsDateOnlySourceIdentityMatch(existing.existingEvent, nextNormalizedFields),
  );
  if (sameDateMatch) {
    return sameDateMatch;
  }

  let bestSemanticMatch: ExistingSourceMatch | null = null;
  let bestSemanticScore = -1;
  let comparableSemanticMatches = 0;

  for (const existing of existingMatches) {
    if (existing.matchedBy !== "same_date_semantic") {
      continue;
    }

    const score = getSemanticDuplicateMatchScore(
      existing.existingEvent,
      nextEvent,
      nextNormalizedFields,
    );
    if (score >= 3) {
      comparableSemanticMatches += 1;
    }
    if (score > bestSemanticScore) {
      bestSemanticScore = score;
      bestSemanticMatch = existing;
    }
  }

  if (bestSemanticScore >= 4) {
    return bestSemanticMatch;
  }

  // Same-date and same-venue collisions are rarely legitimate duplicates here.
  // If there is only one strong candidate for that date/venue, allow an artist-led match.
  if (bestSemanticScore >= 3 && comparableSemanticMatches === 1) {
    return bestSemanticMatch;
  }

  return null;
}

export function prepareEventsForInsert(
  post: InstagramScrapedPost,
  extracted: ExtractedEventData,
  selectedImageUrl: string | null,
  canonicalVenueNamesByHandle: Record<string, string>,
  venueNameOverridesByHandle: Record<string, string>,
  configuredVenueNamesByHandle: Record<string, string>,
): PrepareEventResult[] {
  const eventType = canonicalizeEventType(normalizeString(extracted.category));
  const description = normalizeExtractedDescription(extracted.description);
  const rawExtractedTime = normalizeString(extracted.time ?? undefined);
  const rawExtractedDate = normalizeString(extracted.date);
  const price = normalizeString(extracted.price);
  const currency = normalizeString(extracted.currency);
  const ticketPrice = normalizeTicketPrice(price, currency);
  const confidence = normalizeConfidenceScore(extracted.confidence);
  const venueNormalization = normalizeVenue(
    post,
    extracted.venue,
    canonicalVenueNamesByHandle,
    venueNameOverridesByHandle,
  );
  const titleNormalization = normalizeEventTitle(
    post,
    extracted,
    venueNormalization,
    canonicalVenueNamesByHandle,
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
  const candidateDates =
    expandedRangeDates && expandedRangeDates.length > 1
      ? expandedRangeDates
      : dateNormalization.isoDate
        ? [dateNormalization.isoDate]
        : [];
  const splitEventCandidates = extractSplitEventCandidates(post, extracted);
  const usesSplitEventCandidates = splitEventCandidates.length > 0;
  const extractedArtists = normalizeExtractedArtists(extracted.artists);
  const eventDateFilter = getEventDateFilterContext();
  const isCaptionOnlyVideo = isVideoPostWithoutSelectedImage(post, selectedImageUrl);
  const extractionMode = selectedImageUrl ? "poster" : "caption_only";
  const missingImage = !selectedImageUrl;
  const allowMissingImageForModeration = isCaptionOnlyVideo;
  const normalizedFieldsCommon: Record<string, unknown> = {
    rawTitle: titleNormalization.rawTitle,
    rawVenue: normalizeString(extracted.venue),
    normalizedVenue: venueNormalization.venue,
    venueSource: venueNormalization.source,
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
    usesSplitEventCandidates && referenceSplitCandidate ? referenceSplitCandidate.lineTitle : title;
  const referenceTitleSource =
    usesSplitEventCandidates && referenceSplitCandidate
      ? referenceSplitCandidate.source
      : titleNormalization.source;
  const referenceTitleUsedFallback = usesSplitEventCandidates
    ? false
    : titleNormalization.usedFallback;
  const referenceTitleDerivedFromContext = usesSplitEventCandidates
    ? false
    : titleNormalization.source === "context_derived";
  const referenceTitleContextCandidate = usesSplitEventCandidates
    ? null
    : titleNormalization.contextCandidate;
  const referenceArtists =
    referenceSplitCandidate?.artists.length ? referenceSplitCandidate.artists : extractedArtists;
  const referenceDescription = referenceSplitCandidate?.description ?? description;
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

  if (!venueNormalization.venue) {
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
    return [
      {
        kind: "skip",
        reason: "missing_venue",
        normalizedFields,
      },
    ];
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

  const eventVariants = usesSplitEventCandidates
    ? splitEventCandidates.map((entry) => {
        const usesSplitScheduleTitle = entry.lineTitle.length > 0;
        const variantArtists =
          entry.artists.length > 0 ? entry.artists : extractedArtists;
        const variantDescription =
          entry.description ??
          buildSplitEventDescription(eventType, venueNormalization.venue, variantArtists) ??
          description;
        return {
          title: usesSplitScheduleTitle ? entry.lineTitle : title,
          titleSource: usesSplitScheduleTitle ? entry.source : titleNormalization.source,
          titleUsedFallback: usesSplitScheduleTitle ? false : titleNormalization.usedFallback,
          titleDerivedFromContext:
            usesSplitScheduleTitle ? false : titleNormalization.source === "context_derived",
          titleContextCandidate:
            usesSplitScheduleTitle ? null : titleNormalization.contextCandidate,
          rawDate: entry.rawDate,
          dateNormalization: entry.normalizedDate,
          time: entry.time ?? "",
          rawTime: entry.rawTime ?? entry.time ?? "",
          consistencyIssues: entry.consistencyIssues,
          artists: variantArtists,
          description: variantDescription,
          splitSource: entry.source,
          splitSourceLine: entry.sourceLine,
        };
      })
    : candidateDates.map((date) => ({
        title,
        titleSource: titleNormalization.source,
        titleUsedFallback: titleNormalization.usedFallback,
        titleDerivedFromContext: titleNormalization.source === "context_derived",
        titleContextCandidate: titleNormalization.contextCandidate,
        rawDate: normalizeString(extracted.date),
        dateNormalization: {
          ...dateNormalization,
          isoDate: date,
        } satisfies DateNormalization,
        time,
        rawTime: rawExtractedTime,
        consistencyIssues: extractedTimeIssues,
        artists: extractedArtists,
        description,
        splitSource: null,
        splitSourceLine: null,
      }));

  const preparedEvents: PrepareEventResult[] = [];

  for (const [index, variant] of eventVariants.entries()) {
    const date = variant.dateNormalization.isoDate;
    const eventConsistency = checkEventConsistency({
      isoDate: date,
      rawDateText: variant.rawDate,
      time: variant.time,
      weekdayEvidence: variant.splitSourceLine ?? normalizeString(extracted.date),
    });
    const consistencyIssues = [...new Set([
      ...variant.consistencyIssues,
      ...eventConsistency.issues,
    ])];
    const timeTbdApplied = !eventConsistency.sanitizedTime && Boolean(date);
    const safeTime = eventConsistency.sanitizedTime || (timeTbdApplied ? TBD_EVENT_TIME : "");
    const timeSanitized = consistencyIssues.includes("time_is_date");
    const dateRepairReason = consistencyIssues.includes("weekday_date_mismatch")
      ? "weekday_date_mismatch_numeric_date_authoritative"
      : null;
    const autoApprovalBlockers = [
      ...getPosterScheduleAutoApprovalBlockers({
        splitSource: variant.splitSource,
        independentTextEvidence: independentPostTextEvidence,
        hasTime: Boolean(eventConsistency.sanitizedTime),
      }),
      ...getNonEventAutoApprovalBlockers(
        [
          postTextEvidence,
          description,
          variant.description,
          variant.splitSourceLine,
        ].join("\n"),
      ),
    ];
    const moderationDecision = buildModerationDecision({
      baseConfidenceScore: confidence,
      missingImage,
      allowMissingImage: allowMissingImageForModeration,
      titleUsedFallback: variant.titleUsedFallback,
      missingTime: !eventConsistency.sanitizedTime,
      suspiciousYear: variant.dateNormalization.suspiciousYear,
      dateConfidence: variant.dateNormalization.confidence,
      hasDate: Boolean(date),
      hasVenue: Boolean(venueNormalization.venue),
      extractionMode,
      isVideoPost: isCaptionOnlyVideo,
      autoApprovalBlockers,
    });
    const eventStatus: EventStatus = moderationDecision.autoApproved ? "approved" : "pending";
    const normalizedFields: Record<string, unknown> = {
      ...normalizedFieldsCommon,
      time: safeTime || null,
      title: variant.title,
      titleSource: variant.titleSource,
      titleUsedFallback: variant.titleUsedFallback,
      titleDerivedFromContext: variant.titleDerivedFromContext,
      titleContextCandidate: variant.titleContextCandidate,
      rawDate: variant.rawDate,
      rawExtractedDateText: variant.dateNormalization.rawDateText,
      normalizedDate: date,
      dateSource: variant.dateNormalization.source,
      dateConfidence: variant.dateNormalization.confidence,
      dateDistanceFromPostDays: variant.dateNormalization.distanceFromPostDays,
      dateInferredYear: variant.dateNormalization.inferredYear,
      dateSuspiciousYear: variant.dateNormalization.suspiciousYear,
      dateYearSelectionReason: variant.dateNormalization.yearSelectionReason,
      dateReason: variant.dateNormalization.reason ?? null,
      artists: variant.artists,
      description: variant.description,
      dateRangeExpanded: !usesSplitEventCandidates && candidateDates.length > 1,
      dateRangeExpandedCount: !usesSplitEventCandidates ? candidateDates.length : 1,
      multiEventSplitDetected: usesSplitEventCandidates,
      multiEventSplitCount: usesSplitEventCandidates ? splitEventCandidates.length : 1,
      splitEventIndex: index + 1,
      splitEventTotal: eventVariants.length,
      splitSource: variant.splitSource,
      splitSourceLine: variant.splitSourceLine,
      rowSourceText: variant.splitSourceLine ?? null,
      expandedDateIndex: index + 1,
      expandedDateTotal: eventVariants.length,
      moderationConfidenceScore: moderationDecision.confidenceScore,
      moderationAutoApproveThreshold: AUTO_APPROVE_CONFIDENCE_THRESHOLD,
      moderationCoreEventAutoApproveThreshold: CORE_EVENT_AUTO_APPROVE_CONFIDENCE_THRESHOLD,
      moderationCaptionOnlyVideoMinConfidence: CAPTION_ONLY_VIDEO_AUTO_APPROVE_MIN_CONFIDENCE,
      moderationAutoApproved: moderationDecision.autoApproved,
      moderationAutoApproveRule: moderationDecision.autoApproveRule,
      moderationPendingReasons: moderationDecision.pendingReasons,
      moderationSignals: moderationDecision.signals,
      consistencyIssues,
      timeSanitized,
      timeTbdApplied,
      timeSanitizedFrom: timeSanitized
        ? normalizeString(variant.rawTime || variant.time) || null
        : null,
      dateRepairApplied: false,
      dateRepairReason,
      normalizedIsValid: true,
      normalizedInvalidReason: null,
      extractionScorecard: buildExtractionScorecard({
        baseConfidenceScore: confidence,
        moderationDecision,
        fieldConfirmation: extracted.field_confirmation,
        normalizedIsValid: true,
        normalizedInvalidReason: null,
      }),
    };

    if (!date) {
      preparedEvents.push({
        kind: "skip",
        reason:
          variant.dateNormalization.reason === "missing_date"
            ? "missing_date"
            : "invalid_event",
        normalizedFields: {
          ...normalizedFields,
          normalizedIsValid: false,
          normalizedInvalidReason: "invalid_date",
          extractionScorecard: buildSkippedExtractionScorecard({
            baseConfidenceScore: confidence,
            fieldConfirmation: extracted.field_confirmation,
            normalizedInvalidReason: "invalid_date",
          }),
        },
      });
      continue;
    }

    if (!variant.title) {
      preparedEvents.push({
        kind: "skip",
        reason: "invalid_event",
        normalizedFields: {
          ...normalizedFields,
          normalizedIsValid: false,
          normalizedInvalidReason: "missing_required_fields",
          extractionScorecard: buildSkippedExtractionScorecard({
            baseConfidenceScore: confidence,
            fieldConfirmation: extracted.field_confirmation,
            normalizedInvalidReason: "missing_required_fields",
          }),
        },
      });
      continue;
    }

    if (date < eventDateFilter.todayIsoDate) {
      preparedEvents.push({
        kind: "skip",
        reason: "past_event",
        normalizedFields: {
          ...normalizedFields,
          normalizedIsValid: false,
          normalizedInvalidReason: "past_event",
          extractionScorecard: buildSkippedExtractionScorecard({
            baseConfidenceScore: confidence,
            fieldConfirmation: extracted.field_confirmation,
            normalizedInvalidReason: "past_event",
          }),
        },
      });
      continue;
    }

    if (date > eventDateFilter.maxFutureIsoDate) {
      preparedEvents.push({
        kind: "skip",
        reason: "far_future",
        normalizedFields: {
          ...normalizedFields,
          normalizedIsValid: false,
          normalizedInvalidReason: "far_future_event",
          extractionScorecard: buildSkippedExtractionScorecard({
            baseConfidenceScore: confidence,
            fieldConfirmation: extracted.field_confirmation,
            normalizedInvalidReason: "far_future_event",
          }),
        },
      });
      continue;
    }

    preparedEvents.push({
      kind: "ok",
      normalizedFields,
      event: {
        title: variant.title,
        date,
        ...(safeTime ? { time: safeTime } : {}),
        venue: venueNormalization.venue,
        artists: variant.artists,
        ...(variant.description ? { description: variant.description } : {}),
        ...(selectedImageUrl ? { imageUrl: selectedImageUrl } : {}),
        instagramPostUrl: post.instagramPostUrl,
        instagramPostId: post.postId,
        ...(ticketPrice ? { ticketPrice } : {}),
        eventType,
        ...(post.caption ? { sourceCaption: post.caption } : {}),
        ...(post.postedAt ? { sourcePostedAt: post.postedAt } : {}),
        rawExtractionJson: JSON.stringify(extracted),
        normalizedFieldsJson: JSON.stringify(normalizedFields),
        status: eventStatus,
      },
    });
  }

  return preparedEvents;
}

type ProcessIngestionPostOptions = {
  client: ConvexHttpClient;
  handle: string;
  post: InstagramScrapedPost;
  summary: HandleSummary;
  canonicalVenueNamesByHandle: Record<string, string>;
  venueNameOverridesByHandle: Record<string, string>;
  configuredVenueNamesByHandle: Record<string, string>;
  serviceSecret: string;
};

async function processIngestionPost(options: ProcessIngestionPostOptions): Promise<void> {
  const {
    client,
    handle,
    post,
    summary,
    canonicalVenueNamesByHandle,
    venueNameOverridesByHandle,
    configuredVenueNamesByHandle,
    serviceSecret,
  } = options;
  const postContext = getPostContext(handle, post);
  const canonicalVenueName =
    getConfiguredVenueNameForHandle(
      post.username,
      configuredVenueNamesByHandle,
      STATIC_VENUE_BY_HANDLE,
    ) || null;
  const canUseCaptionOnlyExtraction = buildPostTextEvidence(post).length > 0;
  const extractionMode = post.postType === "video" ? "caption_only" : "poster";
  let sourceIdentityMatches: ExistingSourceMatch[] = [];
  let selectedImageUrl: string | null = null;
  let imageDataUrl: string | null = null;

  try {
    sourceIdentityMatches = await listExistingEventsBySourceIdentity(
      client,
      post,
      serviceSecret,
    );
  } catch (error) {
    summary.failedExtractions += 1;
    summary.failed_extractions += 1;
    summary.errors.push(getErrorMessage(error));
    logError("ingestion.source_duplicate_precheck.failed", {
      step: "duplicate_lookup" satisfies IngestionStep,
      ...postContext,
      extractionMode,
      error: getErrorMessage(error),
    });
    return;
  }

  const sourceDuplicateSkipDecision = getPreExtractionSourceDuplicateSkipDecision(
    sourceIdentityMatches,
    post,
  );

  if (sourceDuplicateSkipDecision) {
    recordSourceDuplicateSkip(summary, sourceDuplicateSkipDecision);
    logInfo("duplicate_source_precheck_skip", {
      ...postContext,
      extractionMode,
      matchedBy: sourceDuplicateSkipDecision.match.matchedBy,
      matchedValue: sourceDuplicateSkipDecision.match.matchedValue,
      existingEventId: sourceDuplicateSkipDecision.match.existingEvent._id,
      existingStatus: sourceDuplicateSkipDecision.match.existingEvent.status,
      reason: sourceDuplicateSkipDecision.reason,
      reprocessExistingSourcePosts: shouldReprocessExistingSourcePosts(),
      qualityReasons: sourceDuplicateSkipDecision.quality.reasons,
      qualityDetails: sourceDuplicateSkipDecision.quality.details,
    });
    return;
  }

  if (post.postType === "video") {
    if (!canUseCaptionOnlyExtraction) {
      summary.skipped_video += 1;
      logInfo("ingestion.post.skipped_video", {
        ...postContext,
        reason: "missing_text_evidence",
      });
      return;
    }

    {
      const candidateImageUrl = resolveBestImageUrl(post);
      selectedImageUrl =
        candidateImageUrl && !isInstagramOrFbCdnUrl(candidateImageUrl)
          ? candidateImageUrl
          : null;
    }
    logInfo("ingestion.post.video_caption_only", {
      ...postContext,
      captionLength: normalizeString(post.caption).length,
      hasAltText: extractPostAltTextEvidence(post.altText).length > 0,
      selectedImageUrl,
    });
  } else {
    selectedImageUrl = resolveBestImageUrl(post);
    if (!selectedImageUrl) {
      summary.skippedNoImage += 1;
      logInfo("ingestion.image.skipped_no_image", {
        ...postContext,
        imageCandidates: post.imageUrls ?? [],
      });
      return;
    }

    logInfo("ingestion.image.selected", {
      ...postContext,
      selectedImageUrl,
      isInstagramOrFbCdn: isInstagramOrFbCdnUrl(selectedImageUrl),
    });

    let downloadedImage: Awaited<ReturnType<typeof downloadImage>>;
    try {
      downloadedImage = await downloadImage(selectedImageUrl);
      logInfo("ingestion.image.download.success", {
        ...postContext,
        selectedImageUrl,
        contentType: downloadedImage.contentType,
        downloadedBytes: downloadedImage.imageBuffer.byteLength,
      });
    } catch (error) {
      summary.failedDownloads += 1;
      summary.failed_downloads += 1;
      summary.errors.push(getErrorMessage(error));
      logError("ingestion.image.download.failed", {
        ...postContext,
        selectedImageUrl,
        error: getErrorMessage(error),
      });
      return;
    }

    try {
      const normalizedImage = await normalizeToJpeg(
        downloadedImage.imageBuffer,
        downloadedImage.contentType ?? selectedImageUrl,
      );
      imageDataUrl = toDataUrl(normalizedImage.imageBuffer, normalizedImage.mimeType);
      logInfo("ingestion.image.conversion.success", {
        ...postContext,
        selectedImageUrl,
        wasConverted: normalizedImage.wasConverted,
        outputMimeType: normalizedImage.mimeType,
        outputBytes: normalizedImage.imageBuffer.byteLength,
      });
    } catch (error) {
      summary.failedConversions += 1;
      summary.failed_conversions += 1;
      summary.errors.push(getErrorMessage(error));
      logError("ingestion.image.conversion.failed", {
        ...postContext,
        selectedImageUrl,
        error: getErrorMessage(error),
      });
      return;
    }
  }

  let extracted: ExtractedEventData;
  try {
    extracted = await extractEventDataFromInstagramPost({
      imageDataUrl,
      caption: post.caption,
      altText: post.altText,
      instagramPostUrl: post.instagramPostUrl,
      sourceImageUrl: selectedImageUrl,
      instagramHandle: post.username,
      instagramPostTimestamp: post.postedAt,
      instagramLocationName: post.locationName,
      canonicalVenueName,
      extractionMode,
    });
    extracted = normalizeConfidencePayload(extracted);
  } catch (error) {
    summary.failedExtractions += 1;
    summary.failed_extractions += 1;
    summary.failed_extraction += 1;
    summary.errors.push(getErrorMessage(error));
    logError("ingestion.openai.extraction.failed", {
      step: "extract_event" satisfies IngestionStep,
      ...postContext,
      extractionMode,
      sourceImageUrl: selectedImageUrl,
      error: getErrorMessage(error),
    });
    return;
  }

  let preparedResults: PrepareEventResult[];
  try {
    preparedResults = prepareEventsForInsert(
      post,
      extracted,
      selectedImageUrl,
      canonicalVenueNamesByHandle,
      venueNameOverridesByHandle,
      configuredVenueNamesByHandle,
    );
  } catch (error) {
    summary.failedExtractions += 1;
    summary.failed_extractions += 1;
    summary.failed_extraction += 1;
    summary.errors.push(getErrorMessage(error));
    logError("ingestion.normalization.failed", {
      step: "normalize_posts" satisfies IngestionStep,
      ...postContext,
      extractionMode,
      selectedImageUrl,
      error: getErrorMessage(error),
    });
    return;
  }

  let existingMatches: ExistingSourceMatch[] = [];
  try {
    const sameDateMatches = await listExistingEventsByPreparedDates(
      client,
      post,
      preparedResults,
      serviceSecret,
    );
    const matchesById = new Map<string, ExistingSourceMatch>();
    for (const match of sourceIdentityMatches) {
      matchesById.set(match.existingEvent._id, match);
    }
    for (const match of sameDateMatches) {
      if (!matchesById.has(match.existingEvent._id)) {
        matchesById.set(match.existingEvent._id, match);
      }
    }
    existingMatches = [...matchesById.values()];
  } catch (error) {
    summary.failedExtractions += 1;
    summary.failed_extractions += 1;
    summary.errors.push(getErrorMessage(error));
    logError("ingestion.duplicate_check.failed", {
      step: "duplicate_lookup" satisfies IngestionStep,
      ...postContext,
      extractionMode,
      selectedImageUrl,
      error: getErrorMessage(error),
    });
    return;
  }

  for (const prepared of preparedResults) {
    if (prepared.kind === "skip") {
      if (prepared.reason === "missing_date") {
        summary.skipped_missing_date += 1;
      } else if (prepared.reason === "missing_venue") {
        summary.skipped_missing_venue += 1;
      } else if (prepared.reason === "past_event") {
        summary.skipped_past_event += 1;
      } else if (prepared.reason === "far_future") {
        summary.skipped_far_future_event += 1;
      } else {
        summary.skipped_invalid_event += 1;
      }

      logInfo("ingestion.event.skipped", {
        ...postContext,
        extractionMode,
        selectedImageUrl,
        reason: prepared.reason,
        caption: post.caption,
        postTimestamp: post.postedAt,
        rawExtraction: extracted,
        normalizedFields: prepared.normalizedFields,
      });
      continue;
    }

    const existingMatch = findBestExistingMatchForPreparedEvent(
      existingMatches,
      prepared.event,
      prepared.normalizedFields,
    );

    if (existingMatch) {
      const quality = isLowQualityExistingEvent(existingMatch.existingEvent, post.postedAt);
      const hasMaterialChange = hasMaterialEventChange(
        existingMatch.existingEvent,
        prepared.event,
      );

      if (!quality.isLowQuality && !hasMaterialChange) {
        summary.skippedDuplicates += 1;
        summary.skipped_duplicates += 1;
        summary.skipped_duplicates_clean += 1;
        logInfo("duplicate_clean_skip", {
          ...postContext,
          extractionMode,
          selectedImageUrl,
          matchedBy: existingMatch.matchedBy,
          matchedValue: existingMatch.matchedValue,
          existingEventId: existingMatch.existingEvent._id,
          existingStatus: existingMatch.existingEvent.status,
          normalizedFields: prepared.normalizedFields,
        });
        continue;
      }

      const primaryReason = quality.primaryReason ?? "invalid_normalized_fields";
      const updateReasonEvent = mapDuplicateReasonToLogEvent(primaryReason);
      const updatePayload = buildDuplicateUpdatePatch(
        existingMatch.existingEvent,
        prepared.event,
      );

      try {
        await client.mutation(updateEventMutation, {
          id: existingMatch.existingEvent._id,
          patch: updatePayload.patch,
          serviceSecret,
        });
        summary.updated_duplicates_bad_data += 1;
        logInfo(updateReasonEvent, {
          phase: "duplicate_updated",
          ...postContext,
          extractionMode,
          selectedImageUrl,
          matchedBy: existingMatch.matchedBy,
          matchedValue: existingMatch.matchedValue,
          existingEventId: existingMatch.existingEvent._id,
          qualityReasons: quality.reasons,
          qualityDetails: quality.details,
          materiallyChanged: updatePayload.materiallyChanged,
          statusAutoApproved: updatePayload.statusAutoApproved,
          statusResetToPending: updatePayload.statusResetToPending,
          caption: post.caption,
          postTimestamp: post.postedAt,
          rawExtraction: extracted,
          normalizedFields: prepared.normalizedFields,
        });
        existingMatch.existingEvent = {
          ...existingMatch.existingEvent,
          ...prepared.event,
          status:
            updatePayload.patch.status ?? existingMatch.existingEvent.status,
          reviewedAt:
            updatePayload.patch.reviewedAt ?? existingMatch.existingEvent.reviewedAt,
          reviewedBy:
            updatePayload.patch.reviewedBy ?? existingMatch.existingEvent.reviewedBy,
          moderationNote:
            updatePayload.patch.moderationNote ?? existingMatch.existingEvent.moderationNote,
        };
      } catch (error) {
        summary.duplicate_update_failed += 1;
        summary.errors.push(getErrorMessage(error));
        logError("duplicate_update_failed", {
          step: "update_existing_event" satisfies IngestionStep,
          ...postContext,
          extractionMode,
          selectedImageUrl,
          existingEventId: existingMatch.existingEvent._id,
          qualityReasons: quality.reasons,
          error: getErrorMessage(error),
        });
      }
      continue;
    }

    try {
      const insertedId = (await client.mutation(
        createEventMutation,
        {
          ...prepared.event,
          serviceSecret,
        },
      )) as string;
      summary.insertedEvents += 1;
      summary.inserted_events += 1;
      if (prepared.event.status === "approved") {
        summary.insertedApprovedEvents += 1;
      } else if (prepared.event.status === "pending") {
        summary.insertedPendingEvents += 1;
      }
      existingMatches.push({
        existingEvent: {
          _id: insertedId,
          ...prepared.event,
        },
        matchedBy: "post_url",
        matchedValue: prepared.event.instagramPostUrl,
      });
      logInfo("ingestion.event.inserted", {
        ...postContext,
        extractionMode,
        selectedImageUrl,
        caption: post.caption,
        postTimestamp: post.postedAt,
        rawExtraction: extracted,
        normalizedFields: prepared.normalizedFields,
      });
    } catch (error) {
      summary.failedExtractions += 1;
      summary.failed_extractions += 1;
      summary.failed_extraction += 1;
      summary.errors.push(getErrorMessage(error));
      logError("ingestion.insert.failed", {
        step: "insert_new_event" satisfies IngestionStep,
        ...postContext,
        extractionMode,
        selectedImageUrl,
        error: getErrorMessage(error),
      });
    }
  }
}

type ProcessLoadedPostsForHandleOptions = {
  client: ConvexHttpClient;
  handle: string;
  posts: InstagramScrapedPost[];
  summary: HandleSummary;
  seenSourceKeys: string[];
  serviceSecret: string;
} & IngestionVenueContext;

async function processLoadedPostsForHandle(
  options: ProcessLoadedPostsForHandleOptions,
): Promise<void> {
  const {
    client,
    handle,
    posts,
    summary,
    seenSourceKeys,
    canonicalVenueNamesByHandle,
    venueNameOverridesByHandle,
    configuredVenueNamesByHandle,
    serviceSecret,
  } = options;

  for (const rawPost of posts) {
    let post = rawPost;

    try {
      post = normalizeScrapedPost(post);
    } catch (error) {
      summary.errors.push(getErrorMessage(error));
      logError("ingestion.post.normalize.failed", {
        step: "normalize_posts" satisfies IngestionStep,
        ...getPostContext(handle, post),
        error: getErrorMessage(error),
      });
      continue;
    }

    const sourceKey = getSourceIdentityKey(post);
    if (sourceKey) {
      if (seenSourceKeys.includes(sourceKey)) {
        continue;
      }
      seenSourceKeys.push(sourceKey);
    }

    await processIngestionPost({
      client,
      handle,
      post,
      summary,
      canonicalVenueNamesByHandle,
      venueNameOverridesByHandle,
      configuredVenueNamesByHandle,
      serviceSecret,
    });
  }
}

async function runInstagramIngestionFullScrapeBatchStep(
  options: IngestionBatchStepOptions & IngestionVenueContext & {
    client: ConvexHttpClient;
    serviceSecret: string;
  },
): Promise<IngestionBatchStepResult> {
  const summary = options.summary;
  const state = options.state;
  const handleBatchSize = normalizeBatchSize(options.batchSize);
  const handleBatch = options.handles.slice(
    state.handleIndex,
    state.handleIndex + handleBatchSize,
  );

  if (handleBatch.length > 0) {
    const postsByHandle = await fetchFreshPostsForHandlesInParallel(
      options.client,
      handleBatch,
      summary,
      options,
      options.serviceSecret,
    );

    for (const handle of handleBatch) {
      state.currentHandle = handle;
      state.currentPostIndex = 0;
      state.currentHandlePosts = [];
      state.currentScrapedPostCursor = null;
      state.currentScrapedPostIds = [];
      state.currentScrapedPostIdIndex = 0;
      state.currentScrapedPostPageDone = false;

      const posts = postsByHandle[handle];
      if (posts) {
        const seenSourceKeys = state.seenSourceKeysByHandle[handle] ?? [];
        state.seenSourceKeysByHandle[handle] = seenSourceKeys;

        await processLoadedPostsForHandle({
          client: options.client,
          handle,
          posts,
          summary: getOrCreateHandleSummary(summary, handle),
          seenSourceKeys,
          serviceSecret: options.serviceSecret,
          canonicalVenueNamesByHandle: options.canonicalVenueNamesByHandle,
          venueNameOverridesByHandle: options.venueNameOverridesByHandle,
          configuredVenueNamesByHandle: options.configuredVenueNamesByHandle,
        });
      }

      state.handleIndex += 1;
    }
  }

  const done = state.handleIndex >= options.handles.length;
  if (done) {
    state.currentHandle = null;
    state.currentPostIndex = 0;
    state.currentHandlePosts = [];
    state.currentScrapedPostCursor = null;
    state.currentScrapedPostIds = [];
    state.currentScrapedPostIdIndex = 0;
    state.currentScrapedPostPageDone = false;
    await runApprovedDuplicateCleanupForIngestion(options.client, summary, {
      mode: "full_scrape",
      handles: options.handles,
      serviceSecret: options.serviceSecret,
    });
  }
  summary.finishedAt = new Date().toISOString();

  return {
    summary,
    state,
    done,
  };
}

export async function runInstagramIngestionBatchStep(
  options: IngestionBatchStepOptions,
): Promise<IngestionBatchStepResult> {
  const client = getConvexClient();
  const serviceSecret = getConfiguredServiceSecret(options.serviceSecret);
  const {
    canonicalVenueNamesByHandle,
    venueNameOverridesByHandle,
    configuredVenueNamesByHandle,
  } = await loadIngestionVenueContext(client, serviceSecret);
  const batchSize = normalizeBatchSize(options.batchSize);
  const mode = options.mode ?? "full_scrape";
  const summary = options.summary;
  const state = options.state;
  const postStepLimit = normalizeIngestionPostStepLimit(options.postStepLimit);
  const scrapedPostPageSize = normalizeScrapedPostPageSize(options.scrapedPostPageSize);

  if (mode === "full_scrape") {
    return runInstagramIngestionFullScrapeBatchStep({
      ...options,
      client,
      canonicalVenueNamesByHandle,
      venueNameOverridesByHandle,
      configuredVenueNamesByHandle,
      batchSize,
      mode,
      serviceSecret,
    });
  }

  let processedPosts = 0;

  while (processedPosts < postStepLimit && state.handleIndex < options.handles.length) {
    const handle = options.handles[state.handleIndex];
    const handleSummary = getOrCreateHandleSummary(summary, handle);

    if (state.currentHandle !== handle) {
      state.currentHandle = handle;
      state.currentPostIndex = 0;
      state.currentHandlePosts = [];
      state.currentScrapedPostCursor = null;
      state.currentScrapedPostIds = [];
      state.currentScrapedPostIdIndex = 0;
      state.currentScrapedPostPageDone = false;
    }

    const currentIds = state.currentScrapedPostIds ?? [];
    const currentIdIndex = state.currentScrapedPostIdIndex ?? 0;
    if (currentIds.length === 0 || currentIdIndex >= currentIds.length) {
      if (state.currentScrapedPostPageDone) {
        state.handleIndex += 1;
        state.currentHandle = null;
        state.currentPostIndex = 0;
        state.currentHandlePosts = [];
        state.currentScrapedPostCursor = null;
        state.currentScrapedPostIds = [];
        state.currentScrapedPostIdIndex = 0;
        state.currentScrapedPostPageDone = false;
        continue;
      }

      try {
        const page = await loadSavedScrapedPostPageForHandle({
          client,
          handle,
          cursor: state.currentScrapedPostCursor ?? null,
          pageSize: scrapedPostPageSize,
          daysBack: options.daysBack,
          alreadyAcceptedCount: state.currentPostIndex,
          resultsLimit: options.resultsLimit,
          serviceSecret,
        });

        handleSummary.fetchedPosts = page.acceptedCount;
        handleSummary.fetched_posts = page.acceptedCount;
        state.currentPostIndex = page.acceptedCount;
        state.currentHandlePosts = [];
        state.currentScrapedPostCursor = page.continueCursor;
        state.currentScrapedPostIds = page.candidateIds;
        state.currentScrapedPostIdIndex = 0;
        state.currentScrapedPostPageDone = page.shouldCompleteHandle;

        if (page.candidateIds.length === 0) {
          if (page.shouldCompleteHandle) {
            state.handleIndex += 1;
            state.currentHandle = null;
            state.currentPostIndex = 0;
            state.currentHandlePosts = [];
            state.currentScrapedPostCursor = null;
            state.currentScrapedPostIds = [];
            state.currentScrapedPostIdIndex = 0;
            state.currentScrapedPostPageDone = false;
          }
          continue;
        }
      } catch (error) {
        handleSummary.errors.push(
          getErrorMessage(error),
        );
        logError("ingestion.scrape.failed", {
          step: "fetch_posts" satisfies IngestionStep,
          handle,
          sourcePostId: null,
          shortcode: null,
          instagramUrl: null,
          error: getErrorMessage(error),
        });
        state.handleIndex += 1;
        state.currentHandle = null;
        state.currentPostIndex = 0;
        state.currentHandlePosts = [];
        state.currentScrapedPostCursor = null;
        state.currentScrapedPostIds = [];
        state.currentScrapedPostIdIndex = 0;
        state.currentScrapedPostPageDone = false;
        continue;
      }
    }

    const ids = state.currentScrapedPostIds ?? [];
    const remainingCapacity = postStepLimit - processedPosts;
    const idsStartIndex = state.currentScrapedPostIdIndex ?? 0;
    const idsToLoad = ids.slice(
      idsStartIndex,
      idsStartIndex + remainingCapacity,
    );
    const posts = await loadScrapedPostsByIds(client, idsToLoad, serviceSecret);
    state.currentScrapedPostIdIndex = idsStartIndex + idsToLoad.length;

    for (const rawPost of posts) {
      let post = rawPost;
      processedPosts += 1;

      try {
        post = normalizeScrapedPost(post);
      } catch (error) {
        handleSummary.errors.push(getErrorMessage(error));
        logError("ingestion.post.normalize.failed", {
          step: "normalize_posts" satisfies IngestionStep,
          ...getPostContext(handle, post),
          error: getErrorMessage(error),
        });
        continue;
      }

      const sourceKey = getSourceIdentityKey(post);
      if (sourceKey) {
        const seenForHandle = state.seenSourceKeysByHandle[handle] ?? [];
        if (seenForHandle.includes(sourceKey)) {
          continue;
        }
        seenForHandle.push(sourceKey);
        state.seenSourceKeysByHandle[handle] = seenForHandle;
      }

      await processIngestionPost({
        client,
        handle,
        post,
        summary: handleSummary,
        canonicalVenueNamesByHandle,
        venueNameOverridesByHandle,
        configuredVenueNamesByHandle,
        serviceSecret,
      });
    }

    if ((state.currentScrapedPostIdIndex ?? 0) >= ids.length) {
      state.currentScrapedPostIds = [];
      state.currentScrapedPostIdIndex = 0;
      if (state.currentScrapedPostPageDone) {
        state.handleIndex += 1;
        state.currentHandle = null;
        state.currentPostIndex = 0;
        state.currentHandlePosts = [];
        state.currentScrapedPostCursor = null;
        state.currentScrapedPostIds = [];
        state.currentScrapedPostIdIndex = 0;
        state.currentScrapedPostPageDone = false;
      }
    }
  }

  const done = state.handleIndex >= options.handles.length;
  if (done) {
    state.currentHandle = null;
    state.currentPostIndex = 0;
    state.currentHandlePosts = [];
    state.currentScrapedPostCursor = null;
    state.currentScrapedPostIds = [];
    state.currentScrapedPostIdIndex = 0;
    state.currentScrapedPostPageDone = false;
    await runApprovedDuplicateCleanupForIngestion(client, summary, {
      mode,
      handles: options.handles,
      serviceSecret,
    });
  }
  summary.finishedAt = new Date().toISOString();

  return {
    summary,
    state,
    done,
  };
}

export async function getActiveVenueHandles(options?: {
  serviceSecret?: string;
}): Promise<string[]> {
  const client = getConvexClient();
  const serviceSecret = getConfiguredServiceSecret(options?.serviceSecret);
  const venues = (await client.query(
    listActiveVenuesQuery,
    withServiceSecret({}, serviceSecret),
  )) as ActiveVenueRecord[];
  const uniqueHandles = new Set<string>();

  for (const venue of venues) {
    const normalizedHandle = normalizeHandle(venue.instagramHandle);
    if (normalizedHandle.length > 0) {
      uniqueHandles.add(normalizedHandle);
    }
  }

  return [...uniqueHandles];
}

export async function importRecentApifyRunPostsToSavedPosts(options: {
  handles: string[];
  runsLimit?: number;
  serviceSecret?: string;
}): Promise<RecentApifyImportSummary> {
  const normalizedHandles = [...new Set(options.handles.map((handle) => normalizeHandle(handle)).filter(Boolean))];
  if (normalizedHandles.length === 0) {
    return {
      handles: [],
      runsScanned: 0,
      importedPosts: 0,
      handlesWithImportedPosts: 0,
    };
  }

  const client = getConvexClient();
  const serviceSecret = getConfiguredServiceSecret(options.serviceSecret);
  const importResult = await loadRecentApifyRunPosts({
    handles: normalizedHandles,
    runsLimit: options.runsLimit,
  });

  let handlesWithImportedPosts = 0;
  for (const handle of normalizedHandles) {
    const posts = importResult.importedPostsByHandle[handle] ?? [];
    if (posts.length === 0) {
      continue;
    }

    handlesWithImportedPosts += 1;
    await persistScrapedPostsForHandle(client, handle, posts, serviceSecret);
  }

  return {
    handles: normalizedHandles,
    runsScanned: importResult.runsScanned,
    importedPosts: importResult.importedPosts,
    handlesWithImportedPosts,
  };
}

export async function importUpcomingEventsToSavedPosts(options?: {
  serviceSecret?: string;
}): Promise<ExistingEventImportSummary> {
  const client = getConvexClient();
  const serviceSecret = getConfiguredServiceSecret(options?.serviceSecret);
  const venues = (await client.query(
    listVenuesQuery,
    withServiceSecret({}, serviceSecret),
  )) as VenueRecord[];
  const canonicalVenueNamesByHandle = buildCanonicalVenueNamesByHandle(venues);
  const handlesByVenueName = buildVenueHandleByCanonicalVenueName(
    canonicalVenueNamesByHandle,
  );
  const todayIsoDate = getIsoDateInTimeZone(getConfiguredEventTimezone());

  const [approvedEvents, pendingEvents] = await Promise.all([
    client.query(listByStatusQuery, {
      status: "approved",
      limit: EXISTING_EVENT_IMPORT_LIMIT_PER_STATUS,
      serviceSecret,
    }) as Promise<EventImportRecord[]>,
    client.query(listByStatusQuery, {
      status: "pending",
      limit: EXISTING_EVENT_IMPORT_LIMIT_PER_STATUS,
      serviceSecret,
    }) as Promise<EventImportRecord[]>,
  ]);

  const postsByHandle = new Map<string, Map<string, InstagramScrapedPost>>();
  let skippedPastEvents = 0;
  let skippedMissingVenue = 0;
  let skippedMissingSource = 0;

  for (const event of [...approvedEvents, ...pendingEvents]) {
    if (normalizeString(event.date) < todayIsoDate) {
      skippedPastEvents += 1;
      continue;
    }

    const venue = normalizeString(event.venue);
    if (!venue) {
      skippedMissingVenue += 1;
      continue;
    }

    const matchedHandle = resolveImportedEventHandle(
      venue,
      event._id,
      canonicalVenueNamesByHandle,
      handlesByVenueName,
    );
    const post = mapImportedEventToSavedScrapedPost(event, matchedHandle);
    if (!post) {
      skippedMissingSource += 1;
      continue;
    }

    const sourceIdentityKey = getSourceIdentityKey(post);
    if (!sourceIdentityKey) {
      skippedMissingSource += 1;
      continue;
    }

    const postsForHandle = postsByHandle.get(matchedHandle) ?? new Map<string, InstagramScrapedPost>();
    const existingPost = postsForHandle.get(sourceIdentityKey);
    if (
      !existingPost ||
      scoreSavedScrapedPostCandidate(post) > scoreSavedScrapedPostCandidate(existingPost)
    ) {
      postsForHandle.set(sourceIdentityKey, post);
    }
    postsByHandle.set(matchedHandle, postsForHandle);
  }

  let importedPosts = 0;
  const importedHandles: string[] = [];

  for (const [handle, postsForHandle] of postsByHandle.entries()) {
    const posts = [...postsForHandle.values()];
    if (posts.length === 0) {
      continue;
    }

    await persistScrapedPostsForHandle(client, handle, posts, serviceSecret);
    importedHandles.push(handle);
    importedPosts += posts.length;
  }

  return {
    handles: importedHandles,
    importedPosts,
    handlesWithImportedPosts: importedHandles.length,
    scannedEvents: approvedEvents.length + pendingEvents.length,
    skippedPastEvents,
    skippedMissingVenue,
    skippedMissingSource,
  };
}

async function fetchFreshPostsForHandlesInParallel(
  client: ConvexHttpClient,
  handles: string[],
  summary: IngestionSummary,
  options: Pick<RunInstagramIngestionOptions, "resultsLimit" | "daysBack">,
  serviceSecret: string,
): Promise<Record<string, InstagramScrapedPost[]>> {
  const postsByHandle: Record<string, InstagramScrapedPost[]> = {};
  let nextHandleIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextHandleIndex < handles.length) {
      const handle = handles[nextHandleIndex];
      nextHandleIndex += 1;

      try {
        const posts = await scrapeInstagramAccount({
          handle,
          resultsLimit: options.resultsLimit,
          daysBack: options.daysBack,
        });

        try {
          await persistScrapedPostsForHandle(client, handle, posts, serviceSecret);
        } catch (persistError) {
          logError("ingestion.scrape.persist_failed", {
            step: "fetch_posts" satisfies IngestionStep,
            handle,
            sourcePostId: null,
            shortcode: null,
            instagramUrl: null,
            error: getErrorMessage(persistError),
          });
        }

        const handleSummary = getOrCreateHandleSummary(summary, handle);
        handleSummary.fetchedPosts = posts.length;
        handleSummary.fetched_posts = posts.length;
        postsByHandle[handle] = posts;
      } catch (error) {
        const message = getErrorMessage(error);
        const handleSummary = getOrCreateHandleSummary(summary, handle);
        handleSummary.errors.push(message);
        logError("ingestion.scrape.failed", {
          step: "fetch_posts" satisfies IngestionStep,
          handle,
          sourcePostId: null,
          shortcode: null,
          instagramUrl: null,
          error: message,
        });
      }
    }
  }

  const workerCount = Math.min(normalizeDirectFullScrapeConcurrency(), handles.length);
  await Promise.all(
    Array.from({ length: workerCount }, () => runWorker()),
  );

  return postsByHandle;
}

async function runInstagramIngestionWithConcurrentFullScrape(
  options: RunInstagramIngestionOptions,
  summary: IngestionSummary,
): Promise<IngestionSummary> {
  const client = getConvexClient();
  const serviceSecret = getConfiguredServiceSecret(options.serviceSecret);
  const venueContext = await loadIngestionVenueContext(client, serviceSecret);
  const postsByHandle = await fetchFreshPostsForHandlesInParallel(
    client,
    options.handles,
    summary,
    options,
    serviceSecret,
  );
  const seenSourceKeysByHandle: Record<string, string[]> = {};

  for (const handle of options.handles) {
    const posts = postsByHandle[handle];
    if (!posts) {
      continue;
    }

    const seenSourceKeys = seenSourceKeysByHandle[handle] ?? [];
    seenSourceKeysByHandle[handle] = seenSourceKeys;

    await processLoadedPostsForHandle({
      client,
      handle,
      posts,
      summary: getOrCreateHandleSummary(summary, handle),
      seenSourceKeys,
      serviceSecret,
      ...venueContext,
    });
  }

  await runApprovedDuplicateCleanupForIngestion(client, summary, {
    mode: "full_scrape",
    handles: options.handles,
    serviceSecret,
  });
  summary.finishedAt = new Date().toISOString();
  return summary;
}

export async function runActiveVenueIngestion(options?: {
  resultsLimit?: number;
  daysBack?: number;
  mode?: IngestionRunMode;
  serviceSecret?: string;
}): Promise<ActiveVenueIngestionResult> {
  const serviceSecret = getConfiguredServiceSecret(options?.serviceSecret);
  const venueHandles = await getActiveVenueHandles({ serviceSecret });
  if (venueHandles.length === 0) {
    return {
      venueHandles: [],
      summary: {
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        handles: [],
      },
    };
  }

  const summary = await runInstagramIngestion({
    handles: venueHandles,
    resultsLimit: options?.resultsLimit,
    daysBack: options?.daysBack,
    mode: options?.mode,
    serviceSecret,
  });

  return { venueHandles, summary };
}

export async function runInstagramIngestion(
  options: RunInstagramIngestionOptions,
): Promise<IngestionSummary> {
  const summary = createEmptyIngestionSummary(options.handles);
  const serviceSecret = getConfiguredServiceSecret(options.serviceSecret);

  if ((options.mode ?? "full_scrape") === "full_scrape") {
    return runInstagramIngestionWithConcurrentFullScrape(
      { ...options, serviceSecret },
      summary,
    );
  }

  const state = createInitialIngestionBatchState();
  let done = false;

  while (!done) {
    const batchResult = await runInstagramIngestionBatchStep({
      handles: options.handles,
      summary,
      state,
      resultsLimit: options.resultsLimit,
      daysBack: options.daysBack,
      batchSize: 10,
      mode: options.mode,
      serviceSecret,
    });
    done = batchResult.done;
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}
