export const VENUE_DAY_GROUP_THRESHOLD = 4;

type VenueDayEvent = {
  date: string;
  venue: string;
  venueId?: string;
};

export type VenueDayGroup<T extends VenueDayEvent> = {
  events: T[];
  key: string;
  venue: string;
  visibleCount: number;
};

function normalizeVenueName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function groupBusyVenuesForDay<T extends VenueDayEvent>(
  events: readonly T[],
  isVisible: (event: T) => boolean = () => true,
): { groups: VenueDayGroup<T>[]; individualEvents: T[] } {
  const venueIdsByName = new Map<string, Set<string>>();
  for (const event of events) {
    if (!event.venueId) {
      continue;
    }
    const name = `${event.date}\u0000${normalizeVenueName(event.venue)}`;
    const ids = venueIdsByName.get(name) ?? new Set<string>();
    ids.add(event.venueId);
    venueIdsByName.set(name, ids);
  }

  function getVenueDayKey(event: T): string {
    const name = normalizeVenueName(event.venue);
    const matchingIds = venueIdsByName.get(`${event.date}\u0000${name}`);
    const venueId = event.venueId ?? (matchingIds?.size === 1 ? matchingIds.values().next().value : undefined);
    return `${event.date}\u0000${venueId ? `id:${venueId}` : `name:${name}`}`;
  }

  const byVenueDay = new Map<string, VenueDayGroup<T>>();

  for (const event of events) {
    const key = getVenueDayKey(event);
    const group = byVenueDay.get(key);
    if (group) {
      group.events.push(event);
      if (isVisible(event)) {
        group.visibleCount += 1;
      }
    } else {
      byVenueDay.set(key, {
        events: [event],
        key,
        venue: event.venue,
        visibleCount: isVisible(event) ? 1 : 0,
      });
    }
  }

  const groups = Array.from(byVenueDay.values()).filter(
    (group) => group.visibleCount >= VENUE_DAY_GROUP_THRESHOLD,
  );
  const groupedKeys = new Set(groups.map((group) => group.key));

  return {
    groups,
    individualEvents: events.filter((event) => !groupedKeys.has(getVenueDayKey(event))),
  };
}
