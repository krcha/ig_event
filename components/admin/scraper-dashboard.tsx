"use client";

import { useMemo, useRef, useState } from "react";
import type {
  IngestionRunMode,
  IngestionSummary,
} from "@/lib/pipeline/run-instagram-ingestion";
import {
  buildOperationsTriageSummary,
  type OperationsTriageSummary,
} from "@/lib/pipeline/ingestion-run-triage";

type ScrapeSource =
  | "manual"
  | "active_venues"
  | "cron_active_venues"
  | "repair_active_venues"
  | "manual_apify_history"
  | "active_venues_apify_history"
  | "upcoming_convex_events"
  | "csv_venue_names";

type ScrapeSummaryPayload = {
  source: ScrapeSource;
  mode?: IngestionRunMode;
  handles: string[];
  summary: IngestionSummary;
  triage?: OperationsTriageSummary;
  error?: string;
};

type ScrapeJobStatus = "queued" | "running" | "completed" | "failed";

type ScrapeStartPayload = {
  started?: boolean;
  jobId?: string;
  status?: ScrapeJobStatus;
  mode?: IngestionRunMode;
  source?: ScrapeSource;
  handles?: string[];
  statusUrl?: string;
  errorStep?: string;
  error?: string;
  lastFreshScrapeAt?: string | null;
};

type ScrapeJobPayload = {
  jobId: string;
  status: ScrapeJobStatus;
  source: ScrapeSource;
  mode?: IngestionRunMode;
  handles: string[];
  summary: IngestionSummary;
  triage?: OperationsTriageSummary;
  error?: string | null;
};

const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_ATTEMPTS = 180;
const POLLING_STOPPED_MESSAGE =
  "Polling stopped. The ingestion job is still saved and can be resumed from this panel.";
const SHORT_BACKFILL_DAYS = 3;
type HandleSummary = IngestionSummary["handles"][number];
type ApprovedDuplicateCleanupSummary = NonNullable<
  IngestionSummary["approvedDuplicateCleanup"]
>;

function countMetric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function countFirstMetric(...values: unknown[]): number {
  for (const value of values) {
    const normalized = countMetric(value);
    if (normalized > 0) {
      return normalized;
    }
  }
  return 0;
}

const HANDLE_SUMMARY_METRICS: Array<{
  label: string;
  getValue: (item: HandleSummary) => number;
}> = [
  {
    label: "Fetched posts",
    getValue: (item) => countFirstMetric(item.fetchedPosts, item.fetched_posts),
  },
  {
    label: "Inserted events",
    getValue: (item) => countFirstMetric(item.insertedEvents, item.inserted_events),
  },
  { label: "Auto-approved events", getValue: (item) => item.insertedApprovedEvents ?? 0 },
  { label: "Pending review", getValue: (item) => item.insertedPendingEvents ?? 0 },
  {
    label: "Skipped duplicates",
    getValue: (item) => countFirstMetric(item.skippedDuplicates, item.skipped_duplicates),
  },
  { label: "Updated duplicates", getValue: (item) => item.updated_duplicates_bad_data },
  { label: "Skipped missing date", getValue: (item) => item.skipped_missing_date },
  { label: "Skipped missing venue", getValue: (item) => item.skipped_missing_venue },
  { label: "Skipped past event", getValue: (item) => item.skipped_past_event ?? 0 },
  {
    label: "Skipped far future event",
    getValue: (item) => item.skipped_far_future_event ?? 0,
  },
  { label: "Skipped video", getValue: (item) => item.skipped_video },
  { label: "Skipped invalid event", getValue: (item) => item.skipped_invalid_event },
  {
    label: "Failed downloads",
    getValue: (item) => countFirstMetric(item.failedDownloads, item.failed_downloads),
  },
  {
    label: "Failed conversions",
    getValue: (item) => countFirstMetric(item.failedConversions, item.failed_conversions),
  },
  {
    label: "Failed extractions",
    getValue: (item) =>
      countFirstMetric(item.failedExtractions, item.failed_extractions, item.failed_extraction),
  },
  { label: "Duplicate update failed", getValue: (item) => item.duplicate_update_failed },
];

function parsePositiveInt(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function formatDateTime(value: string | undefined): string {
  if (!value) {
    return "(none)";
  }
  return new Date(value).toLocaleString();
}

function buildScrapeStartErrorMessage(payload: ScrapeStartPayload, status: number): string {
  const baseMessage = payload.error ?? `Failed to start scraper job (status ${status}).`;

  if (!payload.lastFreshScrapeAt) {
    return baseMessage;
  }

  return `${baseMessage} Last fresh scrape attempt: ${formatDateTime(payload.lastFreshScrapeAt)}.`;
}

function normalizeApiErrorText(rawText: string, status: number): string {
  const stripped = rawText
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return stripped || `Request failed with status ${status}.`;
}

async function readJsonPayload<T>(response: Response): Promise<T> {
  const rawText = await response.text();
  if (rawText.length === 0) {
    return {} as T;
  }

  try {
    return JSON.parse(rawText) as T;
  } catch {
    throw new Error(normalizeApiErrorText(rawText, response.status));
  }
}

function buildSummaryRequestBody(
  mode: IngestionRunMode,
  resultsLimit: number | undefined,
  daysBack: number | undefined,
  handles?: string[],
): Record<string, unknown> {
  return {
    mode,
    ...(handles ? { handles } : {}),
    ...(resultsLimit ? { resultsLimit } : {}),
    ...(daysBack ? { daysBack } : {}),
  };
}

function getSourceLabel(source: ScrapeSource | undefined): string {
  switch (source) {
    case "manual":
      return "Pasted handles";
    case "active_venues":
      return "All active venues";
    case "cron_active_venues":
      return "Scheduled active venues";
    case "repair_active_venues":
      return "Get new events";
    case "manual_apify_history":
      return "Recent Apify runs for pasted handles";
    case "active_venues_apify_history":
      return "Recent Apify runs for active venues";
    case "upcoming_convex_events":
      return "Upcoming Convex events";
    case "csv_venue_names":
      return "CSV venue-name reprocess";
    default:
      return "Idle";
  }
}

function getAutomergeStatus(
  summary: ApprovedDuplicateCleanupSummary | null | undefined,
): string {
  if (!summary) {
    return "Not run";
  }

  if (summary.failedCount > 0 && summary.mergedDuplicateCount > 0) {
    return "Partial";
  }
  if (summary.failedCount > 0) {
    return "Failed";
  }
  if (summary.mergedDuplicateCount > 0) {
    return `Merged ${summary.mergedDuplicateCount}`;
  }
  if (summary.remainingGroupCount > 0) {
    return "Needs review";
  }

  return "No match";
}

function getTriageToneClass(tone: OperationsTriageSummary["tone"]): string {
  switch (tone) {
    case "danger":
      return "border-destructive/30 bg-destructive/5 text-destructive";
    case "running":
      return "border-primary/30 bg-primary/5 text-foreground";
    case "success":
      return "border-emerald-500/30 bg-emerald-500/5 text-foreground";
    case "warning":
      return "border-amber-500/30 bg-amber-500/5 text-foreground";
    case "neutral":
    default:
      return "border-border bg-background/70 text-muted-foreground";
  }
}

export function ScraperDashboard() {
  const [handlesText, setHandlesText] = useState("residentadvisor\nboilerroomtv");
  const [resultsLimitInput, setResultsLimitInput] = useState("1");
  const [daysBackInput, setDaysBackInput] = useState("10");
  const [handleSearch, setHandleSearch] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summaryPayload, setSummaryPayload] = useState<ScrapeSummaryPayload | null>(
    null,
  );
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeJobStatus, setActiveJobStatus] = useState<ScrapeJobStatus | null>(
    null,
  );
  const [activeStatusUrl, setActiveStatusUrl] = useState<string | null>(null);

  const handles = handlesText
    .split(/\s|,/)
    .map((handle) => handle.trim())
    .filter((handle) => handle.length > 0);
  const resultsLimit = parsePositiveInt(resultsLimitInput);
  const daysBack = parsePositiveInt(daysBackInput);

  const pollAbortControllerRef = useRef<AbortController | null>(null);

  async function delay(ms: number, signal: AbortSignal) {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error(POLLING_STOPPED_MESSAGE));
        return;
      }

      function handleAbort() {
        window.clearTimeout(timeout);
        reject(new Error(POLLING_STOPPED_MESSAGE));
      }

      const timeout = window.setTimeout(() => {
        signal.removeEventListener("abort", handleAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", handleAbort, { once: true });
    });
  }

  async function pollScrapeJob(statusUrl: string, signal: AbortSignal) {
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
      const response = await fetch(statusUrl, {
        method: "POST",
        cache: "no-store",
        signal,
      });

      const payload = await readJsonPayload<ScrapeJobPayload>(response);
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to process scrape job.");
      }

      setActiveJobStatus(payload.status);
      setSummaryPayload({
        source: payload.source,
        mode: payload.mode,
        handles: payload.handles,
        summary: payload.summary,
        triage: payload.triage,
      });

      if (payload.status === "completed") {
        return;
      }
      if (payload.status === "failed") {
        throw new Error(payload.error ?? "Scrape job failed.");
      }

      await delay(POLL_INTERVAL_MS, signal);
    }

    throw new Error(
      "Stopped polling because the job stayed queued or running for too long. Resume polling from the active job panel.",
    );
  }

  async function pollQueuedJob(statusUrl: string) {
    const controller = new AbortController();
    pollAbortControllerRef.current = controller;
    setIsLoading(true);
    setError(null);
    try {
      await pollScrapeJob(statusUrl, controller.signal);
    } catch (caughtError) {
      setError(
        controller.signal.aborted
          ? POLLING_STOPPED_MESSAGE
          : caughtError instanceof Error
            ? caughtError.message
            : "Unknown scraper error.",
      );
    } finally {
      if (pollAbortControllerRef.current === controller) {
        pollAbortControllerRef.current = null;
      }
      setIsLoading(false);
    }
  }

  async function runQueuedScraper(endpoint: string, body: Record<string, unknown>) {
    const controller = new AbortController();
    pollAbortControllerRef.current = controller;
    setIsLoading(true);
    setError(null);
    setSummaryPayload(null);
    setActiveJobId(null);
    setActiveJobStatus(null);
    setActiveStatusUrl(null);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const payload = await readJsonPayload<ScrapeStartPayload>(response);
      if (!response.ok) {
        throw new Error(buildScrapeStartErrorMessage(payload, response.status));
      }
      if (!payload.started || !payload.jobId || !payload.statusUrl) {
        throw new Error("Invalid scraper job response.");
      }

      setActiveJobId(payload.jobId);
      setActiveJobStatus(payload.status ?? "queued");
      setActiveStatusUrl(payload.statusUrl);
      await pollScrapeJob(payload.statusUrl, controller.signal);
    } catch (caughtError) {
      setError(
        controller.signal.aborted
          ? POLLING_STOPPED_MESSAGE
          : caughtError instanceof Error
            ? caughtError.message
            : "Unknown scraper error.",
      );
    } finally {
      if (pollAbortControllerRef.current === controller) {
        pollAbortControllerRef.current = null;
      }
      setIsLoading(false);
    }
  }

  function stopPolling() {
    pollAbortControllerRef.current?.abort();
  }

  function resumePolling() {
    if (!activeStatusUrl || isLoading) {
      return;
    }
    void pollQueuedJob(activeStatusUrl);
  }

  function runManualScraper(mode: IngestionRunMode) {
    void runQueuedScraper(
      "/api/admin/scrape",
      buildSummaryRequestBody(mode, resultsLimit, daysBack, handles),
    );
  }

  function runManualApifyHistoryImport() {
    void runQueuedScraper("/api/admin/scrape/history", {
      handles,
    });
  }

  function runActiveVenueApifyHistoryImport() {
    void runQueuedScraper("/api/admin/scrape/history/venues", {});
  }

  function runActiveVenueScraper(mode: IngestionRunMode) {
    void runQueuedScraper(
      "/api/admin/scrape/venues",
      buildSummaryRequestBody(mode, resultsLimit, daysBack),
    );
  }

  function runGetNewEvents() {
    void runQueuedScraper("/api/admin/scrape/repair", {
      ...(resultsLimit ? { resultsLimit } : {}),
      ...(daysBack ? { daysBack } : {}),
    });
  }

  const modeLabel =
    summaryPayload?.mode === "saved_posts"
      ? "Saved posts extraction"
      : "Fresh Apify scrape and extraction";
  const sourceLabel = getSourceLabel(summaryPayload?.source);
  const approvedDuplicateCleanup = summaryPayload?.summary.approvedDuplicateCleanup ?? null;
  const automergeStatus = getAutomergeStatus(approvedDuplicateCleanup);

  const aggregateMetrics = useMemo(() => {
    if (!summaryPayload) {
      return {
        fetched: 0,
        inserted: 0,
        insertedApproved: 0,
        insertedPending: 0,
        duplicates: 0,
        updated: 0,
        failures: 0,
        handlesWithErrors: 0,
        quotaBlocked: false,
      };
    }

    return summaryPayload.summary.handles.reduce(
      (totals, handleSummary) => ({
        fetched:
          totals.fetched +
          countFirstMetric(handleSummary.fetchedPosts, handleSummary.fetched_posts),
        inserted:
          totals.inserted +
          countFirstMetric(handleSummary.insertedEvents, handleSummary.inserted_events),
        insertedApproved:
          totals.insertedApproved + (handleSummary.insertedApprovedEvents ?? 0),
        insertedPending:
          totals.insertedPending + (handleSummary.insertedPendingEvents ?? 0),
        duplicates:
          totals.duplicates +
          countFirstMetric(handleSummary.skippedDuplicates, handleSummary.skipped_duplicates),
        updated: totals.updated + handleSummary.updated_duplicates_bad_data,
        failures:
          totals.failures +
          countFirstMetric(handleSummary.failedDownloads, handleSummary.failed_downloads) +
          countFirstMetric(handleSummary.failedConversions, handleSummary.failed_conversions) +
          countFirstMetric(
            handleSummary.failedExtractions,
            handleSummary.failed_extractions,
            handleSummary.failed_extraction,
          ),
        handlesWithErrors: totals.handlesWithErrors + (handleSummary.errors.length > 0 ? 1 : 0),
        quotaBlocked:
          totals.quotaBlocked ||
          handleSummary.errors.some((error) => /insufficient_quota|quota/i.test(error)),
      }),
      {
        fetched: 0,
        inserted: 0,
        insertedApproved: 0,
        insertedPending: 0,
        duplicates: 0,
        updated: 0,
        failures: 0,
        handlesWithErrors: 0,
        quotaBlocked: false,
      },
    );
  }, [summaryPayload]);

  const operationsTriage = useMemo(
    () =>
      summaryPayload?.triage ??
      buildOperationsTriageSummary({
        summary: summaryPayload?.summary,
        status: activeJobStatus,
        handles: summaryPayload?.handles ?? handles,
      }),
    [activeJobStatus, handles, summaryPayload],
  );

  const runOutcome = useMemo(() => {
    if (!summaryPayload && activeJobStatus !== "queued" && activeJobStatus !== "running") {
      return null;
    }

    return {
      tone: getTriageToneClass(operationsTriage.tone),
      title: operationsTriage.title,
      description: operationsTriage.description,
    };
  }, [activeJobStatus, operationsTriage, summaryPayload]);

  const filteredHandleSummaries = useMemo(() => {
    if (!summaryPayload) {
      return [];
    }
    const query = handleSearch.toLowerCase().trim();
    return summaryPayload.summary.handles.filter((item) =>
      query.length === 0 ? true : item.handle.toLowerCase().includes(query),
    );
  }, [handleSearch, summaryPayload]);

  return (
    <section className="space-y-6 rounded-3xl border border-border bg-card p-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {[
          ["Handles", handles.length],
          ["Results limit", resultsLimit ?? 0],
          ["Days back", daysBack ?? 0],
          ["Job status", activeJobStatus ?? "idle"],
          ["Mode", summaryPayload ? modeLabel : "Idle"],
        ].map(([label, value]) => (
          <div className="rounded-2xl border border-border bg-background/80 p-4" key={label}>
            <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">{label}</p>
            <p className="mt-2 text-2xl font-semibold">{String(value)}</p>
          </div>
        ))}
      </div>

      <section className="space-y-4 rounded-2xl border border-border bg-background/70 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Get New Events</h2>
            <p className="text-sm text-muted-foreground">
              One button for the cheap daily workflow: scrape the latest post from every
              cooldown-eligible active venue, save posts, extract events, skip already-processed
              source posts, and auto-merge approved duplicates.
            </p>
          </div>
          <button
            className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isLoading}
            onClick={() => {
              runGetNewEvents();
            }}
            type="button"
          >
            {isLoading ? "Getting new events..." : "GET NEW EVENTS"}
          </button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {[
            [
              "Posts",
              summaryPayload && aggregateMetrics.fetched === 0
                ? "No posts"
                : aggregateMetrics.fetched,
            ],
            ["Approved", aggregateMetrics.insertedApproved],
            ["Pending review", aggregateMetrics.insertedPending],
            ["Quota", summaryPayload ? (aggregateMetrics.quotaBlocked ? "Blocked" : "OK") : "Idle"],
            ["Automerge", automergeStatus],
          ].map(([label, value]) => (
            <div className="rounded-2xl border border-border bg-card/90 p-4" key={label}>
              <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">{label}</p>
              <p className="mt-2 text-2xl font-semibold">{String(value)}</p>
            </div>
          ))}
        </div>

        {runOutcome ? (
          <div className={`rounded-2xl border p-4 text-sm ${runOutcome.tone}`}>
            <p className="font-medium">{runOutcome.title}</p>
            <p className="mt-1">{runOutcome.description}</p>
          </div>
        ) : null}
      </section>

      <section className="space-y-4 rounded-2xl border border-border bg-background/70 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Advanced Tools</h2>
            <p className="text-sm text-muted-foreground">
              Use these only when you want manual control over handles, scrape source, or
              reprocessing steps.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {[
              ["Low-cost check", "1", "10"],
              ["Focused recent", "3", "14"],
              ["3-day window", "1", String(SHORT_BACKFILL_DAYS)],
            ].map(([label, nextResults, nextDays]) => (
              <button
                className="rounded-xl border border-border px-3 py-2 text-sm font-medium"
                key={label}
                onClick={() => {
                  setResultsLimitInput(nextResults);
                  setDaysBackInput(nextDays);
                }}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-[1.25fr_0.75fr]">
          <label className="block space-y-2">
            <span className="text-sm font-medium">Instagram handles</span>
            <textarea
              className="min-h-40 w-full rounded-2xl border border-input bg-background px-3 py-3 text-sm"
              value={handlesText}
              onChange={(event) => setHandlesText(event.target.value)}
              placeholder="one handle per line or comma-separated"
            />
          </label>

          <div className="space-y-4 rounded-2xl border border-border bg-card/90 p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-2">
                <span className="text-sm font-medium">Results limit</span>
                <input
                  className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm"
                  inputMode="numeric"
                  onChange={(event) => setResultsLimitInput(event.target.value)}
                  value={resultsLimitInput}
                />
              </label>
              <label className="space-y-2">
                <span className="text-sm font-medium">Days back</span>
                <input
                  className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm"
                  inputMode="numeric"
                  onChange={(event) => setDaysBackInput(event.target.value)}
                  value={daysBackInput}
                />
              </label>
            </div>
            <div className="rounded-2xl border border-border bg-background/70 p-3 text-sm text-muted-foreground">
              <p>Handles entered: {handles.length}</p>
              <p>
                Step 1 starts from new low-detail Apify actor runs, stores those posts, then
                extracts events. Keep pasted-handle batches small unless you intentionally want a
                wider backfill.
              </p>
              <p className="mt-2">
                Step 2 skips new actors and reuses posts from recent Apify runs. Step 3 skips
                Apify entirely and reruns AI extraction on posts already saved in Convex.
              </p>
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="space-y-4 rounded-2xl border border-border bg-background/70 p-4">
          <div>
            <h2 className="text-lg font-semibold">Use pasted handles</h2>
            <p className="text-sm text-muted-foreground">
              Best for testing one or a few Instagram accounts from the textarea above. Start later
              only if the earlier data already exists.
            </p>
          </div>
          <div className="grid gap-3">
            <div className="rounded-2xl border border-border bg-card/90 p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                Step 1 · full pipeline
              </p>
              <button
                className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
                disabled={isLoading || handles.length === 0}
                onClick={() => {
                  void runManualScraper("full_scrape");
                }}
                type="button"
              >
                {isLoading ? "Running..." : "Run fresh Apify scrape and extract events"}
              </button>
              <p className="mt-2 text-sm text-muted-foreground">
                Starts from a new Apify scrape, saves those posts, runs AI on the poster and
                caption, writes approved or pending events to Convex, then auto-merges approved
                duplicates.
              </p>
            </div>
            <div className="rounded-2xl border border-border bg-card/90 p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                Step 2 · skip new Apify jobs
              </p>
              <button
                className="rounded-xl border border-border px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
                disabled={isLoading || handles.length === 0}
                onClick={() => {
                  runManualApifyHistoryImport();
                }}
                type="button"
              >
                {isLoading ? "Running..." : "Reuse recent Apify runs and extract events"}
              </button>
              <p className="mt-2 text-sm text-muted-foreground">
                Pulls matching posts from the last 300 successful Apify runs into Convex without
                launching new actors, then reruns AI extraction into approved or pending events.
                Ignores Results limit and Days back.
              </p>
            </div>
            <div className="rounded-2xl border border-border bg-card/90 p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                Step 3 · saved posts only
              </p>
              <button
                className="rounded-xl border border-border px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
                disabled={isLoading || handles.length === 0}
                onClick={() => {
                  void runManualScraper("saved_posts");
                }}
                type="button"
              >
                {isLoading ? "Running..." : "Reprocess saved posts into events"}
              </button>
              <p className="mt-2 text-sm text-muted-foreground">
                Starts from posts that are already saved for these handles in Convex and reruns AI
                extraction without touching Apify. High-confidence events may be approved
                automatically; uncertain events stay pending.
              </p>
            </div>
          </div>
        </section>

        <div className="space-y-4">
          <section className="space-y-4 rounded-2xl border border-border bg-background/70 p-4">
            <div>
              <h2 className="text-lg font-semibold">Use all active venues</h2>
              <p className="text-sm text-muted-foreground">
                Uses every active venue handle from the database. These are the only three
                pipeline start points: fresh Apify run, existing Apify results, or saved posts.
              </p>
            </div>
            <div className="grid gap-3">
              <div className="rounded-2xl border border-border bg-card/90 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                  Step 1 · full pipeline
                </p>
                <button
                  className="rounded-xl border border-border px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={isLoading}
                  onClick={() => {
                    runActiveVenueScraper("full_scrape");
                  }}
                  type="button"
                >
                  {isLoading
                    ? "Running..."
                    : "Run fresh Apify scrape for cooldown-eligible active venues"}
                </button>
                <p className="mt-2 text-sm text-muted-foreground">
                  Runs a fresh Apify scrape for each active venue that has passed the configured
                  cooldown window, stores those posts, then creates approved or
                  pending events from the new data and finishes with approved-event automerge.
                </p>
              </div>
              <div className="rounded-2xl border border-border bg-card/90 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                  Step 2 · skip new Apify jobs
                </p>
                <button
                  className="rounded-xl border border-border px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={isLoading}
                  onClick={() => {
                    runActiveVenueApifyHistoryImport();
                  }}
                  type="button"
                >
                  {isLoading ? "Running..." : "Reuse recent Apify runs for all active venues"}
                </button>
                <p className="mt-2 text-sm text-muted-foreground">
                  Starts one step later: pulls posts from the last 300 successful Apify runs into
                  Convex without launching new actors, then processes them as saved posts. Ignores
                  Results limit and Days back.
                </p>
              </div>
              <div className="rounded-2xl border border-border bg-card/90 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                  Step 3 · saved posts only
                </p>
                <button
                  className="rounded-xl border border-border px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={isLoading}
                  onClick={() => {
                    runActiveVenueScraper("saved_posts");
                  }}
                  type="button"
                >
                  {isLoading ? "Running..." : "Reprocess saved posts for all active venues"}
                </button>
                <p className="mt-2 text-sm text-muted-foreground">
                  Starts from cached posts that are already saved in Convex for every active venue
                  and reruns AI extraction without touching Apify.
                </p>
              </div>
            </div>
          </section>
        </div>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {activeJobId ? (
        <div className="flex flex-col gap-3 rounded-2xl border border-border bg-background/70 p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-medium">Active job</p>
            <p className="mt-1 text-muted-foreground">
              Job {activeJobId} is currently {activeJobStatus ?? "queued"}.
            </p>
          </div>
          {activeStatusUrl && activeJobStatus !== "completed" && activeJobStatus !== "failed" ? (
            <div className="flex flex-wrap gap-2">
              {isLoading ? (
                <button
                  className="rounded-xl border border-border px-3 py-2 text-sm font-medium"
                  onClick={stopPolling}
                  type="button"
                >
                  Stop polling
                </button>
              ) : (
                <button
                  className="rounded-xl border border-border px-3 py-2 text-sm font-medium"
                  onClick={resumePolling}
                  type="button"
                >
                  Resume polling
                </button>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {summaryPayload ? (
        <section className="space-y-4 rounded-2xl border border-border bg-background/70 p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h2 className="text-lg font-semibold">Latest run</h2>
              <p className="text-sm text-muted-foreground">
                {sourceLabel} · {modeLabel}
              </p>
            </div>
            <div className="w-full lg:max-w-xs">
              <label className="sr-only" htmlFor="scraper-handle-filter">
                Filter handle results
              </label>
              <input
                className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm"
                id="scraper-handle-filter"
                onChange={(event) => setHandleSearch(event.target.value)}
                placeholder="Filter handle results"
                value={handleSearch}
              />
            </div>
          </div>

          <div className={`rounded-2xl border p-4 text-sm ${getTriageToneClass(operationsTriage.tone)}`}>
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <p className="font-medium">Operations triage</p>
                <p className="mt-1">{operationsTriage.title}</p>
                <p className="mt-1 text-muted-foreground">{operationsTriage.description}</p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded-xl border border-border bg-background/70 p-3">
                  <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                    OpenAI
                  </p>
                  <p className="mt-1 font-medium">{operationsTriage.providerStatus.openai}</p>
                </div>
                <div className="rounded-xl border border-border bg-background/70 p-3">
                  <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                    Apify
                  </p>
                  <p className="mt-1 font-medium">{operationsTriage.providerStatus.apify}</p>
                </div>
              </div>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              {[
                ["Selected handles", operationsTriage.handleSelection.selectedHandleCount],
                ["Cooldown skipped", operationsTriage.handleSelection.skippedRecentlyAttempted],
                ["Run-limit skipped", operationsTriage.handleSelection.skippedDueToRunLimit],
              ].map(([label, value]) => (
                <div className="rounded-xl border border-border bg-background/70 p-3" key={label}>
                  <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                    {label}
                  </p>
                  <p className="mt-1 font-medium">{String(value)}</p>
                </div>
              ))}
            </div>
            {operationsTriage.issueGroups.length > 0 ? (
              <div className="mt-3 space-y-2">
                <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                  Top issues
                </p>
                {operationsTriage.issueGroups.map((issue) => (
                  <div
                    className="rounded-xl border border-border bg-background/70 p-3"
                    key={`${issue.category}-${issue.provider ?? "internal"}-${issue.handle ?? "all"}`}
                  >
                    <p className="font-medium">
                      {issue.category}
                      {issue.provider ? ` · ${issue.provider}` : ""}
                      {issue.handle ? ` · @${issue.handle}` : ""}
                      {` (${issue.count})`}
                    </p>
                    <p className="mt-1 text-muted-foreground">{issue.message}</p>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            {[
              ["Fetched", aggregateMetrics.fetched],
              ["Inserted", aggregateMetrics.inserted],
              ["Approved", aggregateMetrics.insertedApproved],
              ["Pending review", aggregateMetrics.insertedPending],
              ["Duplicates", aggregateMetrics.duplicates],
              ["Updated", aggregateMetrics.updated],
              ["Failures", aggregateMetrics.failures],
              ["Handles with errors", aggregateMetrics.handlesWithErrors],
            ].map(([label, value]) => (
              <div className="rounded-2xl border border-border bg-card/90 p-4" key={label}>
                <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                  {label}
                </p>
                <p className="mt-2 text-2xl font-semibold">{value}</p>
              </div>
            ))}
          </div>

          {approvedDuplicateCleanup ? (
            <div className="rounded-2xl border border-border bg-card/90 p-4 text-sm">
              <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                Approved duplicate automerge
              </p>
              <p className="mt-2 font-medium">
                {approvedDuplicateCleanup.mergedDuplicateCount > 0
                  ? `Merged ${approvedDuplicateCleanup.mergedDuplicateCount} duplicates from ${approvedDuplicateCleanup.mergedGroupCount} group${approvedDuplicateCleanup.mergedGroupCount === 1 ? "" : "s"} in ${approvedDuplicateCleanup.passes} pass${approvedDuplicateCleanup.passes === 1 ? "" : "es"}.`
                  : approvedDuplicateCleanup.failedCount > 0
                    ? "Approved duplicate automerge failed."
                    : approvedDuplicateCleanup.remainingGroupCount > 0
                      ? "No approved duplicate groups were auto-merged."
                      : "No approved duplicate groups matched after this run."}
              </p>
              <p className="mt-1 text-muted-foreground">
                {approvedDuplicateCleanup.failedCount > 0
                  ? approvedDuplicateCleanup.error ??
                    `${approvedDuplicateCleanup.failedCount} merge failure${approvedDuplicateCleanup.failedCount === 1 ? "" : "s"}.`
                  : `${approvedDuplicateCleanup.scannedEventCount} upcoming approved events scanned, ${approvedDuplicateCleanup.remainingGroupCount} duplicate group${approvedDuplicateCleanup.remainingGroupCount === 1 ? "" : "s"} left for review.`}
              </p>
            </div>
          ) : null}

          <div className="grid gap-3 xl:grid-cols-4">
            <div className="rounded-2xl border border-border p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Source</p>
              <p className="mt-2 font-medium">{summaryPayload.source}</p>
            </div>
            <div className="rounded-2xl border border-border p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Mode</p>
              <p className="mt-2 font-medium">{modeLabel}</p>
            </div>
            <div className="rounded-2xl border border-border p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Started</p>
              <p className="mt-2 font-medium">{formatDateTime(summaryPayload.summary.startedAt)}</p>
            </div>
            <div className="rounded-2xl border border-border p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Finished</p>
              <p className="mt-2 font-medium">{formatDateTime(summaryPayload.summary.finishedAt)}</p>
            </div>
          </div>

          <div className="space-y-3">
            {filteredHandleSummaries.map((item) => {
              const visibleMetrics = HANDLE_SUMMARY_METRICS.map((metric) => ({
                label: metric.label,
                value: metric.getValue(item),
              })).filter((metric) => metric.value > 0);

              return (
                <div
                  className="rounded-2xl border border-border bg-card/90 p-4"
                  key={item.handle}
                >
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <p className="text-base font-semibold">@{item.handle}</p>
                      <p className="text-sm text-muted-foreground">
                        {item.errors.length > 0
                          ? `${item.errors.length} error(s) recorded`
                          : "No recorded errors"}
                      </p>
                    </div>
                    <a
                      className="rounded-xl border border-border px-3 py-2 text-sm font-medium"
                      href={`https://www.instagram.com/${item.handle}/`}
                      rel="noreferrer"
                      target="_blank"
                    >
                      Open profile
                    </a>
                  </div>

                  {visibleMetrics.length > 0 ? (
                    <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                      {visibleMetrics.map((metric) => (
                        <div
                          className="rounded-xl border border-border bg-background/70 p-3"
                          key={metric.label}
                        >
                          <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                            {metric.label}
                          </p>
                          <p className="mt-1 text-xl font-semibold">{metric.value}</p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-3 text-sm text-muted-foreground">No non-zero results.</p>
                  )}

                  {item.errors.length > 0 ? (
                    <div className="mt-3 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                      {item.errors.join(" | ")}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
    </section>
  );
}
