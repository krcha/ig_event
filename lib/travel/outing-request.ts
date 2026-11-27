import type { CompassPlace, CompassProgramme } from "./compass";

export type OutingParts = {
  places: CompassPlace[];
  programmes: { venueId: string; programmes: CompassProgramme[] }[];
};
export type OutingPart = keyof OutingParts;

export function requestOutingPart<K extends OutingPart>(
  part: K,
  ready: (rows: OutingParts[K]) => void,
  failed: () => void,
  options: { fetcher?: typeof fetch; timeoutMs?: number } = {},
) {
  const controller = new AbortController();
  let disposed = false;
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 18_000);
  const url = part === "places" ? "/api/travel/places" : "/api/travel/places?view=programmes";
  void (options.fetcher ?? fetch)(url, { cache: "no-store", signal: controller.signal })
    .then(async response => {
      if (!response.ok) throw new Error("Listings unavailable.");
      const body = await response.json();
      if (!Array.isArray(body?.[part]) || controller.signal.aborted) throw new Error("Invalid listings.");
      if (!disposed) ready(body[part]);
    }).catch(() => { if (!disposed) failed(); })
    .finally(() => clearTimeout(timeout));
  return () => { disposed = true; clearTimeout(timeout); controller.abort(); };
}
