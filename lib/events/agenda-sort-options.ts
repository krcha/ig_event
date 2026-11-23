import type { CalendarTimeBandKey } from "./calendar-time-band-definitions";

export const AGENDA_SORT_OPTIONS = [
  { value: "time", label: "Po vremenu" },
  { value: "popularity", label: "Po popularnosti" },
  { value: "venue", label: "Po imenu mesta" },
  { value: "distance", label: "Udaljeno od mene" },
] as const;
export type AgendaSortMode = (typeof AGENDA_SORT_OPTIONS)[number]["value"];

export const AGENDA_BAND_ORDER: readonly CalendarTimeBandKey[] = [
  "daytime", "evening", "night", "time-not-announced", "after-midnight",
];

export function normalizeAgendaSortMode(value?: string): AgendaSortMode {
  return AGENDA_SORT_OPTIONS.find((option) => option.value === value)?.value ?? "time";
}
