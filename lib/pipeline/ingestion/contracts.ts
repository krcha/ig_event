import { type ExtractedEventData, extractEventDataFromInstagramPost } from "@/lib/ai/extract-event-data";
import { downloadImage, normalizeToJpeg } from "@/lib/ai/prepare-image-for-openai";
import { type IngestionVenueResolverSnapshotInput } from "@/lib/domain/venues/index";
import { type ApprovedEventAutoMergeSummary } from "@/lib/events/approved-event-automerge";
import { type EventTimeProvenance, type EventTimeSource } from "@/lib/events/event-time";
import { type EventConsistencyIssue } from "@/lib/events/event-validation";
import { type NightlifeLineupCoalescingPlan, type NightlifeLineupSource } from "@/lib/events/nightlife-lineup-coalescing";
import { type CanonicalVenueAliasesByHandle } from "@/lib/pipeline/venue-normalization";
import { type InstagramScrapedPost } from "@/lib/scraper/instagram-scraper";
import { ConvexHttpClient } from "convex/browser";

export type RunInstagramIngestionOptions = {
  handles: string[];
  resultsLimit?: number;
  daysBack?: number;
  noAgeCutoff?: boolean;
  skipPinnedPosts?: boolean;
  ignoreCheckpoint?: boolean;
  ignoreCooldown?: boolean;
  mode?: IngestionRunMode;
  serviceSecret?: string;
};

export type IngestionRunMode = "full_scrape" | "saved_posts";

export type HandleSummary = {
  handle: string;
  fetchedPosts: number;
  fetched_posts: number;
  newFetchedPosts: number;
  skippedAlreadyFetchedPosts: number;
  apifyHighWatermarkApplied: number;
  fetchContinuations?: number;
  fetchHardBlocked?: number;
  freshFetchAttempted?: number;
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
  persistedImages: number;
  failedImagePersistence: number;
  failedDownloads: number;
  failed_downloads: number;
  failedConversions: number;
  failed_conversions: number;
  failedExtractions: number;
  failed_extractions: number;
  failed_extraction: number;
  permanentMediaDownloadFailures?: number;
  permanentImagePersistenceFailures?: number;
  terminalPermanentExtractionFailures?: number;
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
  hostRunCursor?: string;
  hostRunCompletedThrough?: number;
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
  noAgeCutoff?: boolean;
  skipPinnedPosts?: boolean;
  ignoreCheckpoint?: boolean;
  ignoreCooldown?: boolean;
  batchSize?: number;
  mode?: IngestionRunMode;
  postStepLimit?: number;
  scrapedPostPageSize?: number;
  serviceSecret?: string;
  workOwner?: string;
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

export type IngestionVenueContext = {
  canonicalVenueNamesByHandle: Record<string, string>;
  canonicalVenueAliasesByHandle: CanonicalVenueAliasesByHandle;
  canonicalVenueLocationsByHandle: Record<string, string>;
  venueResolverSnapshot: IngestionVenueResolverSnapshotInput;
  venueNameOverridesByHandle: Record<string, string>;
  configuredVenueNamesByHandle: Record<string, string>;
  sourceDisplayNamesByHandle: Record<string, string>;
  sourceRolesByHandle: Record<string, "venue" | "promoter" | "unknown">;
};


export type HandlePage = {
  page: string[];
  isDone: boolean;
  continueCursor: string;
};


export type InstagramIngestionSourceContext = {
  handle: string;
  role: "venue" | "promoter" | "unknown";
  canonicalVenueName?: string;
  canonicalVenueAliases?: string[];
  observedDisplayName?: string;
  observedDisplayNameUpdatedAt?: number;
};

export type EventStatus = "pending" | "approved" | "rejected";


export type EventDateEvidenceSource = "caption" | "poster" | "alt_text" | "unknown";


export type EventTimeEvidenceKind =
  | "start_time_stated"
  | "not_stated"
  | "unreadable"
  | "doors_open_only";

export type PreparedEvent = {
  title: string;
  date: string;
  time?: string;
  timeSource: EventTimeSource;
  timeEvidenceText?: string;
  timeConfidence: number;
  timeStatus: EventTimeProvenance["status"];
  timeEvidenceKind?: EventTimeEvidenceKind;
  dateEvidenceText?: string;
  dateEvidenceSource?: EventDateEvidenceSource;
  dateEvidenceIsRelative?: boolean;
  dateEvidenceResolvedDate?: string;
  sourceConflictFields?: string[];
  venue: string;
  artists: string[];
  description?: string;
  imageUrl?: string;
  imageStorageId?: string;
  instagramPostUrl: string;
  instagramPostId: string;
  ticketPrice?: string;
  eventType: string;
  sourceCaption?: string;
  sourcePostedAt?: string;
  rawExtractionJson?: string;
  normalizedFieldsJson?: string;
  sourceOccurrenceKey?: string;
  status: EventStatus;
};

export type DateSource = "model" | "caption";


export type DateConfidence = "high" | "medium" | "low";

export type DateCandidate = {
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

export type DateNormalization = {
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

export type SplitEventCandidateSource = "caption_schedule" | "poster_schedule" | "alt_text_schedule";

export type SplitEventCandidate = {
  rawDate: string;
  normalizedDate: DateNormalization;
  lineTitle: string;
  artists: string[];
  artistsWereSanitized?: boolean;
  time?: string;
  rawTime?: string;
  venue?: string;
  dateEvidence?: ExtractedEventData["date_evidence"];
  timeEvidence?: ExtractedEventData["time_evidence"];
  consistencyIssues: EventConsistencyIssue[];
  description?: string;
  sourceLine: string;
  source: SplitEventCandidateSource;
  occurrencePlanUnverified?: boolean;
  titleSource?: SplitEventCandidateSource | "unnamed_schedule_fallback";
  titleUsedFallback?: boolean;
};

export type EventVariant = {
  title: string;
  titleSource: string;
  titleUsedFallback: boolean;
  titleDerivedFromContext: boolean;
  titleContextCandidate: string | null;
  rawDate: string;
  dateNormalization: DateNormalization;
  dateEvidence: ExtractedEventData["date_evidence"];
  time: string;
  rawTime: string;
  timeEvidence: ExtractedEventData["time_evidence"];
  timeProvenance: EventTimeProvenance;
  consistencyIssues: EventConsistencyIssue[];
  artists: string[];
  artistsWereSanitized: boolean;
  description?: string;
  venue: string;
  venueEvidenceValue: string;
  canonicalVenueEvidenceSource: "evidence_handle" | "evidence_name" | null;
  canonicalVenueEvidenceHandle: string | null;
  splitSource: SplitEventCandidateSource | null;
  splitSourceLine: string | null;
  occurrencePlanUnverified: boolean;
  lineupScheduleCoalesced?: boolean;
  lineupScheduleTimingMode?: NightlifeLineupCoalescingPlan["timingMode"];
  lineupSourceEvidence?: Array<{
    text: string;
    source: NightlifeLineupSource;
  }>;
  lineupSlots?: Array<{
    title: string;
    time: string;
    artists: string[];
    sourceText: string;
    source: NightlifeLineupSource;
  }>;
};

export type PrepareEventResult =
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
        | "not_event"
        | "invalid_event"
        | "past_event"
        | "far_future";
      normalizedFields: Record<string, unknown>;
    };

export type SourceProcessingFence = {
  handle: string;
  scrapedPostId?: string;
  postId?: string;
  instagramPostUrl?: string;
  owner: string;
  sourceRevision: number;
};

export type ExistingEventRecord = {
  _id: string;
  title: string;
  date: string;
  time?: string;
  timeSource?: EventTimeSource;
  timeEvidenceText?: string;
  timeConfidence?: number;
  timeStatus?: EventTimeProvenance["status"];
  timeEvidenceKind?: EventTimeEvidenceKind;
  dateEvidenceText?: string;
  dateEvidenceSource?: EventDateEvidenceSource;
  dateEvidenceIsRelative?: boolean;
  dateEvidenceResolvedDate?: string;
  sourceConflictFields?: string[];
  venue: string;
  artists: string[];
  description?: string;
  imageUrl?: string;
  imageStorageId?: string;
  instagramPostUrl?: string;
  instagramPostId?: string;
  ticketPrice?: string;
  eventType: string;
  sourceCaption?: string;
  sourcePostedAt?: string;
  rawExtractionJson?: string;
  normalizedFieldsJson?: string;
  sourceOccurrenceKey?: string;
  status: EventStatus;
  reviewedAt?: number;
  reviewedBy?: string;
  moderationNote?: string;
  updatedAt: number;
};

export type ExistingSourceMatch = {
  existingEvent: ExistingEventRecord;
  matchedBy: "post_id" | "shortcode" | "post_url" | "same_date_semantic";
  matchedValue: string;
};

export type DuplicateQualityReason =
  | "wrong_year"
  | "bad_venue"
  | "low_confidence"
  | "invalid_required_fields"
  | "invalid_normalized_fields";

export type ExistingEventQuality = {
  isLowQuality: boolean;
  primaryReason: DuplicateQualityReason | null;
  reasons: DuplicateQualityReason[];
  details: Record<string, unknown>;
};

export type DuplicateUpdateLogEvent =
  | "duplicate_updated_wrong_year"
  | "duplicate_updated_bad_venue"
  | "duplicate_updated_low_confidence"
  | "duplicate_updated_bad_data";

export type IngestionStep =
  | "fetch_posts"
  | "normalize_posts"
  | "duplicate_lookup"
  | "extract_event"
  | "update_existing_event"
  | "insert_new_event";

export type IngestionPostContext = {
  handle: string;
  sourcePostId: string | null;
  shortcode: string | null;
  instagramUrl: string;
};

export type RelativeWeekdayQualifier = "this" | "next" | "bare_list";

export type RelativeWeekdayMatch = {
  raw: string;
  weekday: number;
  qualifier: RelativeWeekdayQualifier;
};

export type RelativeDayOffsetMatch = {
  raw: string;
  offsetDays: number;
};

export type EventImportRecord = {
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

export type SavedScrapedPostRecord = {
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
  processingStatus?: "pending" | "processing" | "completed" | "retryable_failure";
  processingAttempts?: number;
  processingOutcome?: string;
  processingError?: string;
  processingRetryAt?: number;
  processingLeaseOwner?: string;
  processingLeaseExpiresAt?: number;
  sourceRevision?: number;
  lastProcessedAt?: number;
  createdAt: number;
  updatedAt: number;
};

export type ScrapedPostsPage = {
  page: SavedScrapedPostRecord[];
  isDone: boolean;
  continueCursor: string;
};

export type CoreEventSourceGrounding = {
  titleVerified: boolean;
  dateVerified: boolean;
  identityVerified: boolean;
  identityContextVerified: boolean;
  timeVerified: boolean | null;
  artistsVerified: boolean | null;
  rowVerified: boolean;
  verified: boolean;
  blockers: string[];
};

export type RecurringModelScheduleContext = {
  startIsoDate: string;
  endIsoDate: string;
  weekdaysByEntry: number[];
  sourceGroundingVerified: boolean;
  sourcePlanCoverageRejected: boolean;
};

export type RecurringScheduleLane = {
  weekday: number;
  time: string;
};

export type RepeatedAnnouncementContextKind = "relocation" | "scheduled_held";

export type RepeatedSingleEventCaptionDisposition = "collapse" | "preserve" | "none";

export type SourceOccurrenceReceiptState = "absent" | "complete" | "incomplete";

export type SavedPostCompletionClassificationInput = {
  hasTerminalPermanentFailure: boolean;
  hasProcessingFailure: boolean;
  receiptInspectionFailed: boolean;
  receiptState: SourceOccurrenceReceiptState;
  eventActivityCountBefore: number;
  eventActivityCountAfter: number;
  terminalNoEventSkipCountBefore: number;
  terminalNoEventSkipCountAfter: number;
};

export type EventTimeEvidenceSource =
  | "caption"
  | "description"
  | "extracted_time"
  | "post_alt_text"
  | "source_caption";

export type EventTimeEvidence = {
  source: EventTimeEvidenceSource;
  text: string;
  time: string;
};

export type SourceDuplicateSkipDecision = {
  match: ExistingSourceMatch;
  quality: ExistingEventQuality;
  reason: "already_processed_source" | "clean_existing_source";
};

export type ProviderExecutionControl = {
  claim: () => Promise<{
    claimed: boolean;
    reason?:
      | "claimed"
      | "half_open"
      | "busy"
      | "provider_blocked"
      | "budget_exhausted"
      | "invalid";
    blockedStatus?: number;
    blockedCode?: string;
  }>;
  block: (status: number, code?: string) => Promise<void>;
  release: () => Promise<void>;
};

export type ProcessIngestionPostOptions = {
  client: ConvexHttpClient;
  handle: string;
  post: InstagramScrapedPost;
  summary: HandleSummary;
  canonicalVenueNamesByHandle: Record<string, string>;
  canonicalVenueAliasesByHandle?: CanonicalVenueAliasesByHandle;
  canonicalVenueLocationsByHandle?: Record<string, string>;
  venueResolverSnapshot?: IngestionVenueResolverSnapshotInput;
  venueNameOverridesByHandle: Record<string, string>;
  configuredVenueNamesByHandle: Record<string, string>;
  sourceDisplayNamesByHandle?: Record<string, string>;
  sourceRolesByHandle?: Record<string, "venue" | "promoter" | "unknown">;
  serviceSecret: string;
  processingFence: SourceProcessingFence;
  cachedAnalysisJson?: string;
  cachedAnalysisContractVersion?: string;
  cachedAnalysisImageSourceUrl?: string;
  cachedAnalysisImageChecksumSha256?: string;
  providerExecution?: ProviderExecutionControl;
  onOpenAiTransportStarted?: () => void;
  eventDateFilterNow?: Date;
};

export type ProcessIngestionPostDependencies = {
  downloadImage: typeof downloadImage;
  extractEventDataFromPost: typeof extractEventDataFromInstagramPost;
  normalizeToJpeg: typeof normalizeToJpeg;
};

export type ProcessLoadedPostsForHandleOptions = {
  client: ConvexHttpClient;
  handle: string;
  posts: InstagramScrapedPost[];
  summary: HandleSummary;
  seenSourceKeys: string[];
  serviceSecret: string;
  workOwner: string;
  scrapedPostId?: string;
  expectedSourceRevision?: number;
  onOpenAiTransportStarted?: () => void;
} & IngestionVenueContext;

export type DurableSavedPostProcessingResult =
  | { state: "terminal"; outcome: string; transportAttempted: boolean }
  | { state: "pending"; reason: string; retryAfterMs: number; transportAttempted: boolean }
  | { state: "blocked"; reason: string; transportAttempted: boolean };

export type PaidFetchLeaseResult = {
  claimed?: boolean;
  reason?: string;
  onlyPostsNewerThan?: string | null;
  resultsLimit?: number;
  expiresAt?: number;
};
