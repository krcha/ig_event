import type { CompassPlace, CompassProgramme } from "./compass";

export type OutingParts = {
  places: CompassPlace[];
  programmes: { venueId: string; programmes: CompassProgramme[] }[];
};
export type OutingPart = keyof OutingParts;

export type ProgrammeStatus = "loading" | "ready" | "error";
export function getCompassView(phase: "confirm" | "vibe" | "results", programmes: ProgrammeStatus, needsMusicContext: boolean) {
  if (phase !== "results") return phase;
  if (programmes !== "ready") return "programme-status";
  return needsMusicContext ? "music-status" : "results";
}

export function requestOutingPart<K extends OutingPart>(
  part: K,
  ready: (rows: OutingParts[K]) => void,
  failed: () => void,
  options: { fetcher?: typeof fetch; timeoutMs?: number } = {},
) {
  const controller = new AbortController();
  let finished = false;
  const fail = () => {
    if (finished) return;
    finished = true;
    failed();
  };
  const timeout = setTimeout(() => { controller.abort(); fail(); }, options.timeoutMs ?? 18_000);
  const url = part === "places" ? "/api/travel/places" : "/api/travel/places?view=programmes";
  void (options.fetcher ?? fetch)(url, { cache: "no-store", signal: controller.signal })
    .then(async response => {
      if (!response.ok) throw new Error("Listings unavailable.");
      const body = await response.json();
      if (!Array.isArray(body?.[part])) throw new Error("Invalid listings.");
      if (finished) return;
      finished = true;
      ready(body[part]);
    }).catch(fail).finally(() => clearTimeout(timeout));
  return () => { finished = true; clearTimeout(timeout); controller.abort(); };
}
