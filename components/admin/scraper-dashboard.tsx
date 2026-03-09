"use client";

import { useState } from "react";
import type { IngestionSummary } from "@/lib/pipeline/run-instagram-ingestion";

type ScrapeApiPayload = {
  source: "manual" | "active_venues" | "cron_active_venues";
  handles: string[];
  summary: IngestionSummary;
  error?: string;
};

export function ScraperDashboard() {
  const [handlesText, setHandlesText] = useState("residentadvisor\nboilerroomtv");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summaryPayload, setSummaryPayload] = useState<ScrapeApiPayload | null>(null);

  const handles = handlesText
    .split(/\s|,/)
    .map((handle) => handle.trim())
    .filter((handle) => handle.length > 0);

  async function runScraper(endpoint: string, body?: Record<string, unknown>) {
    setIsLoading(true);
    setError(null);
    setSummaryPayload(null);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });

      const payload = (await response.json()) as ScrapeApiPayload;

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

  function runManualScraper() {
    void runScraper("/api/admin/scrape", { handles });
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
        onClick={runManualScraper}
        type="button"
      >
        {isLoading ? "Running scrape..." : "Run scrape + extraction"}
      </button>
      <button
        className="ml-2 rounded-md border border-border px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
        disabled={isLoading}
        onClick={runActiveVenueScraper}
        type="button"
      >
        {isLoading ? "Running..." : "Run active venues"}
      </button>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

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
                <p>Inserted events: {item.insertedEvents}</p>
                <p>Skipped duplicates: {item.skippedDuplicates}</p>
                <p>Skipped no image: {item.skippedNoImage}</p>
                <p>Failed downloads: {item.failedDownloads}</p>
                <p>Failed conversions: {item.failedConversions}</p>
                <p>Failed extractions: {item.failedExtractions}</p>
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
