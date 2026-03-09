"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

type EventStatus = "pending" | "approved" | "rejected";

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
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
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

export function ModerationDashboard() {
  const [status, setStatus] = useState<EventStatus>("pending");
  const [events, setEvents] = useState<ModerationEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionInFlightFor, setActionInFlightFor] = useState<string | null>(null);

  const emptyStateLabel = useMemo(() => {
    if (status === "pending") return "No pending events for moderation.";
    if (status === "approved") return "No approved events found.";
    return "No rejected events found.";
  }, [status]);

  const fetchEvents = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/events?status=${status}&limit=100`, {
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
  }, [status]);

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

  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Event Moderation</h2>
        <div className="flex items-center gap-2">
          {STATUS_OPTIONS.map((option) => (
            <button
              className={`rounded-md border px-3 py-1 text-xs font-medium uppercase tracking-wide ${
                status === option
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-foreground"
              }`}
              key={option}
              onClick={() => setStatus(option)}
              type="button"
            >
              {option}
            </button>
          ))}
          <button
            className="rounded-md border border-border px-3 py-1 text-xs font-medium"
            onClick={() => void fetchEvents()}
            type="button"
          >
            Refresh
          </button>
        </div>
      </header>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading moderation queue...</p>
      ) : null}

      {!isLoading && events.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyStateLabel}</p>
      ) : null}

      <div className="space-y-3">
        {events.map((event) => {
          const normalizedFields = parseJsonObject(event.normalizedFieldsJson);
          const rawExtraction = parseJsonObject(event.rawExtractionJson);
          const rawExtractedDateText =
            readStringField(normalizedFields, "rawExtractedDateText") ??
            readStringField(rawExtraction, "date");
          const normalizedFinalDate =
            readStringField(normalizedFields, "normalizedDate") ?? event.date;
          const yearSelectionReason = readStringField(
            normalizedFields,
            "dateYearSelectionReason",
          );
          const hasSuspiciousYear = readBooleanField(normalizedFields, "dateSuspiciousYear");
          const fieldConfirmation =
            readObjectField(normalizedFields, "fieldConfirmation") ??
            readObjectField(rawExtraction, "field_confirmation");
          const extractedCity = readStringField(normalizedFields, "city") ?? readStringField(rawExtraction, "city");
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
          const extractedArtists = event.artists.length > 0
            ? event.artists
            : readStringArrayField(rawExtraction, "artists");
          const fieldConfirmationRows = [
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

          return (
            <article className="rounded-md border border-border bg-background p-4" key={event.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <h3 className="text-base font-semibold">{event.title}</h3>
                  <p className="text-xs text-muted-foreground">
                    {event.date}
                    {event.time ? ` at ${event.time}` : ""}
                    {" · "}
                    {event.venue}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {event.eventType}
                    {event.ticketPrice ? ` · ${event.ticketPrice}` : ""}
                  </p>
                  {hasSuspiciousYear ? (
                    <span className="inline-flex rounded-md border border-amber-500 bg-amber-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700">
                      Suspicious year
                    </span>
                  ) : null}
                </div>
                <span className="rounded-md border border-border px-2 py-1 text-xs uppercase tracking-wide">
                  {event.moderation.status}
                </span>
              </div>

              {event.artists.length > 0 ? (
                <p className="mt-2 text-sm">
                  Artists: <span className="text-muted-foreground">{event.artists.join(", ")}</span>
                </p>
              ) : null}

              {event.description ? (
                <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">
                  {event.description}
                </p>
              ) : null}

              <details className="mt-3 rounded-md border border-border p-3 text-xs">
                <summary className="cursor-pointer font-medium">Admin details</summary>
                <div className="mt-2 space-y-2">
                  <div>
                    <p className="font-medium">Caption</p>
                    <p className="whitespace-pre-wrap text-muted-foreground">
                      {event.sourceCaption ?? "(none)"}
                    </p>
                  </div>
                  <div>
                    <p className="font-medium">Post timestamp</p>
                    <p className="text-muted-foreground">{event.sourcePostedAt ?? "(none)"}</p>
                  </div>
                  <div>
                    <p className="font-medium">Raw extracted date text</p>
                    <p className="text-muted-foreground">{rawExtractedDateText ?? "(none)"}</p>
                  </div>
                  <div>
                    <p className="font-medium">Normalized final date</p>
                    <p className="text-muted-foreground">{normalizedFinalDate ?? "(none)"}</p>
                  </div>
                  <div>
                    <p className="font-medium">Year selection reason</p>
                    <p className="text-muted-foreground">{yearSelectionReason ?? "(none)"}</p>
                  </div>
                  {fieldConfirmationRows.some((row) => row.details) ? (
                    <div>
                      <p className="font-medium">Field confirmation</p>
                      <div className="mt-1 space-y-2">
                        {fieldConfirmationRows.map((row) =>
                          row.details ? (
                            <div className="rounded border border-border p-2" key={row.key}>
                              <p className="font-medium">{row.label}</p>
                              <p className="text-muted-foreground">{row.value}</p>
                              <p className="text-muted-foreground">
                                Confidence: {row.details.confidence ?? "(none)"}
                              </p>
                              <p className="text-muted-foreground">
                                Evidence: {row.details.foundIn.join(", ") || "(none)"}
                              </p>
                              <p className="text-muted-foreground">
                                Notes: {row.details.notes ?? "(none)"}
                              </p>
                            </div>
                          ) : null,
                        )}
                      </div>
                    </div>
                  ) : null}
                  <div>
                    <p className="font-medium">Raw extraction JSON</p>
                    <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-muted p-2 text-[11px] leading-relaxed">
                      {prettyJson(event.rawExtractionJson)}
                    </pre>
                  </div>
                  <div>
                    <p className="font-medium">Normalized final fields</p>
                    <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-muted p-2 text-[11px] leading-relaxed">
                      {prettyJson(event.normalizedFieldsJson)}
                    </pre>
                  </div>
                </div>
              </details>

              <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
                <Link className="text-primary underline" href={`/events/${event.id}`}>
                  Open details
                </Link>
                {event.instagramPostUrl ? (
                  <a
                    className="text-primary underline"
                    href={event.instagramPostUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    Open Instagram post
                  </a>
                ) : null}
                {event.moderation.reviewedAt ? (
                  <span className="text-muted-foreground">
                    Reviewed {new Date(event.moderation.reviewedAt).toLocaleString()}
                  </span>
                ) : null}
              </div>

              {status === "pending" ? (
                <div className="mt-3 flex items-center gap-2">
                  <button
                    className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={actionInFlightFor === event.id}
                    onClick={() => void updateStatus(event.id, "approved")}
                    type="button"
                  >
                    Approve
                  </button>
                  <button
                    className="rounded-md border border-destructive px-3 py-1.5 text-xs font-medium text-destructive disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={actionInFlightFor === event.id}
                    onClick={() => void updateStatus(event.id, "rejected")}
                    type="button"
                  >
                    Reject
                  </button>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
