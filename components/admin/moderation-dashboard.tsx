"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

type EventStatus = "pending" | "approved" | "rejected";
type ModerationSortMode = "newest" | "updated" | "event_date";
type ModerationFilterMode =
  | "all"
  | "issues"
  | "suspicious_year"
  | "low_confidence"
  | "fallback_title"
  | "missing_image"
  | "missing_time";

type ModerationEvent = {
  id: string;
  title: string;
  date: string;
  time: string | null;
  venue: string;
  artists: string[];
  description: string | null;
  imageUrl: string | null;
  instagramPostUrl: string | null;
  ticketPrice: string | null;
  eventType: string;
  sourceCaption: string | null;
  sourcePostedAt: string | null;
  rawExtractionJson: string | null;
  normalizedFieldsJson: string | null;
  moderation: {
    status: EventStatus;
    reviewedAt: number | null;
    reviewedBy: string | null;
    moderationNote: string | null;
  };
  createdAt: number;
  updatedAt: number;
};

type EventsResponse = {
  status: EventStatus;
  events: ModerationEvent[];
  error?: string;
};

type FieldConfirmationRow = {
  key: string;
  label: string;
  value: string;
  details: {
    confidence: string | number | null;
    foundIn: string[];
    notes: string | null;
  } | null;
};

type DecoratedEvent = ModerationEvent & {
  normalizedFields: Record<string, unknown> | null;
  rawExtraction: Record<string, unknown> | null;
  rawExtractedDateText: string | null;
  normalizedFinalDate: string | null;
  yearSelectionReason: string | null;
  hasSuspiciousYear: boolean;
  confidenceScore: number | null;
  titleUsedFallback: boolean;
  missingImage: boolean;
  missingTime: boolean;
  hasIssues: boolean;
  fieldConfirmationRows: FieldConfirmationRow[];
  searchText: string;
};

const STATUS_OPTIONS: EventStatus[] = ["pending", "approved", "rejected"];

function prettyJson(value: string | null): string {
  if (!value) {
    return "(none)";
  }
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
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

function readStringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readBooleanField(record: Record<string, unknown> | null, key: string): boolean {
  return record?.[key] === true;
}

function readObjectField(
  record: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  const value = record?.[key];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function readStringArrayField(record: Record<string, unknown> | null, key: string): string[] {
  const value = record?.[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
}

function readNumberOrStringField(
  record: Record<string, unknown> | null,
  key: string,
): string | number | null {
  const value = record?.[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return null;
}

function readNumericField(record: Record<string, unknown> | null, key: string): number | null {
  const value = readNumberOrStringField(record, key);
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readFieldConfirmationEntry(
  record: Record<string, unknown> | null,
  key: string,
): {
  confidence: string | number | null;
  foundIn: string[];
  notes: string | null;
} | null {
  const entry = readObjectField(record, key);
  if (!entry) {
    return null;
  }
  return {
    confidence: readNumberOrStringField(entry, "confidence"),
    foundIn: readStringArrayField(entry, "found_in"),
    notes: readStringField(entry, "notes"),
  };
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().trim();
}

function formatDateTime(value: number | null): string {
  if (!value) {
    return "(none)";
  }
  return new Date(value).toLocaleString();
}

function buildFieldConfirmationRows(
  event: ModerationEvent,
  normalizedFields: Record<string, unknown> | null,
  rawExtraction: Record<string, unknown> | null,
): FieldConfirmationRow[] {
  const fieldConfirmation =
    readObjectField(normalizedFields, "fieldConfirmation") ??
    readObjectField(rawExtraction, "field_confirmation");
  const extractedCity =
    readStringField(normalizedFields, "city") ?? readStringField(rawExtraction, "city");
  const extractedCountry =
    readStringField(normalizedFields, "country") ?? readStringField(rawExtraction, "country");
  const locationValue = [extractedCity, extractedCountry]
    .filter((value): value is string => Boolean(value))
    .join(", ");
  const rawPrice = readStringField(rawExtraction, "price");
  const rawCurrency = readStringField(rawExtraction, "currency");
  const priceValue = event.ticketPrice ?? [rawPrice, rawCurrency]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  const extractedArtists =
    event.artists.length > 0 ? event.artists : readStringArrayField(rawExtraction, "artists");

  return [
    {
      key: "title",
      label: "Title of event",
      value: event.title || readStringField(rawExtraction, "title") || "(none)",
    },
    {
      key: "location",
      label: "Location",
      value: locationValue || "(none)",
    },
    {
      key: "location_name",
      label: "Location name",
      value: event.venue || readStringField(rawExtraction, "venue") || "(none)",
    },
    {
      key: "price",
      label: "Price",
      value: priceValue || "(none)",
    },
    {
      key: "start_time",
      label: "Start time",
      value: event.time || readStringField(rawExtraction, "time") || "(none)",
    },
    {
      key: "short_description",
      label: "Short description",
      value: event.description || readStringField(rawExtraction, "description") || "(none)",
    },
    {
      key: "artists",
      label: "Artists",
      value: extractedArtists.length > 0 ? extractedArtists.join(", ") : "(none)",
    },
  ].map((row) => ({
    ...row,
    details: readFieldConfirmationEntry(fieldConfirmation, row.key),
  }));
}

function decorateEvent(event: ModerationEvent): DecoratedEvent {
  const normalizedFields = parseJsonObject(event.normalizedFieldsJson);
  const rawExtraction = parseJsonObject(event.rawExtractionJson);
  const confidenceScore =
    readNumericField(normalizedFields, "confidence") ??
    readNumericField(rawExtraction, "confidence");
  const hasSuspiciousYear = readBooleanField(normalizedFields, "dateSuspiciousYear");
  const titleUsedFallback = readBooleanField(normalizedFields, "titleUsedFallback");
  const missingImage = !event.imageUrl;
  const missingTime = !event.time;
  const lowConfidence = confidenceScore !== null && confidenceScore < 0.7;
  const fieldConfirmationRows = buildFieldConfirmationRows(
    event,
    normalizedFields,
    rawExtraction,
  );

  return {
    ...event,
    normalizedFields,
    rawExtraction,
    rawExtractedDateText:
      readStringField(normalizedFields, "rawExtractedDateText") ??
      readStringField(rawExtraction, "date"),
    normalizedFinalDate: readStringField(normalizedFields, "normalizedDate") ?? event.date,
    yearSelectionReason: readStringField(normalizedFields, "dateYearSelectionReason"),
    hasSuspiciousYear,
    confidenceScore,
    titleUsedFallback,
    missingImage,
    missingTime,
    hasIssues: hasSuspiciousYear || titleUsedFallback || lowConfidence || missingImage,
    fieldConfirmationRows,
    searchText: normalizeSearchText(
      [
        event.title,
        event.venue,
        event.eventType,
        event.description ?? "",
        event.sourceCaption ?? "",
        event.artists.join(" "),
      ].join(" "),
    ),
  };
}

export function ModerationDashboard() {
  const [status, setStatus] = useState<EventStatus>("pending");
  const [limit, setLimit] = useState("100");
  const [events, setEvents] = useState<ModerationEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionInFlightFor, setActionInFlightFor] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortMode, setSortMode] = useState<ModerationSortMode>("newest");
  const [filterMode, setFilterMode] = useState<ModerationFilterMode>("all");

  const emptyStateLabel = useMemo(() => {
    if (status === "pending") return "No pending events for moderation.";
    if (status === "approved") return "No approved events found.";
    return "No rejected events found.";
  }, [status]);

  const fetchEvents = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/events?status=${status}&limit=${limit}`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as EventsResponse;
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to load moderation events.");
      }
      setEvents(payload.events);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unknown moderation load error.",
      );
      setEvents([]);
    } finally {
      setIsLoading(false);
    }
  }, [limit, status]);

  useEffect(() => {
    void fetchEvents();
  }, [fetchEvents]);

  async function updateStatus(eventId: string, nextStatus: "approved" | "rejected") {
    setActionInFlightFor(eventId);
    setError(null);

    const moderationNote =
      nextStatus === "rejected"
        ? window.prompt("Optional rejection note:", "") ?? undefined
        : undefined;

    try {
      const response = await fetch("/api/admin/events/moderate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          eventId,
          status: nextStatus,
          moderationNote,
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to update event moderation.");
      }

      await fetchEvents();
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unknown moderation update error.",
      );
    } finally {
      setActionInFlightFor(null);
    }
  }

  async function copyText(value: string, label: string) {
    if (!value) {
      setError(`No ${label.toLowerCase()} available to copy.`);
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      setError(`Failed to copy ${label.toLowerCase()}.`);
    }
  }

  const decoratedEvents = useMemo(() => events.map((event) => decorateEvent(event)), [events]);

  const filteredEvents = useMemo(() => {
    const query = normalizeSearchText(searchQuery);
    const next = decoratedEvents.filter((event) => {
      if (query && !event.searchText.includes(query)) {
        return false;
      }
      if (filterMode === "issues" && !event.hasIssues) {
        return false;
      }
      if (filterMode === "suspicious_year" && !event.hasSuspiciousYear) {
        return false;
      }
      if (
        filterMode === "low_confidence" &&
        !(event.confidenceScore !== null && event.confidenceScore < 0.7)
      ) {
        return false;
      }
      if (filterMode === "fallback_title" && !event.titleUsedFallback) {
        return false;
      }
      if (filterMode === "missing_image" && !event.missingImage) {
        return false;
      }
      if (filterMode === "missing_time" && !event.missingTime) {
        return false;
      }
      return true;
    });

    next.sort((left, right) => {
      if (sortMode === "event_date") {
        return left.date.localeCompare(right.date);
      }
      if (sortMode === "updated") {
        return right.updatedAt - left.updatedAt;
      }
      return right.createdAt - left.createdAt;
    });

    return next;
  }, [decoratedEvents, filterMode, searchQuery, sortMode]);

  const stats = useMemo(
    () => ({
      loaded: decoratedEvents.length,
      visible: filteredEvents.length,
      issues: decoratedEvents.filter((event) => event.hasIssues).length,
      suspiciousYear: decoratedEvents.filter((event) => event.hasSuspiciousYear).length,
      fallbackTitle: decoratedEvents.filter((event) => event.titleUsedFallback).length,
      missingImage: decoratedEvents.filter((event) => event.missingImage).length,
    }),
    [decoratedEvents, filteredEvents.length],
  );

  return (
    <section className="space-y-6 rounded-3xl border border-border bg-card p-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        {[
          ["Loaded", stats.loaded],
          ["Visible", stats.visible],
          ["Needs attention", stats.issues],
          ["Suspicious year", stats.suspiciousYear],
          ["Fallback title", stats.fallbackTitle],
          ["Missing image", stats.missingImage],
        ].map(([label, value]) => (
          <div className="rounded-2xl border border-border bg-background/80 p-4" key={label}>
            <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">{label}</p>
            <p className="mt-2 text-3xl font-semibold">{value}</p>
          </div>
        ))}
      </div>

      <section className="space-y-4 rounded-2xl border border-border bg-background/70 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Review queue</h2>
            <p className="text-sm text-muted-foreground">
              Filter the queue by confidence, title fallback, missing media, and event date issues.
            </p>
          </div>
          <button
            className="rounded-xl border border-border px-4 py-2 text-sm font-medium"
            onClick={() => void fetchEvents()}
            type="button"
          >
            Refresh
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          {STATUS_OPTIONS.map((option) => (
            <button
              className={`rounded-full px-4 py-2 text-xs font-medium uppercase tracking-[0.22em] ${
                status === option
                  ? "bg-primary text-primary-foreground"
                  : "border border-border bg-background text-foreground"
              }`}
              key={option}
              onClick={() => setStatus(option)}
              type="button"
            >
              {option}
            </button>
          ))}
        </div>

        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_220px_220px_160px]">
          <input
            className="rounded-xl border border-input bg-background px-3 py-2 text-sm"
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search title, venue, artist, caption, or description"
            value={searchQuery}
          />
          <select
            className="rounded-xl border border-input bg-background px-3 py-2 text-sm"
            onChange={(event) => setFilterMode(event.target.value as ModerationFilterMode)}
            value={filterMode}
          >
            <option value="all">All events</option>
            <option value="issues">Needs attention</option>
            <option value="suspicious_year">Suspicious year</option>
            <option value="low_confidence">Low confidence</option>
            <option value="fallback_title">Fallback title</option>
            <option value="missing_image">Missing image</option>
            <option value="missing_time">Missing time</option>
          </select>
          <select
            className="rounded-xl border border-input bg-background px-3 py-2 text-sm"
            onChange={(event) => setSortMode(event.target.value as ModerationSortMode)}
            value={sortMode}
          >
            <option value="newest">Newest created</option>
            <option value="updated">Recently updated</option>
            <option value="event_date">Event date ascending</option>
          </select>
          <select
            className="rounded-xl border border-input bg-background px-3 py-2 text-sm"
            onChange={(event) => setLimit(event.target.value)}
            value={limit}
          >
            <option value="25">25 items</option>
            <option value="50">50 items</option>
            <option value="100">100 items</option>
            <option value="200">200 items</option>
          </select>
        </div>
      </section>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading moderation queue...</p>
      ) : null}

      {!isLoading && decoratedEvents.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyStateLabel}</p>
      ) : null}

      {!isLoading && decoratedEvents.length > 0 && filteredEvents.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No events match the current moderation filters.
        </p>
      ) : null}

      <div className="space-y-4">
        {filteredEvents.map((event) => (
          <article
            className="overflow-hidden rounded-3xl border border-border bg-background/80"
            key={event.id}
          >
            <div className="grid gap-0 lg:grid-cols-[220px_minmax(0,1fr)]">
              <div className="border-b border-border bg-muted lg:border-b-0 lg:border-r">
                {event.imageUrl ? (
                  <a href={event.imageUrl} rel="noreferrer" target="_blank">
                    <Image
                      alt={event.title}
                      className="h-56 w-full object-cover lg:h-full"
                      height={720}
                      src={event.imageUrl}
                      width={720}
                    />
                  </a>
                ) : (
                  <div className="flex h-56 items-center justify-center px-6 text-center text-sm text-muted-foreground lg:h-full">
                    No poster image available for this event.
                  </div>
                )}
              </div>

              <div className="space-y-4 p-5">
                <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                  <div className="space-y-2">
                    <div className="flex flex-wrap gap-2">
                      <span className="rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        {event.moderation.status}
                      </span>
                      <span className="rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        {event.eventType}
                      </span>
                      {event.hasSuspiciousYear ? (
                        <span className="rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-amber-800">
                          Suspicious year
                        </span>
                      ) : null}
                      {event.confidenceScore !== null && event.confidenceScore < 0.7 ? (
                        <span className="rounded-full bg-rose-100 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-rose-800">
                          Low confidence
                        </span>
                      ) : null}
                      {event.titleUsedFallback ? (
                        <span className="rounded-full bg-sky-100 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-sky-800">
                          Fallback title
                        </span>
                      ) : null}
                      {event.missingTime ? (
                        <span className="rounded-full bg-slate-200 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-slate-700">
                          Missing time
                        </span>
                      ) : null}
                    </div>
                    <div>
                      <h3 className="text-xl font-semibold tracking-tight">{event.title}</h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {event.date}
                        {event.time ? ` at ${event.time}` : ""}
                        {" · "}
                        {event.venue}
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Queued {formatDateTime(event.createdAt)}
                        {" · "}
                        Updated {formatDateTime(event.updatedAt)}
                      </p>
                    </div>
                  </div>

                  <div className="text-sm text-muted-foreground xl:text-right">
                    <p>
                      Confidence{" "}
                      <span className="font-medium text-foreground">
                        {event.confidenceScore ?? "(none)"}
                      </span>
                    </p>
                    {event.ticketPrice ? <p className="mt-1">{event.ticketPrice}</p> : null}
                  </div>
                </div>

                {event.artists.length > 0 ? (
                  <p className="text-sm">
                    Artists:{" "}
                    <span className="text-muted-foreground">{event.artists.join(", ")}</span>
                  </p>
                ) : null}

                {event.description ? (
                  <p className="text-sm leading-6 text-muted-foreground">{event.description}</p>
                ) : null}

                <div className="flex flex-wrap gap-2 text-sm">
                  <Link
                    className="rounded-xl border border-border px-3 py-2 font-medium"
                    href={`/events/${event.id}`}
                  >
                    Open details
                  </Link>
                  {event.instagramPostUrl ? (
                    <a
                      className="rounded-xl border border-border px-3 py-2 font-medium"
                      href={event.instagramPostUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      Open Instagram post
                    </a>
                  ) : null}
                  <button
                    className="rounded-xl border border-border px-3 py-2 font-medium"
                    onClick={() => void copyText(event.sourceCaption ?? "", "Caption")}
                    type="button"
                  >
                    Copy caption
                  </button>
                  <button
                    className="rounded-xl border border-border px-3 py-2 font-medium"
                    onClick={() =>
                      void copyText(prettyJson(event.normalizedFieldsJson), "Normalized fields")
                    }
                    type="button"
                  >
                    Copy normalized fields
                  </button>
                </div>

                <details className="rounded-2xl border border-border p-4 text-sm">
                  <summary className="cursor-pointer font-medium">Admin details</summary>
                  <div className="mt-4 space-y-4">
                    <div className="grid gap-3 lg:grid-cols-3">
                      <div className="rounded-xl border border-border p-3">
                        <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                          Post timestamp
                        </p>
                        <p className="mt-1 text-sm">{event.sourcePostedAt ?? "(none)"}</p>
                      </div>
                      <div className="rounded-xl border border-border p-3">
                        <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                          Raw extracted date
                        </p>
                        <p className="mt-1 text-sm">{event.rawExtractedDateText ?? "(none)"}</p>
                      </div>
                      <div className="rounded-xl border border-border p-3">
                        <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                          Final normalized date
                        </p>
                        <p className="mt-1 text-sm">{event.normalizedFinalDate ?? "(none)"}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {event.yearSelectionReason ?? "(no year rule)"}
                        </p>
                      </div>
                    </div>

                    {event.fieldConfirmationRows.some((row) => row.details) ? (
                      <div className="space-y-3">
                        <p className="font-medium">Field confirmation</p>
                        <div className="grid gap-3 xl:grid-cols-2">
                          {event.fieldConfirmationRows.map((row) =>
                            row.details ? (
                              <div className="rounded-xl border border-border p-3" key={row.key}>
                                <p className="font-medium">{row.label}</p>
                                <p className="mt-1 text-sm text-muted-foreground">{row.value}</p>
                                <p className="mt-2 text-xs text-muted-foreground">
                                  Confidence: {row.details.confidence ?? "(none)"}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  Evidence: {row.details.foundIn.join(", ") || "(none)"}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  Notes: {row.details.notes ?? "(none)"}
                                </p>
                              </div>
                            ) : null,
                          )}
                        </div>
                      </div>
                    ) : null}

                    <div>
                      <p className="font-medium">Caption</p>
                      <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                        {event.sourceCaption ?? "(none)"}
                      </p>
                    </div>

                    <div className="grid gap-3 xl:grid-cols-2">
                      <div>
                        <p className="font-medium">Raw extraction JSON</p>
                        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded-xl bg-muted p-3 text-[11px] leading-relaxed">
                          {prettyJson(event.rawExtractionJson)}
                        </pre>
                      </div>
                      <div>
                        <p className="font-medium">Normalized final fields</p>
                        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded-xl bg-muted p-3 text-[11px] leading-relaxed">
                          {prettyJson(event.normalizedFieldsJson)}
                        </pre>
                      </div>
                    </div>
                  </div>
                </details>

                {status === "pending" ? (
                  <div className="flex flex-wrap gap-2">
                    <button
                      className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={actionInFlightFor === event.id}
                      onClick={() => void updateStatus(event.id, "approved")}
                      type="button"
                    >
                      Approve
                    </button>
                    <button
                      className="rounded-xl border border-destructive px-4 py-2 text-sm font-medium text-destructive disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={actionInFlightFor === event.id}
                      onClick={() => void updateStatus(event.id, "rejected")}
                      type="button"
                    >
                      Reject
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
