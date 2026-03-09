"use client";

import { useState } from "react";
import type { IngestionSummary } from "@/lib/pipeline/run-instagram-ingestion";

type ScrapeSummaryPayload = {
  source:
    | "manual"
    | "active_venues"
    | "cron_active_venues"
    | "repair_active_venues";
  handles: string[];
  summary: IngestionSummary;
  error?: string;
};

type ScrapeJobStatus = "queued" | "running" | "completed" | "failed";

type ScrapeStartPayload = {
  started?: boolean;
  jobId?: string;
  status?: ScrapeJobStatus;
  mode?: "repair";
  source?: "manual" | "repair_active_venues";
  handles?: string[];
  statusUrl?: string;
  error?: string;
};

type ScrapeJobPayload = {
  jobId: string;
  status: ScrapeJobStatus;
  source: "manual" | "repair_active_venues";
  handles: string[];
  summary: IngestionSummary;
  error?: string | null;
};

const POLL_INTERVAL_MS = 2_000;

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

  async function runManualScraper() {
    setIsLoading(true);
    setError(null);
    setSummaryPayload(null);
    setActiveJobId(null);
    setActiveJobStatus(null);

    try {
      const response = await fetch("/api/admin/scrape", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handles }),
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
          resultsLimit: 100,
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

  function runActiveVenueScraper() {
    void runScraper("/api/admin/scrape/venues");
  }

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

      <button
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
        disabled={isLoading || handles.length === 0}
        onClick={() => {
          void runManualScraper();
        }}
        type="button"
      >
        {isLoading ? "Running scrape job..." : "Run scrape + extraction"}
      </button>
      <button
        className="ml-2 rounded-md border border-border px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
        disabled={isLoading}
        onClick={runActiveVenueScraper}
        type="button"
      >
        {isLoading ? "Running..." : "Run active venues"}
      </button>
      <button
        className="ml-2 rounded-md border border-border px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
        disabled={isLoading}
        onClick={() => {
          void runRepairScraper();
        }}
        type="button"
      >
        {isLoading ? "Running..." : "Repair existing bad events"}
      </button>

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
            {summaryPayload.summary.handles.map((item) => (
              <div className="rounded border border-border p-3" key={item.handle}>
                <p className="font-medium">@{item.handle}</p>
                <p>Fetched posts: {item.fetchedPosts}</p>
                <p>Fetched posts (normalized): {item.fetched_posts}</p>
                <p>Inserted events: {item.insertedEvents}</p>
                <p>Inserted events (new): {item.inserted_events}</p>
                <p>Skipped duplicates: {item.skippedDuplicates}</p>
                <p>Skipped duplicates (normalized): {item.skipped_duplicates}</p>
                <p>Skipped clean duplicates: {item.skipped_duplicates_clean}</p>
                <p>Skipped no image: {item.skippedNoImage}</p>
                <p>Skipped missing date: {item.skipped_missing_date}</p>
                <p>Skipped missing venue: {item.skipped_missing_venue}</p>
                <p>Skipped video: {item.skipped_video}</p>
                <p>Skipped invalid event: {item.skipped_invalid_event}</p>
                <p>Updated bad duplicates: {item.updated_duplicates_bad_data}</p>
                <p>Duplicate update failed: {item.duplicate_update_failed}</p>
                <p>Failed downloads: {item.failedDownloads}</p>
                <p>Failed downloads (normalized): {item.failed_downloads}</p>
                <p>Failed conversions: {item.failedConversions}</p>
                <p>Failed conversions (normalized): {item.failed_conversions}</p>
                <p>Failed extractions: {item.failedExtractions}</p>
                <p>Failed extractions (normalized): {item.failed_extractions}</p>
                <p>Failed extraction (new): {item.failed_extraction}</p>
                {item.errors.length > 0 ? (
                  <p className="text-destructive">
                    Errors: {item.errors.join(" | ")}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
