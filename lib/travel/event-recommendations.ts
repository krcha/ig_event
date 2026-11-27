import { addDaysToDateKey, getNightlifeDefaultDateKey } from "../events/nightlife-date";
import type { PublicEvent } from "../events/public-events";
import { getEventDiscoveryTaxonomy, type EventDiscoveryTaxonomy } from "../taxonomy/event-discovery";
import { compareCompassEvents, eventEndedBeforeArrival, matchesCompassMode } from "./compass";

export function getEventRecommendationWindow(referenceDate: string, now: number) {
  const tonight = getNightlifeDefaultDateKey(new Date(now));
  const fromDate = referenceDate > tonight ? referenceDate : tonight;
  return { fromDate, beforeDate: addDaysToDateKey(fromDate, 14) };
}

export type RecommendationCandidate = Pick<PublicEvent, "_id" | "title" | "venue" | "date" | "time" | "timeStatus" | "status"> & {
  eventTaxonomy: EventDiscoveryTaxonomy;
  genreEstimated: boolean;
};

export function rankEventRecommendations(reference: PublicEvent, events: readonly (PublicEvent | RecommendationCandidate)[], now: number) {
  const window = getEventRecommendationWindow(reference.date, now);
  const referenceTaxonomy = getEventDiscoveryTaxonomy(reference);
  const matches = events.flatMap((event) => {
    if (event._id === reference._id || event.status !== "approved" ||
      event.date < window.fromDate || event.date >= window.beforeDate ||
      eventEndedBeforeArrival({ date: event.date, time: event.timeStatus === "unknown" ? undefined : event.time }, now)) {
      return [];
    }
    const compact = "genreEstimated" in event;
    const match = compareCompassEvents(referenceTaxonomy, compact ? event.eventTaxonomy : getEventDiscoveryTaxonomy(event), {
      sourceEstimated: reference.performerGenreResearch?.estimated,
      candidateEstimated: compact ? event.genreEstimated : event.performerGenreResearch?.estimated,
    });
    return match ? [{ event, match }] : [];
  });

  function forMode(mode: "same" | "different") {
    const direction = mode === "same" ? -1 : 1;
    return matches.filter(({ match }) => matchesCompassMode(match.score, mode))
      .sort((a, b) => direction * (a.match.score - b.match.score) ||
        a.event.date.localeCompare(b.event.date) ||
        (a.event.time ?? "99:99").localeCompare(b.event.time ?? "99:99") ||
        a.event._id.localeCompare(b.event._id))
      .slice(0, 6);
  }

  return { same: forMode("same"), different: forMode("different") };
}
