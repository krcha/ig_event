"use client";

import { useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { CALENDAR_TIME_BANDS, type CalendarTimeBandKey } from "@/lib/events/calendar-time-band-definitions";
import { DISCOVERY_CATEGORIES, MUSIC_GENRES } from "@/lib/taxonomy/event-discovery";
import { normalizeHiddenEventCategories } from "@/lib/taxonomy/event-categories";

export type DiscoveryCategory = (typeof DISCOVERY_CATEGORIES)[number]["key"];
export type DiscoveryGenre = (typeof MUSIC_GENRES)[number]["key"];
export type DiscoveryGenreFilter = DiscoveryGenre | "unknown";

export const musicIntents = ["party", "live"] as const;
export const calendarBandLabels: Record<CalendarTimeBandKey, string> = {
  daytime: "Tokom dana",
  evening: "Veče",
  night: "Noć",
  "after-midnight": "Posle ponoći",
  "time-not-announced": "Vreme nije najavljeno",
};

export function useCalendarDiscoveryFilters() {
  const params = useSearchParams();
  const category = params.get("category");
  const genre = params.get("genre");
  const time = params.get("time");
  const format = params.get("format");
  const hide = params.get("hide");
  return useMemo(() => {
    const hiddenCategories = normalizeHiddenEventCategories(hide?.split(",") ?? []);
    const categoryValues = new Set(category?.split(","));
    return {
      // Older links can carry both keys. Their exclusions are authoritative.
      categories: hiddenCategories.length ? [] : DISCOVERY_CATEGORIES.filter(({ key }) => categoryValues.has(key)).map(({ key }) => key),
      genre: genre === "unknown" ? "unknown" as const : MUSIC_GENRES.find(({ key }) => key === genre)?.key,
      time: CALENDAR_TIME_BANDS.find(({ key }) => key === time)?.key,
      format: format === "stand-up" ? "stand-up" as const : undefined,
      hiddenCategories,
    };
  }, [category, genre, time, format, hide]);
}
