import { toSearchableText } from "../pipeline/venue-normalization";

export type PublicEventVenueFilterFields = {
  venue: string;
  venueAliases?: string[];
  venueId?: string;
  venueLocation?: string;
};

export type PublicEventVenueFilterOption = {
  label: string;
  names: string[];
  value: string;
};

export function getPublicEventVenueFilterValue(
  event: Pick<PublicEventVenueFilterFields, "venue" | "venueId">,
): string {
  return event.venueId
    ? `id:${event.venueId}`
    : `name:${toSearchableText(event.venue)}`;
}

export function buildPublicEventVenueFilterOptions(
  events: readonly PublicEventVenueFilterFields[],
): PublicEventVenueFilterOption[] {
  const byValue = new Map<string, PublicEventVenueFilterOption>();
  const locations = new Map<string, string>();
  for (const event of events) {
    const value = getPublicEventVenueFilterValue(event);
    const names = [event.venue, ...(event.venueAliases ?? [])];
    const existing = byValue.get(value);
    if (existing) {
      existing.names = [...new Set([...existing.names, ...names])];
    } else {
      byValue.set(value, { label: event.venue, names: [...new Set(names)], value });
    }
    if (event.venueLocation) {
      locations.set(value, event.venueLocation);
    }
  }

  const options = [...byValue.values()];
  const labelCounts = new Map<string, number>();
  for (const option of options) {
    const key = toSearchableText(option.label);
    labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
  }
  for (const option of options) {
    if ((labelCounts.get(toSearchableText(option.label)) ?? 0) > 1) {
      const location = locations.get(option.value);
      if (location) {
        option.label = `${option.label} (${location})`;
      }
    }
  }
  return options.sort(
    (left, right) => left.label.localeCompare(right.label) || left.value.localeCompare(right.value),
  );
}

/** Old shared name/alias URLs resolve to an ID only when the current month is unambiguous. */
export function resolvePublicEventVenueFilter(
  requested: string | undefined,
  options: readonly PublicEventVenueFilterOption[],
): string | undefined {
  if (!requested || /^(?:id|name):/u.test(requested)) {
    return requested;
  }
  const key = toSearchableText(requested);
  const matches = options.filter((option) =>
    option.names.some((name) => toSearchableText(name) === key),
  );
  return matches.length === 1 ? matches[0].value : requested;
}

export function matchesPublicEventVenueFilter(
  event: PublicEventVenueFilterFields,
  selected: string | undefined,
): boolean {
  if (!selected) {
    return true;
  }
  if (/^(?:id|name):/u.test(selected)) {
    return getPublicEventVenueFilterValue(event) === selected;
  }
  const key = toSearchableText(selected);
  return [event.venue, ...(event.venueAliases ?? [])].some(
    (name) => toSearchableText(name) === key,
  );
}
