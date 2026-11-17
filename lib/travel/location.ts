export type Coordinates = { latitude: number; longitude: number };

export function isCoordinates(value: unknown): value is Coordinates {
  if (!value || typeof value !== "object") return false;
  const point = value as Coordinates;
  return Number.isFinite(point.latitude) && Math.abs(point.latitude) <= 90 &&
    Number.isFinite(point.longitude) && Math.abs(point.longitude) <= 180;
}

export function haversineMeters(from: Coordinates, to: Coordinates): number {
  if (!isCoordinates(from) || !isCoordinates(to)) return Infinity;
  const radians = Math.PI / 180;
  const a = Math.sin((to.latitude - from.latitude) * radians / 2) ** 2 +
    Math.cos(from.latitude * radians) * Math.cos(to.latitude * radians) *
    Math.sin((to.longitude - from.longitude) * radians / 2) ** 2;
  return 12_742_000 * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearingDegrees(from: Coordinates, to: Coordinates): number {
  const rad = Math.PI / 180;
  const delta = (to.longitude - from.longitude) * rad;
  const y = Math.sin(delta) * Math.cos(to.latitude * rad);
  const x = Math.cos(from.latitude * rad) * Math.sin(to.latitude * rad) -
    Math.sin(from.latitude * rad) * Math.cos(to.latitude * rad) * Math.cos(delta);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

// Immediate estimates avoid routing every card. Actual street geometry is
// requested separately, only when the visitor opens a route.
export function estimateTravel(from: Coordinates, to: Coordinates) {
  const meters = haversineMeters(from, to);
  return {
    meters,
    walkMinutes: Math.max(1, Math.ceil(meters * 1.25 / 75)),
    driveMinutes: Math.max(1, Math.ceil(meters * 1.4 / (20_000 / 60))),
  };
}

export function yandexDestinationHref(destination: Coordinates): string | null {
  if (!isCoordinates(destination)) return null;
  const url = new URL("https://3.redirect.appmetrica.yandex.com/route");
  url.search = new URLSearchParams({
    "end-lat": String(destination.latitude),
    "end-lon": String(destination.longitude),
    appmetrica_tracking_id: "25395763362139037",
  }).toString();
  return url.href;
}
