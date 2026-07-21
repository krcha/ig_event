import type { IngestionSummary } from "@/lib/pipeline/run-instagram-ingestion";

type HandleSummary = IngestionSummary["handles"][number];

export type IngestionTriageTone = "neutral" | "running" | "success" | "warning" | "danger";

export type IngestionIssueGroup = {
  category: string;
  provider?: "openai" | "apify";
  handle?: string;
  count: number;
  message: string;
};

export type OperationsTriageSummary = {
  tone: IngestionTriageTone;
  title: string;
  description: string;
  totals: {
    fetchedPosts: number;
    insertedEvents: number;
    insertedApprovedEvents: number;
    insertedPendingEvents: number;
    skippedDuplicates: number;
    skippedMissingDate: number;
    skippedMissingVenue: number;
    skippedInvalidEvents: number;
    skippedPastEvents: number;
    skippedFarFutureEvents: number;
    failedDownloads: number;
    failedConversions: number;
    failedExtractions: number;
    failedImagePersistence: number;
    handlesWithErrors: number;
  };
  providerStatus: {
    openai: "ok" | "warning" | "blocked" | "unknown";
    apify: "ok" | "warning" | "blocked" | "unknown";
  };
  handleSelection: {
    activeVenueCount: number | null;
    selectedHandleCount: number;
    skippedRecentlyAttempted: number;
    skippedDueToRunLimit: number;
    fullScrapeCooldownHours: number | null;
  };
  issueGroups: IngestionIssueGroup[];
};

type BuildOperationsTriageOptions = {
  summary: IngestionSummary | null | undefined;
  status?: "queued" | "running" | "completed" | "failed" | null;
  handles?: string[];
  recentSummaries?: IngestionSummary[];
};

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function countFirst(...values: unknown[]): number {
  for (const value of values) {
    const normalized = count(value);
    if (normalized > 0) {
      return normalized;
    }
  }
  return 0;
}

function sum(summary: IngestionSummary, getValue: (handle: HandleSummary) => number): number {
  return summary.handles.reduce((total, handle) => total + getValue(handle), 0);
}

function classifyIngestionError(error: string): {
  category: string;
  provider?: "openai" | "apify";
  blocked: boolean;
} {
  const normalized = error.toLowerCase();

  if (
    /apify|actor|instagram scraper|monthly usage|monthly limit|402|max_total_charge|max total charge/u.test(
      normalized,
    )
  ) {
    return {
      category: /quota|monthly|402|charge/u.test(normalized)
        ? "apify_quota"
        : "apify_error",
      provider: "apify",
      blocked: /quota|monthly|402|charge/u.test(normalized),
    };
  }

  if (/openai|responses|insufficient_quota|rate limit|429|model/u.test(normalized)) {
    return {
      category: /insufficient_quota|quota|429|rate limit/u.test(normalized)
        ? "openai_quota"
        : "openai_error",
      provider: "openai",
      blocked: /insufficient_quota|quota|429|rate limit/u.test(normalized),
    };
  }

  if (/quota/u.test(normalized)) {
    return {
      category: "openai_quota",
      provider: "openai",
      blocked: true,
    };
  }

  return { category: "ingestion_error", blocked: false };
}

function addIssue(
  issues: Map<string, IngestionIssueGroup>,
  issue: IngestionIssueGroup,
) {
  const key = [issue.category, issue.provider ?? "internal", issue.handle ?? "all"].join(":");
  const existing = issues.get(key);
  if (existing) {
    existing.count += issue.count;
    return;
  }
  issues.set(key, { ...issue });
}

function addCountIssue(
  issues: Map<string, IngestionIssueGroup>,
  handle: string,
  category: string,
  countValue: number,
  message: string,
) {
  if (countValue <= 0) {
    return;
  }
  addIssue(issues, {
    category,
    handle,
    count: countValue,
    message,
  });
}

function collectIssueGroups(
  summary: IngestionSummary,
  recentSummaries: IngestionSummary[],
): IngestionIssueGroup[] {
  const issues = new Map<string, IngestionIssueGroup>();

  for (const handle of summary.handles) {
    for (const error of handle.errors) {
      const classified = classifyIngestionError(error);
      addIssue(issues, {
        category: classified.category,
        ...(classified.provider ? { provider: classified.provider } : {}),
        handle: handle.handle,
        count: 1,
        message: error,
      });
    }

    addCountIssue(
      issues,
      handle.handle,
      "missing_date",
      count(handle.skipped_missing_date),
      "Posts were skipped because no reliable event date was found.",
    );
    addCountIssue(
      issues,
      handle.handle,
      "missing_venue",
      count(handle.skipped_missing_venue),
      "Posts were skipped because no reliable venue was found.",
    );
    addCountIssue(
      issues,
      handle.handle,
      "invalid_event",
      count(handle.skipped_invalid_event),
      "Posts were skipped because required event fields were not usable.",
    );
    addCountIssue(
      issues,
      handle.handle,
      "past_event",
      count(handle.skipped_past_event),
      "Posts were skipped because the normalized event date was in the past.",
    );
    addCountIssue(
      issues,
      handle.handle,
      "far_future_event",
      count(handle.skipped_far_future_event),
      "Posts were skipped because the normalized event date was too far ahead.",
    );
    addCountIssue(
      issues,
      handle.handle,
      "image_persistence",
      count(handle.failedImagePersistence),
      "Events were written, but their durable poster image could not be persisted.",
    );
  }

  const recurringKeys = new Map<string, number>();
  for (const recentSummary of recentSummaries) {
    for (const handle of recentSummary.handles) {
      const handleIssues = [
        ["missing_date", count(handle.skipped_missing_date)] as const,
        ["missing_venue", count(handle.skipped_missing_venue)] as const,
        ["invalid_event", count(handle.skipped_invalid_event)] as const,
        [
          "failed_extraction",
          countFirst(handle.failedExtractions, handle.failed_extractions, handle.failed_extraction),
        ] as const,
        ["image_persistence", count(handle.failedImagePersistence)] as const,
      ];
      for (const [category, issueCount] of handleIssues) {
        if (issueCount > 0) {
          const key = `${handle.handle}:${category}`;
          recurringKeys.set(key, (recurringKeys.get(key) ?? 0) + 1);
        }
      }
    }
  }

  for (const [key, repeatCount] of recurringKeys) {
    if (repeatCount < 2) {
      continue;
    }
    const [handle, category] = key.split(":");
    addIssue(issues, {
      category: "recurring_issue",
      handle,
      count: repeatCount,
      message: `Recurring ${category} issue across recent ingestion summaries.`,
    });
  }

  return [...issues.values()]
    .sort((left, right) => right.count - left.count || left.category.localeCompare(right.category))
    .slice(0, 8);
}

function getProviderStatus(
  issueGroups: IngestionIssueGroup[],
  provider: "openai" | "apify",
): "ok" | "warning" | "blocked" | "unknown" {
  const providerIssues = issueGroups.filter((issue) => issue.provider === provider);
  if (providerIssues.length === 0) {
    return "ok";
  }
  if (providerIssues.some((issue) => issue.category.endsWith("_quota"))) {
    return "blocked";
  }
  return "warning";
}

export function buildOperationsTriageSummary(
  options: BuildOperationsTriageOptions,
): OperationsTriageSummary {
  const summary = options.summary;
  const handles = options.handles ?? summary?.handles.map((handle) => handle.handle) ?? [];
  const emptyTotals: OperationsTriageSummary["totals"] = {
    fetchedPosts: 0,
    insertedEvents: 0,
    insertedApprovedEvents: 0,
    insertedPendingEvents: 0,
    skippedDuplicates: 0,
    skippedMissingDate: 0,
    skippedMissingVenue: 0,
    skippedInvalidEvents: 0,
    skippedPastEvents: 0,
    skippedFarFutureEvents: 0,
    failedDownloads: 0,
    failedConversions: 0,
    failedExtractions: 0,
    failedImagePersistence: 0,
    handlesWithErrors: 0,
  };

  if (!summary) {
    return {
      tone: options.status === "queued" || options.status === "running" ? "running" : "neutral",
      title:
        options.status === "queued" || options.status === "running"
          ? "Getting new events is in progress."
          : "No ingestion run has been summarized yet.",
      description:
        options.status === "queued" || options.status === "running"
          ? "Instagram posts are scraped first, then AI extracts events and uncertain results stay pending."
          : "Run ingestion to see provider status, skipped handles, and extraction issues.",
      totals: emptyTotals,
      providerStatus: { openai: "unknown", apify: "unknown" },
      handleSelection: {
        activeVenueCount: null,
        selectedHandleCount: handles.length,
        skippedRecentlyAttempted: 0,
        skippedDueToRunLimit: 0,
        fullScrapeCooldownHours: null,
      },
      issueGroups: [],
    };
  }

  const totals: OperationsTriageSummary["totals"] = {
    fetchedPosts: sum(summary, (handle) => countFirst(handle.fetchedPosts, handle.fetched_posts)),
    insertedEvents: sum(summary, (handle) =>
      countFirst(handle.insertedEvents, handle.inserted_events),
    ),
    insertedApprovedEvents: sum(summary, (handle) => count(handle.insertedApprovedEvents)),
    insertedPendingEvents: sum(summary, (handle) => count(handle.insertedPendingEvents)),
    skippedDuplicates: sum(summary, (handle) =>
      countFirst(handle.skippedDuplicates, handle.skipped_duplicates),
    ),
    skippedMissingDate: sum(summary, (handle) => count(handle.skipped_missing_date)),
    skippedMissingVenue: sum(summary, (handle) => count(handle.skipped_missing_venue)),
    skippedInvalidEvents: sum(summary, (handle) => count(handle.skipped_invalid_event)),
    skippedPastEvents: sum(summary, (handle) => count(handle.skipped_past_event)),
    skippedFarFutureEvents: sum(summary, (handle) => count(handle.skipped_far_future_event)),
    failedDownloads: sum(summary, (handle) =>
      countFirst(handle.failedDownloads, handle.failed_downloads),
    ),
    failedConversions: sum(summary, (handle) =>
      countFirst(handle.failedConversions, handle.failed_conversions),
    ),
    failedExtractions: sum(summary, (handle) =>
      countFirst(handle.failedExtractions, handle.failed_extractions, handle.failed_extraction),
    ),
    failedImagePersistence: sum(summary, (handle) => count(handle.failedImagePersistence)),
    handlesWithErrors: summary.handles.filter((handle) => handle.errors.length > 0).length,
  };
  const issueGroups = collectIssueGroups(summary, options.recentSummaries ?? []);
  const providerStatus = {
    openai: getProviderStatus(issueGroups, "openai"),
    apify: getProviderStatus(issueGroups, "apify"),
  };
  const failed =
    totals.failedDownloads +
    totals.failedConversions +
    totals.failedExtractions +
    totals.failedImagePersistence;
  const hasWarnings = failed > 0 || issueGroups.length > 0;
  const openAiBlocked = providerStatus.openai === "blocked";
  const apifyBlocked = providerStatus.apify === "blocked";
  const status = options.status ?? "completed";

  let tone: IngestionTriageTone = "neutral";
  let title = "The run finished, but Instagram returned no recent posts.";
  let description =
    "Nothing new matched the current scrape window, so there was nothing to add to the calendar.";

  if (status === "queued" || status === "running") {
    tone = "running";
    title = "Getting new events is in progress.";
    description =
      "Instagram posts are being scraped first. Then AI extracts events, high-confidence events are auto-approved, and uncertain events stay pending.";
  } else if (openAiBlocked && totals.insertedEvents === 0) {
    tone = "danger";
    title =
      totals.fetchedPosts > 0
        ? "Posts saved, OpenAI quota blocked extraction."
        : "OpenAI quota blocked event extraction.";
    description =
      "The run needs OpenAI quota restored before it can create approved or pending events from fetched posts.";
  } else if (apifyBlocked && totals.fetchedPosts === 0) {
    tone = "danger";
    title = "Apify blocked Instagram scraping.";
    description =
      "No new posts could be fetched because the Instagram scraping provider returned a quota, billing, or actor limit error.";
  } else if (totals.insertedApprovedEvents > 0) {
    tone = hasWarnings ? "warning" : "success";
    title = hasWarnings
      ? `Completed with warnings: ${totals.insertedApprovedEvents} approved event${
          totals.insertedApprovedEvents === 1 ? "" : "s"
        } created.`
      : `${totals.insertedApprovedEvents} approved event${
          totals.insertedApprovedEvents === 1 ? "" : "s"
        } should be visible in the calendar.`;
    description =
      totals.insertedPendingEvents > 0
        ? `${totals.insertedPendingEvents} more event${
            totals.insertedPendingEvents === 1 ? "" : "s"
          } were created as pending review.`
        : "This run created calendar-visible events.";
  } else if (totals.insertedPendingEvents > 0) {
    tone = "warning";
    title = "New events were created, but they are not in the calendar yet.";
    description = `${totals.insertedPendingEvents} event${
      totals.insertedPendingEvents === 1 ? "" : "s"
    } were created as pending review, and public pages only show approved upcoming events.`;
  } else if (totals.fetchedPosts > 0) {
    tone = "warning";
    title = "Instagram scraping finished, but no events were created.";
    description =
      "Posts were fetched, but extraction or normalization did not produce approved or pending upcoming events.";
  } else if (hasWarnings || status === "failed") {
    tone = "danger";
    title = "The ingestion run failed before creating events.";
    description =
      "Review provider and handle-level errors below before retrying the same batch.";
  }

  return {
    tone,
    title,
    description,
    totals,
    providerStatus,
    handleSelection: {
      activeVenueCount:
        typeof summary.runContext?.activeVenueCount === "number"
          ? summary.runContext.activeVenueCount
          : null,
      selectedHandleCount:
        summary.runContext?.selectedHandleCount ?? handles.length ?? summary.handles.length,
      skippedRecentlyAttempted: summary.runContext?.skippedRecentlyAttempted ?? 0,
      skippedDueToRunLimit: summary.runContext?.skippedDueToRunLimit ?? 0,
      fullScrapeCooldownHours: summary.runContext?.fullScrapeCooldownHours ?? null,
    },
    issueGroups,
  };
}
