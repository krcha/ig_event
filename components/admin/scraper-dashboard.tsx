"use client";

import { useState } from "react";
import type {
  IngestionRunMode,
  IngestionSummary,
} from "@/lib/pipeline/run-instagram-ingestion";

type ScrapeSummaryPayload = {
  source:
    | "manual"
    | "active_venues"
    | "cron_active_venues"
    | "repair_active_venues";
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
  mode?: "repair" | IngestionRunMode;
  source?: "manual" | "repair_active_venues";
  handles?: string[];
  statusUrl?: string;
  error?: string;
};

type ScrapeJobPayload = {
  jobId: string;
  status: ScrapeJobStatus;
  source: "manual" | "repair_active_venues";
  mode?: IngestionRunMode;
  handles: string[];
  summary: IngestionSummary;
  error?: string | null;
};

const POLL_INTERVAL_MS = 2_000;
type HandleSummary = IngestionSummary["handles"][number];

const HANDLE_SUMMARY_METRICS: Array<{
  label: string;
  getValue: (item: HandleSummary) => number;
}> = [
  { label: "Fetched posts", getValue: (item) => item.fetchedPosts },
  { label: "Fetched posts (normalized)", getValue: (item) => item.fetched_posts },
  { label: "Inserted events", getValue: (item) => item.insertedEvents },
  { label: "Inserted events (new)", getValue: (item) => item.inserted_events },
  { label: "Skipped duplicates", getValue: (item) => item.skippedDuplicates },
  { label: "Skipped duplicates (normalized)", getValue: (item) => item.skipped_duplicates },
  { label: "Skipped clean duplicates", getValue: (item) => item.skipped_duplicates_clean },
  { label: "Skipped no image", getValue: (item) => item.skippedNoImage },
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
    label: "Updated bad duplicates",
    getValue: (item) => item.updated_duplicates_bad_data,
  },
  { label: "Duplicate update failed", getValue: (item) => item.duplicate_update_failed },
  { label: "Failed downloads", getValue: (item) => item.failedDownloads },
  { label: "Failed downloads (normalized)", getValue: (item) => item.failed_downloads },
  { label: "Failed conversions", getValue: (item) => item.failedConversions },
  {
    label: "Failed conversions (normalized)",
    getValue: (item) => item.failed_conversions,
  },
  { label: "Failed extractions", getValue: (item) => item.failedExtractions },
  {
    label: "Failed extractions (normalized)",
    getValue: (item) => item.failed_extractions,
  },
  { label: "Failed extraction (new)", getValue: (item) => item.failed_extraction },
];

export function ScraperDashboard() {
  const [handlesText, setHandlesText] = useState("residentadvisor\nboilerroomtv");
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

  async function runScraper(endpoint: string, body?: Record<string, unknown>) {
    setIsLoading(true);
    setError(null);
    setSummaryPayload(null);
    setActiveJobId(null);
    setActiveJobStatus(null);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });

      const payload = (await response.json()) as ScrapeSummaryPayload;

      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to run scraper pipeline.");
      }

      setSummaryPayload(payload);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unknown scraper error.",
      );
    } finally {
      setIsLoading(false);
    }
  }

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

      const payload = (await response.json()) as ScrapeJobPayload;
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

  async function runManualScraper(mode: IngestionRunMode) {
    setIsLoading(true);
    setError(null);
    setSummaryPayload(null);
    setActiveJobId(null);
    setActiveJobStatus(null);

    try {
      const response = await fetch("/api/admin/scrape", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handles, mode }),
      });

      const payload = (await response.json()) as ScrapeStartPayload;
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to start scraper job.");
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

  async function runRepairScraper() {
    setIsLoading(true);
    setError(null);
    setSummaryPayload(null);
    setActiveJobId(null);
    setActiveJobStatus(null);

    try {
      const response = await fetch("/api/admin/scrape/repair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resultsLimit: 5,
          daysBack: 365,
        }),
      });

      const payload = (await response.json()) as ScrapeStartPayload;
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to start repair job.");
      }
      if (!payload.started || !payload.jobId || !payload.statusUrl) {
        throw new Error("Invalid repair job response.");
      }

      setActiveJobId(payload.jobId);
      setActiveJobStatus(payload.status ?? "queued");
      await pollScrapeJob(payload.statusUrl);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : "Unknown repair error.",
      );
    } finally {
      setIsLoading(false);
    }
  }

  function runActiveVenueScraper(mode: IngestionRunMode) {
    void runScraper("/api/admin/scrape/venues", { mode });
  }

  const modeLabel =
    summaryPayload?.mode === "saved_posts"
      ? "Saved Apify posts re-output"
      : "Full scrape + extract";

  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-5">
      <label className="block space-y-2">
        <span className="text-sm font-medium">Instagram handles</span>
        <textarea
          className="min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          value={handlesText}
          onChange={(event) => setHandlesText(event.target.value)}
          placeholder="one handle per line or comma-separated"
        />
      </label>

      <div className="space-y-3 rounded-md border border-border bg-background p-4">
        <div className="space-y-1">
          <p className="text-sm font-medium">Listed handles</p>
          <p className="text-sm text-muted-foreground">
            Re-output reuses already saved Apify posts for these handles, reruns
            poster + caption analysis, and updates matching events when fields change.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isLoading || handles.length === 0}
            onClick={() => {
              void runManualScraper("full_scrape");
            }}
            type="button"
          >
            {isLoading ? "Running scrape job..." : "Run full scrape + extract"}
          </button>
          <button
            className="rounded-md border border-border px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isLoading || handles.length === 0}
            onClick={() => {
              void runManualScraper("saved_posts");
            }}
            type="button"
          >
            {isLoading ? "Running..." : "Re-output from saved Apify posts"}
          </button>
        </div>
      </div>

      <div className="space-y-3 rounded-md border border-border bg-background p-4">
        <div className="space-y-1">
          <p className="text-sm font-medium">Active venues</p>
          <p className="text-sm text-muted-foreground">
            Use the saved-post option when you want OpenAI to regenerate venue/title
            fields from already scraped venue posts without calling Apify again.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className="rounded-md border border-border px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isLoading}
            onClick={() => {
              runActiveVenueScraper("full_scrape");
            }}
            type="button"
          >
            {isLoading ? "Running..." : "Run all active venues"}
          </button>
          <button
            className="rounded-md border border-border px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isLoading}
            onClick={() => {
              runActiveVenueScraper("saved_posts");
            }}
            type="button"
          >
            {isLoading ? "Running..." : "Re-output active venues from saved Apify posts"}
          </button>
          <button
            className="rounded-md border border-border px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isLoading}
            onClick={() => {
              void runRepairScraper();
            }}
            type="button"
          >
            {isLoading ? "Running..." : "Repair existing bad events"}
          </button>
        </div>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {activeJobId ? (
        <p className="text-sm text-muted-foreground">
          Job {activeJobId} status: {activeJobStatus ?? "queued"}
        </p>
      ) : null}

      {summaryPayload ? (
        <div className="space-y-3 rounded-md border border-border bg-background p-4 text-sm">
          <p>
            Source: <span className="font-medium">{summaryPayload.source}</span>
          </p>
          <p>
            Mode:{" "}
            <span className="font-medium">
              {modeLabel}
            </span>
          </p>
          <p>
            Handles:{" "}
            <span className="font-medium">
              {summaryPayload.handles.length > 0
                ? summaryPayload.handles.join(", ")
                : "(none)"}
            </span>
          </p>
          <p>
            Started:{" "}
            <span className="font-medium">{summaryPayload.summary.startedAt}</span>
          </p>
          <p>
            Finished:{" "}
            <span className="font-medium">{summaryPayload.summary.finishedAt}</span>
          </p>
          <div className="space-y-2">
            {summaryPayload.summary.handles.map((item) => {
              const visibleMetrics = HANDLE_SUMMARY_METRICS.map((metric) => ({
                label: metric.label,
                value: metric.getValue(item),
              })).filter((metric) => metric.value > 0);

              return (
                <div className="rounded border border-border p-3" key={item.handle}>
                  <p className="font-medium">@{item.handle}</p>
                  {visibleMetrics.map((metric) => (
                    <p key={metric.label}>
                      {metric.label}: {metric.value}
                    </p>
                  ))}
                  {visibleMetrics.length === 0 && item.errors.length === 0 ? (
                    <p className="text-muted-foreground">No non-zero results.</p>
                  ) : null}
                  {item.errors.length > 0 ? (
                    <p className="text-destructive">
                      Errors: {item.errors.join(" | ")}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}
