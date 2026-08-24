export const MAX_MODERATION_DUPLICATE_CONTEXT_DATES = 100;

type DateBearingEvent = {
  date: string;
};

type IdentifiedEvent = {
  id: string;
};

type DuplicateContextLoadOptions<T> = {
  baseEvents: T[];
  includeDuplicateContext: boolean;
  loadContext: () => Promise<{
    events: T[];
    truncated: boolean;
  }>;
  onLoadError?: (error: unknown) => void;
};

export function getModerationDuplicateContextDates(
  events: DateBearingEvent[],
): string[] {
  const dates: string[] = [];
  const seen = new Set<string>();

  for (const event of events) {
    if (seen.has(event.date)) {
      continue;
    }

    seen.add(event.date);
    dates.push(event.date);
    if (dates.length >= MAX_MODERATION_DUPLICATE_CONTEXT_DATES) {
      break;
    }
  }

  return dates;
}

export function mergeModerationDuplicateContextEvents<T extends IdentifiedEvent>(
  baseEvents: T[],
  contextEvents: T[],
): T[] {
  const merged = [...baseEvents];
  const seenIds = new Set(baseEvents.map((event) => event.id));

  for (const event of contextEvents) {
    if (seenIds.has(event.id)) {
      continue;
    }
    seenIds.add(event.id);
    merged.push(event);
  }

  return merged;
}

export async function loadModerationDuplicateContextWithFallback<T>(
  options: DuplicateContextLoadOptions<T>,
): Promise<{
  duplicateContextEvents: T[];
  degraded: boolean;
  truncated: boolean;
}> {
  if (!options.includeDuplicateContext) {
    return {
      duplicateContextEvents: [],
      degraded: false,
      truncated: false,
    };
  }

  try {
    const loaded = await options.loadContext();
    return {
      duplicateContextEvents: loaded.events,
      degraded: loaded.truncated,
      truncated: loaded.truncated,
    };
  } catch (error) {
    options.onLoadError?.(error);
    return {
      duplicateContextEvents: options.baseEvents,
      degraded: true,
      truncated: false,
    };
  }
}
