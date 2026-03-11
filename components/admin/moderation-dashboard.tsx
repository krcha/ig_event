"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AUTO_APPROVE_CONFIDENCE_THRESHOLD,
  calculateModerationConfidenceScore,
  DUPLICATE_CONFIDENCE_MULTIPLIER,
  formatConfidenceScore,
  MISSING_IMAGE_CONFIDENCE_PENALTY,
  normalizeConfidencePayload,
  normalizeConfidenceScore,
} from "@/lib/utils/confidence";

type EventStatus = "pending" | "approved" | "rejected";
type ModerationSortMode =
  | "newest"
  | "updated"
  | "event_date"
  | "confidence_desc"
  | "confidence_asc";
type ModerationFilterMode =
  | "all"
  | "issues"
  | "suspected_duplicates"
  | "suspicious_year"
  | "low_confidence"
  | "fallback_title"
  | "missing_image"
  | "missing_time";
type ConfidenceFilterMode = "all" | "high" | "medium" | "low" | "missing";

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
  duplicateContextEvents?: ModerationEvent[];
  error?: string;
};

type MasterReviewCandidateEvent = {
  id: string;
  title: string;
  date: string;
  time: string | null;
  venue: string;
  artists: string[];
  description: string | null;
  imageUrl: string | null;
  ticketPrice: string | null;
  eventType: string;
};

type MasterReviewPrimaryPatch = {
  title: string;
  date: string;
  time: string;
  venue: string;
  artists: string[];
  description: string;
  ticketPrice: string;
  eventType: string;
  imageUrl: string;
};

type MasterReviewGroup = {
  groupId: string;
  confidence: number | null;
  reasoning: string;
  recommendedAction: "merge_delete" | "delete_only";
  primaryEventId: string;
  duplicateEventIds: string[];
  primaryPatch: MasterReviewPrimaryPatch;
  candidateEvents: MasterReviewCandidateEvent[];
};

type MasterReviewResponse = {
  overview: string;
  activeEventCount: number;
  candidateGroupCount: number;
  generatedAt: string;
  reviewGroups: MasterReviewGroup[];
  error?: string;
};

type FieldConfirmationRow = {
  key: string;
  label: string;
  value: string;
  details: {
    confidence: number | null;
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
  baseConfidenceScore: number | null;
  confidenceScore: number | null;
  titleUsedFallback: boolean;
  missingImage: boolean;
  missingTime: boolean;
  hasIssues: boolean;
  suspectedDuplicateIds: string[];
  suspectedDuplicateCount: number;
  hasResolvedDuplicate: boolean;
  fieldConfirmationRows: FieldConfirmationRow[];
  searchText: string;
  duplicateDateKey: string | null;
  duplicateVenueText: string;
  duplicateTitleText: string;
  duplicateArtistText: string;
  duplicateDescriptionText: string;
};

const STATUS_OPTIONS: EventStatus[] = ["pending", "approved", "rejected"];
const BULK_APPROVE_ACTION_ID = "__bulk_approve__";
const SERBIAN_CYRILLIC_TO_LATIN: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  ђ: "dj",
  е: "e",
  ж: "z",
  з: "z",
  и: "i",
  ј: "j",
  к: "k",
  л: "l",
  љ: "lj",
  м: "m",
  н: "n",
  њ: "nj",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  ћ: "c",
  у: "u",
  ф: "f",
  х: "h",
  ц: "c",
  ч: "c",
  џ: "dz",
  ш: "s",
};
const SERBIAN_LATIN_TO_ASCII: Record<string, string> = {
  đ: "dj",
  č: "c",
  ć: "c",
  ž: "z",
  š: "s",
};
const DUPLICATE_VENUE_STOP_WORDS = new Set([
  "beograd",
  "belgrade",
  "club",
  "klub",
  "dom",
  "kulture",
  "serbia",
  "srbija",
]);
const DUPLICATE_TEXT_STOP_WORDS = new Set([
  "belgrade",
  "beograd",
  "serbia",
  "srbija",
  "event",
  "party",
  "concert",
  "live",
  "music",
  "night",
  "official",
  "ulaz",
  "slobodan",
  "free",
  "entry",
]);

function prettyJson(value: string | null): string {
  if (!value) {
    return "(none)";
  }
  try {
    return JSON.stringify(normalizeConfidencePayload(JSON.parse(value)), null, 2);
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

function readFieldConfirmationEntry(
  record: Record<string, unknown> | null,
  key: string,
): {
  confidence: number | null;
  foundIn: string[];
  notes: string | null;
} | null {
  const entry = readObjectField(record, key);
  if (!entry) {
    return null;
  }
  return {
    confidence: normalizeConfidenceScore(readNumberOrStringField(entry, "confidence")),
    foundIn: readStringArrayField(entry, "found_in"),
    notes: readStringField(entry, "notes"),
  };
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().trim();
}

function normalizeComparisonText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[đčćžš]/g, (character) => {
      return SERBIAN_LATIN_TO_ASCII[character] ?? character;
    })
    .replace(/[\u0400-\u04ff]/g, (character) => {
      return SERBIAN_CYRILLIC_TO_LATIN[character] ?? character;
    })
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getSimilarityRatio(
  left: string,
  right: string,
  stopWords: Set<string>,
): number {
  if (!left || !right) {
    return 0;
  }

  const leftTokens = [
    ...new Set(
      left
        .split(" ")
        .filter((token) => token.length > 1 && !stopWords.has(token)),
    ),
  ];
  const rightTokens = [
    ...new Set(
      right
        .split(" ")
        .filter((token) => token.length > 1 && !stopWords.has(token)),
    ),
  ];
  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return 0;
  }

  const rightTokenSet = new Set(rightTokens);
  let sharedCount = 0;
  for (const token of leftTokens) {
    if (rightTokenSet.has(token)) {
      sharedCount += 1;
    }
  }

  return sharedCount / Math.min(leftTokens.length, rightTokens.length);
}

function areSimilarVenues(left: string, right: string): boolean {
  if (!left || !right) {
    return false;
  }
  if (left === right) {
    return true;
  }
  if (left.includes(right) || right.includes(left)) {
    return true;
  }
  return getSimilarityRatio(left, right, DUPLICATE_VENUE_STOP_WORDS) >= 0.72;
}

function areSimilarDuplicateTexts(left: string, right: string): boolean {
  if (!left || !right) {
    return false;
  }
  if (left === right) {
    return true;
  }

  const shorterLength = Math.min(left.length, right.length);
  if (shorterLength >= 24 && (left.includes(right) || right.includes(left))) {
    return true;
  }

  return getSimilarityRatio(left, right, DUPLICATE_TEXT_STOP_WORDS) >= 0.6;
}

function areSuspectedDuplicateEvents(left: DecoratedEvent, right: DecoratedEvent): boolean {
  if (!left.duplicateDateKey || left.duplicateDateKey !== right.duplicateDateKey) {
    return false;
  }
  if (!areSimilarVenues(left.duplicateVenueText, right.duplicateVenueText)) {
    return false;
  }

  if (
    areSimilarDuplicateTexts(left.duplicateTitleText, right.duplicateTitleText) ||
    areSimilarDuplicateTexts(left.duplicateArtistText, right.duplicateArtistText) ||
    areSimilarDuplicateTexts(left.duplicateDescriptionText, right.duplicateDescriptionText)
  ) {
    return true;
  }

  return (
    (left.missingTime && right.missingTime) ||
    left.titleUsedFallback ||
    right.titleUsedFallback
  );
}

function attachSuspectedDuplicateGroups(events: DecoratedEvent[]): DecoratedEvent[] {
  const adjacentIds = new Map<string, Set<string>>();
  const eventsById = new Map(events.map((event) => [event.id, event] as const));
  for (const event of events) {
    adjacentIds.set(event.id, new Set());
  }

  for (let leftIndex = 0; leftIndex < events.length; leftIndex += 1) {
    const left = events[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < events.length; rightIndex += 1) {
      const right = events[rightIndex];
      if (!areSuspectedDuplicateEvents(left, right)) {
        continue;
      }
      adjacentIds.get(left.id)?.add(right.id);
      adjacentIds.get(right.id)?.add(left.id);
    }
  }

  return events.map((event) => {
    const suspectedDuplicateIds = [...(adjacentIds.get(event.id) ?? [])];
    const hasResolvedDuplicate =
      event.moderation.status === "pending" &&
      suspectedDuplicateIds.some((id) => {
        const duplicate = eventsById.get(id);
        return duplicate ? duplicate.moderation.status !== "pending" : false;
      });
    const confidenceScore = hasResolvedDuplicate
      ? 0
      : calculateModerationConfidenceScore(event.baseConfidenceScore, {
          hasSuspectedDuplicates: suspectedDuplicateIds.length > 0,
          missingImage: event.missingImage,
        });
    const lowConfidence = confidenceScore !== null && confidenceScore < 0.7;
    return {
      ...event,
      confidenceScore,
      suspectedDuplicateIds,
      suspectedDuplicateCount: suspectedDuplicateIds.length,
      hasResolvedDuplicate,
      hasIssues:
        event.hasSuspiciousYear ||
        event.titleUsedFallback ||
        lowConfidence ||
        event.missingImage ||
        suspectedDuplicateIds.length > 0,
    };
  });
}

function formatDateTime(value: number | null): string {
  if (!value) {
    return "(none)";
  }
  return new Date(value).toLocaleString();
}

function formatIsoDateTime(value: string): string {
  return new Date(value).toLocaleString();
}

function buildMasterReviewPatchRows(group: MasterReviewGroup) {
  const primaryEvent =
    group.candidateEvents.find((event) => event.id === group.primaryEventId) ?? null;
  if (!primaryEvent) {
    return [];
  }

  const rows: Array<{ label: string; current: string; suggested: string }> = [];
  const maybePushRow = (label: string, current: string, suggested: string) => {
    if (!suggested || suggested === current) {
      return;
    }
    rows.push({
      label,
      current: current || "(empty)",
      suggested,
    });
  };

  maybePushRow("Title", primaryEvent.title, group.primaryPatch.title);
  maybePushRow("Date", primaryEvent.date, group.primaryPatch.date);
  maybePushRow("Time", primaryEvent.time ?? "", group.primaryPatch.time);
  maybePushRow("Venue", primaryEvent.venue, group.primaryPatch.venue);
  maybePushRow(
    "Artists",
    primaryEvent.artists.join(", "),
    group.primaryPatch.artists.join(", "),
  );
  maybePushRow("Description", primaryEvent.description ?? "", group.primaryPatch.description);
  maybePushRow("Ticket price", primaryEvent.ticketPrice ?? "", group.primaryPatch.ticketPrice);
  maybePushRow("Event type", primaryEvent.eventType, group.primaryPatch.eventType);
  maybePushRow("Image URL", primaryEvent.imageUrl ?? "", group.primaryPatch.imageUrl);

  return rows;
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
  const baseConfidenceScore =
    normalizeConfidenceScore(readNumberOrStringField(normalizedFields, "confidence")) ??
    normalizeConfidenceScore(readNumberOrStringField(rawExtraction, "confidence"));
  const missingImage = !event.imageUrl;
  const confidenceScore = calculateModerationConfidenceScore(baseConfidenceScore, {
    hasSuspectedDuplicates: false,
    missingImage,
  });
  const hasSuspiciousYear = readBooleanField(normalizedFields, "dateSuspiciousYear");
  const titleUsedFallback = readBooleanField(normalizedFields, "titleUsedFallback");
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
    baseConfidenceScore,
    confidenceScore,
    titleUsedFallback,
    missingImage,
    missingTime,
    hasIssues: hasSuspiciousYear || titleUsedFallback || lowConfidence || missingImage,
    suspectedDuplicateIds: [],
    suspectedDuplicateCount: 0,
    hasResolvedDuplicate: false,
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
    duplicateDateKey: readStringField(normalizedFields, "normalizedDate") ?? event.date,
    duplicateVenueText: normalizeComparisonText(
      [
        event.venue,
        readStringField(normalizedFields, "normalizedVenue") ?? "",
        readStringField(normalizedFields, "locationName") ?? "",
      ].join(" "),
    ),
    duplicateTitleText: normalizeComparisonText(
      [event.title, event.artists.join(" ")].join(" "),
    ),
    duplicateArtistText: normalizeComparisonText(event.artists.join(" ")),
    duplicateDescriptionText: normalizeComparisonText(
      [event.description ?? "", event.sourceCaption ?? ""].join(" "),
    ),
  };
}

export function ModerationDashboard() {
  const [status, setStatus] = useState<EventStatus>("pending");
  const [limit, setLimit] = useState("100");
  const [events, setEvents] = useState<ModerationEvent[]>([]);
  const [duplicateContextEvents, setDuplicateContextEvents] = useState<ModerationEvent[]>([]);
  const [masterReview, setMasterReview] = useState<MasterReviewResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isMasterReviewLoading, setIsMasterReviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionInFlightFor, setActionInFlightFor] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortMode, setSortMode] = useState<ModerationSortMode>("newest");
  const [filterMode, setFilterMode] = useState<ModerationFilterMode>("all");
  const [confidenceFilter, setConfidenceFilter] =
    useState<ConfidenceFilterMode>("all");

  const emptyStateLabel = useMemo(() => {
    if (status === "pending") return "No pending events for moderation.";
    if (status === "approved") return "No approved events found.";
    return "No rejected events found.";
  }, [status]);

  const fetchEvents = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/admin/events?status=${status}&limit=${limit}&duplicateContext=1`,
        {
          cache: "no-store",
        },
      );
      const payload = (await response.json()) as EventsResponse;
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to load moderation events.");
      }
      setEvents(payload.events);
      setDuplicateContextEvents(payload.duplicateContextEvents ?? payload.events);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unknown moderation load error.",
      );
      setEvents([]);
      setDuplicateContextEvents([]);
    } finally {
      setIsLoading(false);
    }
  }, [limit, status]);

  useEffect(() => {
    void fetchEvents();
  }, [fetchEvents]);

  useEffect(() => {
    if (status !== "approved") {
      setMasterReview(null);
      setIsMasterReviewLoading(false);
    }
  }, [status]);

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

  const decoratedDuplicateContextEvents = useMemo(() => {
    const eventMap = new Map<string, ModerationEvent>();
    for (const event of duplicateContextEvents) {
      eventMap.set(event.id, event);
    }
    for (const event of events) {
      eventMap.set(event.id, event);
    }

    return attachSuspectedDuplicateGroups(
      [...eventMap.values()].map((event) => decorateEvent(event)),
    );
  }, [duplicateContextEvents, events]);
  const decoratedEvents = useMemo(() => {
    const decoratedById = new Map(
      decoratedDuplicateContextEvents.map((event) => [event.id, event] as const),
    );

    return events
      .map((event) => decoratedById.get(event.id))
      .filter((event): event is DecoratedEvent => Boolean(event));
  }, [decoratedDuplicateContextEvents, events]);
  const decoratedEventById = useMemo(
    () =>
      new Map(
        decoratedDuplicateContextEvents.map((event) => [event.id, event] as const),
      ),
    [decoratedDuplicateContextEvents],
  );

  const filteredEvents = useMemo(() => {
    const query = normalizeSearchText(searchQuery);
    const next = decoratedEvents.filter((event) => {
      if (query && !event.searchText.includes(query)) {
        return false;
      }
      if (filterMode === "issues" && !event.hasIssues) {
        return false;
      }
      if (
        filterMode === "suspected_duplicates" &&
        event.suspectedDuplicateCount === 0
      ) {
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
      if (
        confidenceFilter === "high" &&
        !(event.confidenceScore !== null && event.confidenceScore >= 0.9)
      ) {
        return false;
      }
      if (
        confidenceFilter === "medium" &&
        !(
          event.confidenceScore !== null &&
          event.confidenceScore >= 0.7 &&
          event.confidenceScore < 0.9
        )
      ) {
        return false;
      }
      if (
        confidenceFilter === "low" &&
        !(event.confidenceScore !== null && event.confidenceScore < 0.7)
      ) {
        return false;
      }
      if (confidenceFilter === "missing" && event.confidenceScore !== null) {
        return false;
      }
      return true;
    });

    next.sort((left, right) => {
      if (sortMode === "event_date") {
        return (left.normalizedFinalDate ?? left.date).localeCompare(
          right.normalizedFinalDate ?? right.date,
        );
      }
      if (sortMode === "confidence_desc") {
        return (right.confidenceScore ?? Number.NEGATIVE_INFINITY) -
          (left.confidenceScore ?? Number.NEGATIVE_INFINITY);
      }
      if (sortMode === "confidence_asc") {
        return (left.confidenceScore ?? Number.POSITIVE_INFINITY) -
          (right.confidenceScore ?? Number.POSITIVE_INFINITY);
      }
      if (sortMode === "updated") {
        return right.updatedAt - left.updatedAt;
      }
      return right.createdAt - left.createdAt;
    });

    return next;
  }, [confidenceFilter, decoratedEvents, filterMode, searchQuery, sortMode]);

  const visiblePendingEventIds = useMemo(
    () =>
      filteredEvents
        .filter((event) => event.moderation.status === "pending")
        .map((event) => event.id),
    [filteredEvents],
  );

  const isAnyActionInFlight = actionInFlightFor !== null;

  async function approveVisibleEvents() {
    if (visiblePendingEventIds.length === 0) {
      return;
    }

    const confirmed = window.confirm(
      `Approve ${visiblePendingEventIds.length} visible pending event${
        visiblePendingEventIds.length === 1 ? "" : "s"
      }?`,
    );
    if (!confirmed) {
      return;
    }

    setActionInFlightFor(BULK_APPROVE_ACTION_ID);
    setError(null);

    try {
      const response = await fetch("/api/admin/events/moderate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          eventIds: visiblePendingEventIds,
          status: "approved",
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to approve visible events.");
      }

      await fetchEvents();
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unknown bulk approval error.",
      );
    } finally {
      setActionInFlightFor(null);
    }
  }

  async function removeApprovedEvent(eventId: string, title: string) {
    const confirmed = window.confirm(`Remove approved event "${title}"?`);
    if (!confirmed) {
      return;
    }

    setActionInFlightFor(eventId);
    setError(null);

    try {
      const response = await fetch("/api/admin/events/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eventId }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to remove approved event.");
      }

      await fetchEvents();
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unknown event removal error.",
      );
    } finally {
      setActionInFlightFor(null);
    }
  }

  async function runMasterReview() {
    setIsMasterReviewLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/admin/events/master-review", {
        method: "POST",
      });
      const payload = (await response.json()) as MasterReviewResponse;
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to run AI master review.");
      }

      setMasterReview(payload);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unknown AI master review error.",
      );
    } finally {
      setIsMasterReviewLoading(false);
    }
  }

  async function applyMasterReviewGroup(group: MasterReviewGroup) {
    const confirmed = window.confirm(
      group.recommendedAction === "delete_only"
        ? `Delete ${group.duplicateEventIds.length} approved duplicate event${
            group.duplicateEventIds.length === 1 ? "" : "s"
          } from this AI review group?`
        : `Merge the suggested primary event and delete ${
            group.duplicateEventIds.length
          } approved duplicate event${group.duplicateEventIds.length === 1 ? "" : "s"}?`,
    );
    if (!confirmed) {
      return;
    }

    setActionInFlightFor(`master-review:${group.groupId}`);
    setError(null);

    try {
      const response = await fetch("/api/admin/events/master-review/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          primaryEventId: group.primaryEventId,
          duplicateEventIds: group.duplicateEventIds,
          primaryPatch: group.recommendedAction === "merge_delete" ? group.primaryPatch : {},
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to apply AI master review.");
      }

      setMasterReview((current) =>
        current
          ? {
              ...current,
              reviewGroups: current.reviewGroups.filter(
                (candidate) => candidate.groupId !== group.groupId,
              ),
            }
          : current,
      );
      await fetchEvents();
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unknown AI master review apply error.",
      );
    } finally {
      setActionInFlightFor(null);
    }
  }

  const stats = useMemo(
    () => ({
      loaded: decoratedEvents.length,
      visible: filteredEvents.length,
      issues: decoratedEvents.filter((event) => event.hasIssues).length,
      duplicates: decoratedEvents.filter((event) => event.suspectedDuplicateCount > 0).length,
      suspiciousYear: decoratedEvents.filter((event) => event.hasSuspiciousYear).length,
      fallbackTitle: decoratedEvents.filter((event) => event.titleUsedFallback).length,
      missingImage: decoratedEvents.filter((event) => event.missingImage).length,
    }),
    [decoratedEvents, filteredEvents.length],
  );

  return (
    <section className="space-y-5 rounded-3xl border border-border bg-card p-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-7">
        {[
          ["Loaded", stats.loaded],
          ["Visible", stats.visible],
          ["Needs attention", stats.issues],
          ["Suspected duplicates", stats.duplicates],
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
              Filter the queue by confidence, suspected duplicates, missing media,
              and event date issues.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {status === "pending" ? (
              <button
                className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
                disabled={isAnyActionInFlight || visiblePendingEventIds.length === 0}
                onClick={() => void approveVisibleEvents()}
                type="button"
              >
                Approve visible ({visiblePendingEventIds.length})
              </button>
            ) : null}
            <button
              className="rounded-xl border border-border px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isAnyActionInFlight}
              onClick={() => void fetchEvents()}
              type="button"
            >
              Refresh
            </button>
          </div>
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

        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_200px_200px_200px_160px]">
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
            <option value="suspected_duplicates">Suspected duplicates</option>
            <option value="suspicious_year">Suspicious year</option>
            <option value="low_confidence">Low confidence</option>
            <option value="fallback_title">Fallback title</option>
            <option value="missing_image">Missing image</option>
            <option value="missing_time">Missing time</option>
          </select>
          <select
            className="rounded-xl border border-input bg-background px-3 py-2 text-sm"
            onChange={(event) =>
              setConfidenceFilter(event.target.value as ConfidenceFilterMode)
            }
            value={confidenceFilter}
          >
            <option value="all">All confidence</option>
            <option value="high">High confidence (0.90+)</option>
            <option value="medium">Medium confidence (0.70-0.89)</option>
            <option value="low">Low confidence (&lt; 0.70)</option>
            <option value="missing">Missing confidence</option>
          </select>
          <select
            className="rounded-xl border border-input bg-background px-3 py-2 text-sm"
            onChange={(event) => setSortMode(event.target.value as ModerationSortMode)}
            value={sortMode}
          >
            <option value="newest">Newest created</option>
            <option value="updated">Recently updated</option>
            <option value="event_date">Event date ascending</option>
            <option value="confidence_desc">Confidence high to low</option>
            <option value="confidence_asc">Confidence low to high</option>
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

      {status === "approved" ? (
        <section className="space-y-4 rounded-2xl border border-border bg-background/70 p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h2 className="text-lg font-semibold">AI master review</h2>
              <p className="text-sm text-muted-foreground">
                Run one final OpenAI pass on active approved events to spot duplicates,
                suggest a primary record, and prepare merge or deletion actions.
              </p>
            </div>
            <button
              className="rounded-xl border border-border px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isLoading || isMasterReviewLoading || isAnyActionInFlight}
              onClick={() => void runMasterReview()}
              type="button"
            >
              {isMasterReviewLoading
                ? "Running AI review..."
                : masterReview
                  ? "Refresh AI review"
                  : "Run AI master review"}
            </button>
          </div>

          {masterReview ? (
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-4">
                {[
                  ["Active approved", masterReview.activeEventCount],
                  ["Candidate groups", masterReview.candidateGroupCount],
                  ["AI actions", masterReview.reviewGroups.length],
                  ["Generated", formatIsoDateTime(masterReview.generatedAt)],
                ].map(([label, value]) => (
                  <div
                    className="rounded-xl border border-border bg-card/80 p-3"
                    key={label}
                  >
                    <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                      {label}
                    </p>
                    <p className="mt-2 text-sm font-medium">{String(value)}</p>
                  </div>
                ))}
              </div>

              <div className="rounded-xl border border-border bg-card/80 p-4">
                <p className="text-sm text-muted-foreground">{masterReview.overview}</p>
              </div>

              {masterReview.reviewGroups.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No actionable duplicate merges or deletions were suggested.
                </p>
              ) : (
                <div className="space-y-3">
                  {masterReview.reviewGroups.map((group) => {
                    const primaryEvent =
                      group.candidateEvents.find(
                        (event) => event.id === group.primaryEventId,
                      ) ?? null;
                    const duplicateEvents = group.candidateEvents.filter((event) =>
                      group.duplicateEventIds.includes(event.id),
                    );
                    const patchRows = buildMasterReviewPatchRows(group);

                    return (
                      <article
                        className="space-y-4 rounded-2xl border border-border bg-card/80 p-4"
                        key={group.groupId}
                      >
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                          <div className="space-y-2">
                            <div className="flex flex-wrap gap-2">
                              <span className="rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                {group.recommendedAction === "delete_only"
                                  ? "Delete duplicates"
                                  : "Merge + delete"}
                              </span>
                              <span className="rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                Confidence{" "}
                                {formatConfidenceScore(group.confidence) ?? "(none)"}
                              </span>
                            </div>
                            <p className="text-sm text-muted-foreground">{group.reasoning}</p>
                          </div>
                          <button
                            className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
                            disabled={isAnyActionInFlight}
                            onClick={() => void applyMasterReviewGroup(group)}
                            type="button"
                          >
                            {group.recommendedAction === "delete_only"
                              ? `Delete duplicates (${group.duplicateEventIds.length})`
                              : `Apply merge + delete (${group.duplicateEventIds.length})`}
                          </button>
                        </div>

                        {primaryEvent ? (
                          <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-3">
                            <p className="text-xs font-medium uppercase tracking-[0.18em] text-emerald-800">
                              Primary event to keep
                            </p>
                            <p className="mt-2 font-medium text-emerald-950">
                              {primaryEvent.title}
                            </p>
                            <p className="text-sm text-emerald-900/80">
                              {primaryEvent.date}
                              {primaryEvent.time ? ` at ${primaryEvent.time}` : ""}
                              {" · "}
                              {primaryEvent.venue}
                            </p>
                          </div>
                        ) : null}

                        {duplicateEvents.length > 0 ? (
                          <div className="rounded-xl border border-rose-200 bg-rose-50/70 p-3">
                            <p className="text-xs font-medium uppercase tracking-[0.18em] text-rose-800">
                              Approved duplicates to remove
                            </p>
                            <div className="mt-2 space-y-2">
                              {duplicateEvents.map((event) => (
                                <div
                                  className="rounded-lg border border-rose-200 bg-white/70 p-3"
                                  key={event.id}
                                >
                                  <p className="font-medium text-rose-950">{event.title}</p>
                                  <p className="text-sm text-rose-900/80">
                                    {event.date}
                                    {event.time ? ` at ${event.time}` : ""}
                                    {" · "}
                                    {event.venue}
                                  </p>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}

                        {patchRows.length > 0 ? (
                          <div className="space-y-2">
                            <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                              Suggested primary updates
                            </p>
                            <div className="space-y-2">
                              {patchRows.map((row) => (
                                <div
                                  className="rounded-xl border border-border bg-background/80 p-3"
                                  key={row.label}
                                >
                                  <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                                    {row.label}
                                  </p>
                                  <p className="mt-1 text-sm text-muted-foreground">
                                    Current: {row.current}
                                  </p>
                                  <p className="mt-1 text-sm font-medium">
                                    Suggested: {row.suggested}
                                  </p>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No AI master review has been run yet for the approved queue.
            </p>
          )}
        </section>
      ) : null}

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

      <div className="space-y-3">
        {filteredEvents.map((event) => {
          const suspectedDuplicates = event.suspectedDuplicateIds
            .map((duplicateId) => decoratedEventById.get(duplicateId))
            .filter((duplicate): duplicate is DecoratedEvent => Boolean(duplicate))
            .sort((left, right) => right.updatedAt - left.updatedAt);

          return (
          <article
            className="overflow-hidden rounded-2xl border border-border bg-background/80"
            key={event.id}
          >
            <div className="grid gap-0 lg:grid-cols-[180px_minmax(0,1fr)]">
              <div className="border-b border-border bg-muted lg:border-b-0 lg:border-r">
                {event.imageUrl ? (
                  <a href={event.imageUrl} rel="noreferrer" target="_blank">
                    <Image
                      alt={event.title}
                      className="h-40 w-full object-cover lg:h-full"
                      height={720}
                      src={event.imageUrl}
                      width={720}
                    />
                  </a>
                ) : (
                  <div className="flex h-40 items-center justify-center px-5 text-center text-sm text-muted-foreground lg:h-full">
                    No poster image available for this event.
                  </div>
                )}
              </div>

              <div className="space-y-3 p-4">
                <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                  <div className="space-y-1.5">
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
                      {event.suspectedDuplicateCount > 0 ? (
                        <span className="rounded-full bg-orange-100 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-orange-800">
                          Suspected duplicates {event.suspectedDuplicateCount}
                        </span>
                      ) : null}
                      {event.hasResolvedDuplicate ? (
                        <span className="rounded-full bg-rose-200 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-rose-900">
                          Reviewed duplicate conflict
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
                      <h3 className="text-lg font-semibold tracking-tight">{event.title}</h3>
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        {event.date}
                        {event.time ? ` at ${event.time}` : ""}
                        {" · "}
                        {event.venue}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
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
                        {formatConfidenceScore(event.confidenceScore) ?? "(none)"}
                      </span>
                    </p>
                    {event.ticketPrice ? <p className="mt-1">{event.ticketPrice}</p> : null}
                  </div>
                </div>

                {event.artists.length > 0 ? (
                  <p className="text-sm leading-5">
                    Artists:{" "}
                    <span className="text-muted-foreground">{event.artists.join(", ")}</span>
                  </p>
                ) : null}

                {event.description ? (
                  <p className="text-sm leading-5 text-muted-foreground">{event.description}</p>
                ) : null}

                {suspectedDuplicates.length > 0 ? (
                  <div className="rounded-2xl border border-orange-200 bg-orange-50/70 p-3">
                    <p className="text-xs font-medium uppercase tracking-[0.18em] text-orange-800">
                      Suspected duplicates
                    </p>
                    <div className="mt-2 space-y-2">
                      {suspectedDuplicates.map((duplicate) => (
                        <div
                          className="flex flex-col gap-1 text-sm text-orange-950 lg:flex-row lg:items-center lg:justify-between"
                          key={duplicate.id}
                        >
                          <div>
                            <p className="font-medium">{duplicate.title}</p>
                            <p className="text-xs text-orange-900/80">
                              {duplicate.date}
                              {duplicate.time ? ` at ${duplicate.time}` : ""}
                              {" · "}
                              {duplicate.venue}
                              {" · "}
                              {duplicate.moderation.status}
                            </p>
                          </div>
                          <Link
                            className="rounded-lg border border-orange-300 px-2.5 py-1 text-xs font-medium"
                            href={`/events/${duplicate.id}`}
                          >
                            Open
                          </Link>
                        </div>
                      ))}
                    </div>
                  </div>
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

                <details className="rounded-2xl border border-border p-3 text-sm">
                  <summary className="cursor-pointer font-medium">Admin details</summary>
                  <div className="mt-4 space-y-4">
                    <div className="grid gap-3 lg:grid-cols-4">
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
                      <div className="rounded-xl border border-border p-3">
                        <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                          Confidence calculation
                        </p>
                        <p className="mt-1 text-sm">
                          Base {formatConfidenceScore(event.baseConfidenceScore) ?? "(none)"}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Suspected duplicates{" "}
                          {event.hasResolvedDuplicate
                            ? "forced to 0.00"
                            : event.suspectedDuplicateCount > 0
                            ? `x${DUPLICATE_CONFIDENCE_MULTIPLIER.toFixed(2)}`
                            : "none"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Missing image{" "}
                          {event.missingImage
                            ? `-${MISSING_IMAGE_CONFIDENCE_PENALTY.toFixed(2)}`
                            : "none"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Auto-approve {`>${AUTO_APPROVE_CONFIDENCE_THRESHOLD.toFixed(2)}`}
                        </p>
                        <p className="mt-2 text-sm font-medium">
                          Final {formatConfidenceScore(event.confidenceScore) ?? "(none)"}
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
                                  Confidence: {formatConfidenceScore(row.details.confidence) ?? "(none)"}
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
                      disabled={isAnyActionInFlight}
                      onClick={() => void updateStatus(event.id, "approved")}
                      type="button"
                    >
                      Approve
                    </button>
                    <button
                      className="rounded-xl border border-destructive px-4 py-2 text-sm font-medium text-destructive disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={isAnyActionInFlight}
                      onClick={() => void updateStatus(event.id, "rejected")}
                      type="button"
                    >
                      Reject
                    </button>
                  </div>
                ) : null}
                {status === "approved" ? (
                  <div className="flex flex-wrap gap-2">
                    <button
                      className="rounded-xl border border-destructive px-4 py-2 text-sm font-medium text-destructive disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={isAnyActionInFlight}
                      onClick={() => void removeApprovedEvent(event.id, event.title)}
                      type="button"
                    >
                      Remove
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </article>
          );
        })}
      </div>
    </section>
  );
}
