import "server-only";

import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { getCalendarConvexUrl } from "../events/calendar-convex-url";
import type { PublicEvent } from "../events/public-events";
import { projectCompassMusicContext } from "./compass-projection";
import type { CompassMusicProfile, CompassPlace } from "./compass";
import { addDaysToDateKey, getNightlifeDefaultDateKey } from "../events/nightlife-date";
import { getBelgradeNow } from "../venues/venue-open-now";

export type VenueMusicContext = { musicProfile: CompassMusicProfile; event?: CompassPlace["event"] };
const query = "venues:getPublicVenueMusicEvents" as unknown as FunctionReference<"query">;
const cache = new Map<string, { until: number; value: Promise<VenueMusicContext> }>();
let activeQueries = 0;

export function loadVenueMusicContext(venueId: string): Promise<VenueMusicContext> {
  const hit = cache.get(venueId);
  if (hit && hit.until > Date.now()) return hit.value;
  if (activeQueries >= 4) return Promise.reject(new Error("Music lookup is busy. Please retry."));
  activeQueries++;
  const pending = (async () => {
    const url = getCalendarConvexUrl();
    if (!url) throw new Error("Music data is unavailable.");
    const requestedAt = Date.now();
    const result = await new ConvexHttpClient(url).query(query, {
      id: venueId, today: getNightlifeDefaultDateKey(new Date(requestedAt)),
      beforeDate: addDaysToDateKey(getBelgradeNow(requestedAt).date, 1),
    }) as { asOf: number; events: PublicEvent[] } | null;
    return projectCompassMusicContext(result?.events ?? [], Date.now());
  })().finally(() => { activeQueries--; });
  cache.delete(venueId); cache.set(venueId, { until: Date.now() + 60_000, value: pending });
  while (cache.size > 128) cache.delete(cache.keys().next().value!);
  pending.catch(() => { if (cache.get(venueId)?.value === pending) cache.delete(venueId); });
  return pending;
}
