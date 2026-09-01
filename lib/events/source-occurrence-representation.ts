import { getEventTimeSortMinutes } from "./event-time.ts";

export type ExpectedSourceOccurrence = {
  key: string;
  date: string;
  time?: string;
  venue: string;
  title: string;
  artists: string[];
};

export type SourceOccurrenceRepresentative = {
  title: string;
  date: string;
  time?: string;
  venue: string;
  artists: string[];
  status: string;
  sourceOccurrenceKey?: string;
  normalizedFieldsJson?: string;
};

export type SemanticOccurrenceBinding = Pick<
  ExpectedSourceOccurrence,
  "date" | "time" | "venue" | "title" | "artists"
>;

export type ImmutableSourceOccurrenceBindingCandidate = {
  title: string;
  date: string;
  time?: string | null;
  venue: string;
  artists: string[];
  normalizedFieldsJson?: string | null;
};

function normalizeBindingText(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("sr-Latn")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

function normalizeArtists(values: string[]): string[] {
  return [...new Set(values.map(normalizeBindingText).filter(Boolean))].sort();
}

function bindingMatchesExpected(
  binding: SemanticOccurrenceBinding,
  expected: ExpectedSourceOccurrence,
  options: { ignoreTime?: boolean } = {},
): boolean {
  const bindingArtists = normalizeArtists(binding.artists);
  const expectedArtists = normalizeArtists(expected.artists);
  return (
    binding.date === expected.date &&
    normalizeBindingText(binding.venue) === normalizeBindingText(expected.venue) &&
    normalizeBindingText(binding.title) === normalizeBindingText(expected.title) &&
    bindingArtists.length === expectedArtists.length &&
    bindingArtists.every((artist, index) => artist === expectedArtists[index]) &&
    (options.ignoreTime ||
      !expected.time ||
      (Boolean(binding.time) &&
        normalizeBindingText(binding.time) === normalizeBindingText(expected.time)))
  );
}

function parseNormalizedFields(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function readPersistedSourceOccurrenceBinding(
  normalizedFields: Record<string, unknown> | null,
): SemanticOccurrenceBinding | null {
  if (!normalizedFields) {
    return null;
  }
  const title = normalizedFields.title;
  const date = normalizedFields.normalizedDate;
  const time = normalizedFields.time;
  const venue = normalizedFields.normalizedVenue;
  const artists = normalizedFields.artists;
  if (
    typeof title !== "string" ||
    typeof date !== "string" ||
    (time !== undefined && time !== null && typeof time !== "string") ||
    typeof venue !== "string" ||
    !Array.isArray(artists) ||
    artists.some((artist) => typeof artist !== "string")
  ) {
    return null;
  }
  return {
    title,
    date,
    ...(typeof time === "string" ? { time } : {}),
    venue,
    artists,
  };
}

/**
 * Automatic deletion may only rely on the immutable extraction snapshot, not
 * mutable public fields. Missing or malformed snapshots therefore fail
 * closed, even when a broader duplicate classifier finds strong similarity.
 */
export function immutableSourceOccurrenceBindingsMatch(
  left: ImmutableSourceOccurrenceBindingCandidate,
  right: ImmutableSourceOccurrenceBindingCandidate,
): boolean {
  const leftBinding = readPersistedSourceOccurrenceBinding(
    parseNormalizedFields(left.normalizedFieldsJson ?? undefined),
  );
  const rightBinding = readPersistedSourceOccurrenceBinding(
    parseNormalizedFields(right.normalizedFieldsJson ?? undefined),
  );
  if (!leftBinding || !rightBinding) {
    return false;
  }

  const leftArtists = normalizeArtists(leftBinding.artists);
  const rightArtists = normalizeArtists(rightBinding.artists);
  return (
    leftBinding.date === rightBinding.date &&
    normalizeBindingText(leftBinding.time) === normalizeBindingText(rightBinding.time) &&
    normalizeBindingText(leftBinding.venue) === normalizeBindingText(rightBinding.venue) &&
    normalizeBindingText(leftBinding.title) === normalizeBindingText(rightBinding.title) &&
    leftArtists.length === rightArtists.length &&
    leftArtists.every((artist, index) => artist === rightArtists[index])
  );
}

export function immutableSourceOccurrenceBindingsHaveEqualReliableTime(
  left: ImmutableSourceOccurrenceBindingCandidate,
  right: ImmutableSourceOccurrenceBindingCandidate,
): boolean {
  const leftBinding = readPersistedSourceOccurrenceBinding(
    parseNormalizedFields(left.normalizedFieldsJson ?? undefined),
  );
  const rightBinding = readPersistedSourceOccurrenceBinding(
    parseNormalizedFields(right.normalizedFieldsJson ?? undefined),
  );
  if (!leftBinding || !rightBinding) return false;
  const leftMinutes = getEventTimeSortMinutes(leftBinding.time);
  const rightMinutes = getEventTimeSortMinutes(rightBinding.time);
  return leftMinutes !== null && rightMinutes !== null && leftMinutes === rightMinutes;
}

/**
 * Proves that an event can represent one source child. Public event fields are
 * mutable through moderation, so a machine-created occurrence uses the
 * immutable normalized extraction snapshot as its semantic authority. A key
 * alone is not proof because it does not encode title, artists, or venue.
 */
export function sourceOccurrenceRepresentativeMatchesExpected(
  event: SourceOccurrenceRepresentative | null,
  expected: ExpectedSourceOccurrence | undefined,
  options: { allowUnverifiedPending?: boolean } = {},
): boolean {
  if (!event || !expected || event.status === "rejected") return false;
  const normalizedFields = parseNormalizedFields(event.normalizedFieldsJson);
  if (
    !options.allowUnverifiedPending &&
    event.status !== "approved" &&
    normalizedFields?.sourceOccurrencePlanUnverified === true
  ) {
    return false;
  }
  const snapshot = readPersistedSourceOccurrenceBinding(normalizedFields);
  if (snapshot) {
    // Date-range keys are intentionally date-based; a later normalization may
    // improve the displayed time without changing which date child this is.
    return bindingMatchesExpected(snapshot, expected, {
      ignoreTime: normalizedFields?.dateRangeExpanded === true,
    });
  }
  return bindingMatchesExpected(event, expected);
}
