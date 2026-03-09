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
        {events.map((event) => (
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
        ))}
      </div>
    </section>
  );
}
