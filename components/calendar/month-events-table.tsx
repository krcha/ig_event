"use client";

import Link from "next/link";
import { ArrowUpDown, ArrowUpRight, Check, ChevronDown, Copy } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "@/lib/utils";

type MonthEventTableEvent = {
  _id: string;
  title: string;
  date: string;
  time?: string;
  venue: string;
  artists: string[];
  eventType: string;
  ticketPrice?: string;
};

type MonthEventsTableProps = {
  events: MonthEventTableEvent[];
  monthLabel: string;
};

type SortKey = "date" | "time" | "title" | "venue" | "eventType" | "ticketPrice" | "artists";
type SortDirection = "asc" | "desc";

const SORTABLE_COLUMNS: { key: SortKey; label: string }[] = [
  { key: "date", label: "Date" },
  { key: "time", label: "Time" },
  { key: "title", label: "Title" },
  { key: "venue", label: "Venue" },
  { key: "eventType", label: "Type" },
  { key: "ticketPrice", label: "Ticket" },
  { key: "artists", label: "Artists" },
];

function parseDateValue(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const parsed = new Date(year, month - 1, day);

  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null;
  }

  return parsed;
}

function parseTimeMinutes(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const match = value.match(/(\d{1,2}):(\d{2})/);
  if (!match) {
    return null;
  }

  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return null;
  }

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }

  return hours * 60 + minutes;
}

function formatEventDate(value: string): string {
  const parsed = parseDateValue(value);
  if (!parsed) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(parsed);
}

function getArtistsLabel(artists: string[]): string {
  return artists.length > 0 ? artists.join(", ") : "TBA";
}

function getSortValue(event: MonthEventTableEvent, key: SortKey): number | string | null {
  switch (key) {
    case "date":
      return event.date;
    case "time":
      return parseTimeMinutes(event.time);
    case "title":
      return event.title.trim().toLocaleLowerCase();
    case "venue":
      return event.venue.trim().toLocaleLowerCase();
    case "eventType":
      return event.eventType.trim().toLocaleLowerCase();
    case "ticketPrice":
      return event.ticketPrice?.trim().toLocaleLowerCase() ?? null;
    case "artists":
      return getArtistsLabel(event.artists).toLocaleLowerCase();
    default:
      return null;
  }
}

function compareDefaultOrder(left: MonthEventTableEvent, right: MonthEventTableEvent): number {
  const dateResult = left.date.localeCompare(right.date);
  if (dateResult !== 0) {
    return dateResult;
  }

  const timeResult = (parseTimeMinutes(left.time) ?? Number.MAX_SAFE_INTEGER) -
    (parseTimeMinutes(right.time) ?? Number.MAX_SAFE_INTEGER);
  if (timeResult !== 0) {
    return timeResult;
  }

  const titleResult = left.title.localeCompare(right.title, undefined, {
    sensitivity: "base",
  });
  if (titleResult !== 0) {
    return titleResult;
  }

  return left._id.localeCompare(right._id);
}

function compareEvents(
  left: MonthEventTableEvent,
  right: MonthEventTableEvent,
  sortKey: SortKey,
  direction: SortDirection,
): number {
  const leftValue = getSortValue(left, sortKey);
  const rightValue = getSortValue(right, sortKey);

  if (leftValue == null && rightValue == null) {
    return compareDefaultOrder(left, right);
  }

  if (leftValue == null) {
    return 1;
  }

  if (rightValue == null) {
    return -1;
  }

  let result = 0;
  if (typeof leftValue === "number" && typeof rightValue === "number") {
    result = leftValue - rightValue;
  } else {
    result = String(leftValue).localeCompare(String(rightValue), undefined, {
      numeric: true,
      sensitivity: "base",
    });
  }

  if (result === 0) {
    result = compareDefaultOrder(left, right);
  }

  return direction === "asc" ? result : result * -1;
}

function formatCopyText(events: MonthEventTableEvent[]): string {
  const header = ["Date", "Time", "Title", "Venue", "Type", "Ticket", "Artists"];
  const rows = events.map((event) => [
    formatEventDate(event.date),
    event.time ?? "Time TBA",
    event.title,
    event.venue,
    event.eventType,
    event.ticketPrice ?? "TBA",
    getArtistsLabel(event.artists),
  ]);

  return [header, ...rows].map((row) => row.join("\t")).join("\n");
}

export function MonthEventsTable({ events, monthLabel }: MonthEventsTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [isExpanded, setIsExpanded] = useState(false);

  const sortedEvents = useMemo(() => {
    return [...events].sort((left, right) => compareEvents(left, right, sortKey, sortDirection));
  }, [events, sortDirection, sortKey]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
      return;
    }

    setSortKey(key);
    setSortDirection("asc");
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(formatCopyText(sortedEvents));
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  };

  return (
    <div className="border-t border-border/80 bg-background/72 px-4 py-4 sm:px-5 sm:py-5">
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-0.5">
            <p className="section-kicker">Month list</p>
            <h3 className="text-lg font-semibold tracking-tight">{monthLabel} event list</h3>
            <p className="text-sm text-muted-foreground">
              {events.length} event{events.length === 1 ? "" : "s"} matching the current month and filters.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              aria-controls="month-events-table-panel"
              aria-expanded={isExpanded}
              className="button-secondary h-11 gap-2 px-4 py-0 text-sm"
              onClick={() => setIsExpanded((current) => !current)}
              type="button"
            >
              <span>{isExpanded ? "Hide month list" : "Show month list"}</span>
              <ChevronDown
                className={cn("h-4 w-4 transition", isExpanded && "rotate-180")}
              />
            </button>
          </div>
        </div>
      </div>

      {!isExpanded ? (
        <div className="mt-4 rounded-[1.4rem] border border-dashed border-border/80 bg-card/88 px-4 py-6 text-center">
          <p className="text-sm text-muted-foreground">
            Month list is collapsed by default. Expand it to browse all {sortedEvents.length} event
            {sortedEvents.length === 1 ? "" : "s"} for {monthLabel}.
          </p>
        </div>
      ) : sortedEvents.length === 0 ? (
        <div className="mt-4 rounded-[1.4rem] border border-dashed border-border/80 bg-card/88 px-4 py-8 text-center">
          <p className="text-sm text-muted-foreground">No events to list for this month.</p>
        </div>
      ) : (
        <div className="mt-4 space-y-4" id="month-events-table-panel">
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            <div className="grid gap-2 sm:flex sm:flex-wrap sm:items-center">
              <label className="flex min-w-[11rem] flex-col gap-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Sort by
                <select
                  className="h-11 rounded-2xl border border-border/80 bg-card px-3 text-sm font-medium tracking-normal text-foreground"
                  onChange={(event) => setSortKey(event.target.value as SortKey)}
                  value={sortKey}
                >
                  {SORTABLE_COLUMNS.map((column) => (
                    <option key={column.key} value={column.key}>
                      {column.label}
                    </option>
                  ))}
                </select>
              </label>

              <button
                className="button-secondary h-11 gap-2 px-4 py-0 text-sm"
                onClick={() =>
                  setSortDirection((current) => (current === "asc" ? "desc" : "asc"))
                }
                type="button"
              >
                <ArrowUpDown className="h-4 w-4" />
                {sortDirection === "asc" ? "Ascending" : "Descending"}
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {copyState === "copied" ? (
                <span className="app-chip text-primary">
                  <Check className="h-3.5 w-3.5" />
                  Copied {sortedEvents.length} rows
                </span>
              ) : null}
              {copyState === "error" ? (
                <span className="app-chip text-destructive">Clipboard access failed</span>
              ) : null}
              <button
                className="button-secondary h-11 gap-2 px-4 py-0 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                disabled={sortedEvents.length === 0}
                onClick={handleCopy}
                type="button"
              >
                {copyState === "copied" ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
                Copy list
              </button>
            </div>
          </div>

          <div className="mt-4 space-y-3 lg:hidden">
            {sortedEvents.map((event) => (
              <article
                className="rounded-[1.35rem] border border-border/80 bg-card/95 px-4 py-4 shadow-[0_18px_36px_-30px_rgba(15,23,42,0.18)]"
                key={event._id}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-foreground">{formatEventDate(event.date)}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{event.time ?? "Time TBA"}</p>
                  </div>
                  <span className="app-chip">{event.eventType}</span>
                </div>

                <Link
                  className="mt-4 inline-flex items-start gap-2 text-base font-semibold tracking-tight text-foreground hover:text-primary"
                  href={`/events/${event._id}`}
                >
                  <span>{event.title}</span>
                  <ArrowUpRight className="mt-0.5 h-3.5 w-3.5 flex-none" />
                </Link>

                <p className="mt-2 text-sm text-muted-foreground">{event.venue}</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  Ticket: {event.ticketPrice ?? "TBA"}
                </p>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  Artists: {getArtistsLabel(event.artists)}
                </p>
              </article>
            ))}
          </div>

          <div className="mt-4 hidden overflow-x-auto rounded-[1.4rem] border border-border/80 bg-card/95 shadow-[0_24px_65px_-45px_rgba(15,23,42,0.28)] lg:block">
            <table className="min-w-[68rem] table-fixed border-collapse">
              <thead className="bg-muted/[0.4]">
                <tr>
                  {SORTABLE_COLUMNS.map((column) => {
                    const isActive = sortKey === column.key;

                    return (
                      <th
                        className="border-b border-border/80 px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground"
                        key={column.key}
                        scope="col"
                      >
                        <button
                          className={cn(
                            "inline-flex items-center gap-1.5 hover:text-foreground",
                            isActive && "text-foreground",
                          )}
                          onClick={() => handleSort(column.key)}
                          type="button"
                        >
                          <span>{column.label}</span>
                          <ArrowUpDown className="h-3.5 w-3.5" />
                          {isActive ? (
                            <span className="text-[10px] tracking-[0.12em]">
                              {sortDirection === "asc" ? "ASC" : "DESC"}
                            </span>
                          ) : null}
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {sortedEvents.map((event, index) => (
                  <tr
                    className={cn(
                      "border-b border-border/70 last:border-b-0",
                      index % 2 === 0 ? "bg-card/95" : "bg-background/72",
                    )}
                    key={event._id}
                  >
                    <td className="px-3 py-3 text-sm font-medium text-foreground">
                      {formatEventDate(event.date)}
                    </td>
                    <td className="px-3 py-3 text-sm text-muted-foreground">{event.time ?? "Time TBA"}</td>
                    <td className="px-3 py-3 text-sm">
                      <Link
                        className="inline-flex items-center gap-1.5 font-semibold text-foreground hover:text-primary"
                        href={`/events/${event._id}`}
                      >
                        <span className="truncate">{event.title}</span>
                        <ArrowUpRight className="h-3.5 w-3.5 flex-none" />
                      </Link>
                    </td>
                    <td className="px-3 py-3 text-sm text-foreground">{event.venue}</td>
                    <td className="px-3 py-3 text-sm text-muted-foreground">{event.eventType}</td>
                    <td className="px-3 py-3 text-sm text-muted-foreground">
                      {event.ticketPrice ?? "TBA"}
                    </td>
                    <td className="px-3 py-3 text-sm text-muted-foreground">
                      {getArtistsLabel(event.artists)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
