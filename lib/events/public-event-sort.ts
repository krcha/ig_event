export type PublicEventSortInput = {
  _id: string;
  date: string;
  time?: string | null;
  venue: string;
  title: string;
};

function parseEventTimeMinutes(value: string | null | undefined): number {
  const trimmed = value?.trim();
  if (!trimmed) {
    return 0;
  }

  const match = trimmed.match(/(\d{1,2}):(\d{2})/);
  if (!match) {
    return 0;
  }

  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return 0;
  }

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return 0;
  }

  return hours * 60 + minutes;
}

function compareAlphabetical(left: string, right: string): number {
  const normalizedLeft = normalizeAlphabeticalSortKey(left);
  const normalizedRight = normalizeAlphabeticalSortKey(right);
  const normalizedResult = normalizedLeft.localeCompare(normalizedRight, undefined, {
    numeric: true,
    sensitivity: "base",
  });

  if (normalizedResult !== 0) {
    return normalizedResult;
  }

  return left.trim().localeCompare(right.trim(), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function normalizeAlphabeticalSortKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

export function comparePublicEventsByDateVenueTimeTitle(
  left: PublicEventSortInput,
  right: PublicEventSortInput,
): number {
  const dateResult = left.date.localeCompare(right.date);
  if (dateResult !== 0) {
    return dateResult;
  }

  const venueResult = compareAlphabetical(left.venue, right.venue);
  if (venueResult !== 0) {
    return venueResult;
  }

  const timeResult = parseEventTimeMinutes(left.time) - parseEventTimeMinutes(right.time);
  if (timeResult !== 0) {
    return timeResult;
  }

  const titleResult = compareAlphabetical(left.title, right.title);
  if (titleResult !== 0) {
    return titleResult;
  }

  return left._id.localeCompare(right._id);
}

export function sortPublicEventsByDateVenueTimeTitle<T extends PublicEventSortInput>(
  events: readonly T[],
): T[] {
  return [...events].sort(comparePublicEventsByDateVenueTimeTitle);
}
