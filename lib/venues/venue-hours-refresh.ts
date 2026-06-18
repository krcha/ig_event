import {
  shouldRefreshVenueHoursCache,
  type VenueHoursCacheFields,
} from "@/lib/venues/venue-hours-cache";

export type VenueHoursRefreshTarget = VenueHoursCacheFields & {
  _id?: string;
  isActive?: boolean;
  name: string;
};

export type ActiveVenueHoursRefreshTarget = VenueHoursRefreshTarget & {
  _id: string;
};

function isActiveRefreshTarget(
  venue: VenueHoursRefreshTarget,
): venue is ActiveVenueHoursRefreshTarget {
  return (
    typeof venue._id === "string" &&
    venue._id.length > 0 &&
    typeof venue.name === "string" &&
    venue.name.trim().length > 0 &&
    venue.isActive !== false
  );
}

function getRefreshPriority(venue: VenueHoursRefreshTarget): number {
  if (!venue.hoursSource || !venue.hoursJson || !venue.hoursFetchedAt) {
    return 0;
  }

  if (venue.hoursSource === "none") {
    return 1;
  }

  if (!venue.hoursExpiresAt) {
    return 2;
  }

  return 3;
}

export function getActiveVenueHoursRefreshTargets<T extends VenueHoursRefreshTarget>(
  venues: T[],
): Array<T & ActiveVenueHoursRefreshTarget> {
  return venues.filter(isActiveRefreshTarget) as Array<T & ActiveVenueHoursRefreshTarget>;
}

export function getDueVenueHoursRefreshTargets<T extends VenueHoursRefreshTarget>(
  venues: T[],
  now = Date.now(),
): Array<T & ActiveVenueHoursRefreshTarget> {
  return getActiveVenueHoursRefreshTargets(venues).filter((venue) =>
    shouldRefreshVenueHoursCache(venue, now),
  );
}

export function sortVenueHoursRefreshTargets<T extends VenueHoursRefreshTarget>(
  venues: T[],
  now = Date.now(),
): T[] {
  return [...venues].sort((left, right) => {
    const priorityDelta = getRefreshPriority(left) - getRefreshPriority(right);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }

    const leftExpiresAt = left.hoursExpiresAt ?? 0;
    const rightExpiresAt = right.hoursExpiresAt ?? 0;
    if (leftExpiresAt !== rightExpiresAt) {
      return leftExpiresAt - rightExpiresAt;
    }

    const leftFetchedAt = left.hoursFetchedAt ?? 0;
    const rightFetchedAt = right.hoursFetchedAt ?? 0;
    if (leftFetchedAt !== rightFetchedAt) {
      return leftFetchedAt - rightFetchedAt;
    }

    const leftDueAge = shouldRefreshVenueHoursCache(left, now) ? 0 : 1;
    const rightDueAge = shouldRefreshVenueHoursCache(right, now) ? 0 : 1;
    if (leftDueAge !== rightDueAge) {
      return leftDueAge - rightDueAge;
    }

    return left.name.localeCompare(right.name);
  });
}

export function selectVenuesForHoursRefresh<T extends VenueHoursRefreshTarget>(
  venues: T[],
  limit: number,
  now = Date.now(),
): Array<T & ActiveVenueHoursRefreshTarget> {
  const safeLimit = Math.max(0, Math.trunc(limit));
  return sortVenueHoursRefreshTargets(
    getDueVenueHoursRefreshTargets(venues, now),
    now,
  ).slice(0, safeLimit) as Array<T & ActiveVenueHoursRefreshTarget>;
}
