import "server-only";
import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { readTravelPart } from "./public-read-client";
import { addDaysToDateKey } from "../events/nightlife-date";
import { sortPublicEventsByDateVenueTimeTitle } from "../events/public-event-sort";
import type { PublicVenue } from "../venues/public-venue-pages";
import { getOpenNowEventWindow } from "../venues/venue-open-now";
import { projectOutingDirectory, projectOutingProgrammes } from "./compass-projection";
import { loadRecommendationWindow } from "./recommendation-window";

let directory: { url: string; until: number; value: Promise<PublicVenue[]> } | undefined;
function loadDirectory(client: ConvexHttpClient): Promise<PublicVenue[]> {
  const now = Date.now();
  if (directory?.url === client.url && directory.until > now) return directory.value;
  const value = client.query(api.venues.listPublicCompassVenues, {});
  directory = { url: client.url, until: Infinity, value };
  void value.then(() => {
    if (directory?.value === value) directory.until = now + 60_000;
  }, () => {
    if (directory?.value === value) directory = undefined;
  });
  return value;
}

export async function loadOutingDirectory() {
  return projectOutingDirectory(await readTravelPart(12_000, loadDirectory));
}

export async function loadOutingProgrammes() {
  const now = Date.now();
  const open = getOpenNowEventWindow(now);
  const window = { fromDate: open.fromDate, beforeDate: addDaysToDateKey(open.beforeDate, 1) };
  const calendar = await readTravelPart(15_000, client => loadRecommendationWindow(client, window));
  if (calendar.error) throw new Error("Public programmes unavailable.");
  return projectOutingProgrammes(sortPublicEventsByDateVenueTimeTitle(calendar.events), now);
}
