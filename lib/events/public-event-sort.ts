import { getEventTimeSortMinutes } from "./event-time.ts";

export type PublicEventSortInput = {
  _id: string;
  date: string;
  time?: string | null;
  venue: string;
  title: string;
};

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

  const timeResult = (getEventTimeSortMinutes(left.time) ?? 0) - (getEventTimeSortMinutes(right.time) ?? 0);
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
