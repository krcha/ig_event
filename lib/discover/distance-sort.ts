import { haversineMeters, type Coordinates } from "../travel/location";

type DiscoverLocation = { venueLatitude?: number; venueLongitude?: number };

export function getDiscoverCoordinates(event: DiscoverLocation): Coordinates | null {
  const { venueLatitude: latitude, venueLongitude: longitude } = event;
  return typeof latitude === "number" && Number.isFinite(latitude) && Math.abs(latitude) <= 90 &&
    typeof longitude === "number" && Number.isFinite(longitude) && Math.abs(longitude) <= 180
    ? { latitude, longitude }
    : null;
}

/** Sort the whole matching deck before taking its visible layers; unknown places stay last. */
export function sortDiscoverByDistance<T extends DiscoverLocation>(events: readonly T[], origin: Coordinates): T[] {
  return events.map((event, index) => {
    const coordinates = getDiscoverCoordinates(event);
    return { event, index, distance: coordinates ? haversineMeters(origin, coordinates) : Infinity };
  }).sort((a, b) => (a.distance === b.distance ? 0 : a.distance - b.distance) || a.index - b.index)
    .map(({ event }) => event);
}
