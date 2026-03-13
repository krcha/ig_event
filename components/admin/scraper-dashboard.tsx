"use client";

import { useMemo, useState } from "react";
import type {
  IngestionRunMode,
  IngestionSummary,
} from "@/lib/pipeline/run-instagram-ingestion";

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
  error?: string | null;
};

const POLL_INTERVAL_MS = 2_000;
const SHORT_BACKFILL_DAYS = 3;
type HandleSummary = IngestionSummary["handles"][number];

const HANDLE_SUMMARY_METRICS: Array<{
  label: string;
  getValue: (item: HandleSummary) => number;
}> = [
  { label: "Fetched posts", getValue: (item) => item.fetchedPosts },
  { label: "Inserted events", getValue: (item) => item.insertedEvents },
  { label: "Skipped duplicates", getValue: (item) => item.skippedDuplicates },
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
  { label: "Failed downloads", getValue: (item) => item.failedDownloads },
  { label: "Failed conversions", getValue: (item) => item.failedConversions },
  { label: "Failed extractions", getValue: (item) => item.failedExtractions },
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
      return "Active venues repair";
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

export function ScraperDashboard() {
  const [handlesText, setHandlesText] = useState("residentadvisor\nboilerroomtv");
  const [resultsLimitInput, setResultsLimitInput] = useState("5");
  const [daysBackInput, setDaysBackInput] = useState("5");
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

  const handles = handlesText
    .split(/\s|,/)
    .map((handle) => handle.trim())
    .filter((handle) => handle.length > 0);
  const resultsLimit = parsePositiveInt(resultsLimitInput);
  const daysBack = parsePositiveInt(daysBackInput);

  async function delay(ms: number) {
    await new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  async function pollScrapeJob(statusUrl: string) {
    while (true) {
      const response = await fetch(statusUrl, {
        method: "POST",
        cache: "no-store",
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
      });

      if (payload.status === "completed") {
        return;
      }
      if (payload.status === "failed") {
        throw new Error(payload.error ?? "Scrape job failed.");
      }

      await delay(POLL_INTERVAL_MS);
    }
  }

  async function runQueuedScraper(endpoint: string, body: Record<string, unknown>) {
    setIsLoading(true);
    setError(null);
    setSummaryPayload(null);
    setActiveJobId(null);
    setActiveJobStatus(null);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
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
      await pollScrapeJob(payload.statusUrl);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : "Unknown scraper error.",
      );
    } finally {
      setIsLoading(false);
    }
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

  const modeLabel =
    summaryPayload?.mode === "saved_posts"
      ? "Saved posts to draft events"
      : "Fresh Apify scrape to draft events";
  const sourceLabel = getSourceLabel(summaryPayload?.source);

  const aggregateMetrics = useMemo(() => {
    if (!summaryPayload) {
      return {
        fetched: 0,
        inserted: 0,
        duplicates: 0,
        updated: 0,
        failures: 0,
        handlesWithErrors: 0,
      };
    }

    return summaryPayload.summary.handles.reduce(
      (totals, handleSummary) => ({
        fetched: totals.fetched + handleSummary.fetchedPosts,
        inserted: totals.inserted + handleSummary.insertedEvents,
        duplicates: totals.duplicates + handleSummary.skippedDuplicates,
        updated: totals.updated + handleSummary.updated_duplicates_bad_data,
        failures:
          totals.failures +
          handleSummary.failedDownloads +
          handleSummary.failedConversions +
          handleSummary.failedExtractions,
        handlesWithErrors: totals.handlesWithErrors + (handleSummary.errors.length > 0 ? 1 : 0),
      }),
      {
        fetched: 0,
        inserted: 0,
        duplicates: 0,
        updated: 0,
        failures: 0,
        handlesWithErrors: 0,
      },
    );
  }, [summaryPayload]);

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
            <h2 className="text-lg font-semibold">Run ingestion</h2>
            <p className="text-sm text-muted-foreground">
              Choose the account set, then start at the earliest pipeline step you still need.
              Each lower action skips work that the one above it already covers.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {[
              ["Quick check", "5", "5"],
              ["Recent month", "10", "30"],
              ["3-day window", "5", String(SHORT_BACKFILL_DAYS)],
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
                Step 1 starts from a new Apify actor run, stores those posts, then creates draft
                events.
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
                {isLoading ? "Running..." : "Run fresh Apify scrape and create draft events"}
              </button>
              <p className="mt-2 text-sm text-muted-foreground">
                Starts from a new Apify scrape, saves those posts, runs AI on the poster and
                caption, and writes draft events to Convex.
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
                {isLoading ? "Running..." : "Reuse recent Apify runs and create draft events"}
              </button>
              <p className="mt-2 text-sm text-muted-foreground">
                Pulls matching posts from the last 300 successful Apify runs into Convex without
                launching new actors, then reruns AI extraction. Ignores Results limit and Days
                back.
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
                {isLoading ? "Running..." : "Reprocess saved posts into draft events"}
              </button>
              <p className="mt-2 text-sm text-muted-foreground">
                Starts from posts that are already saved for these handles in Convex and reruns AI
                extraction without touching Apify.
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
                    : "Run fresh Apify scrape for active venues not run in 24h"}
                </button>
                <p className="mt-2 text-sm text-muted-foreground">
                  Runs a fresh Apify scrape for each active venue that has not had a full scrape
                  attempt in the last 24 hours, stores those posts, then creates draft events from
                  the new data.
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
        <div className="rounded-2xl border border-border bg-background/70 p-4 text-sm">
          <p className="font-medium">Active job</p>
          <p className="mt-1 text-muted-foreground">
            Job {activeJobId} is currently {activeJobStatus ?? "queued"}.
          </p>
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
            <input
              className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm lg:max-w-xs"
              onChange={(event) => setHandleSearch(event.target.value)}
              placeholder="Filter handle results"
              value={handleSearch}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            {[
              ["Fetched", aggregateMetrics.fetched],
              ["Inserted", aggregateMetrics.inserted],
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
