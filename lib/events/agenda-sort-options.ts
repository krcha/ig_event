import type { CalendarTimeBandKey } from "./calendar-time-band-definitions";

export type AgendaSortMode = "time" | "late" | "title" | "venue";
export const AGENDA_SORT_OPTIONS: readonly { value: AgendaSortMode; label: string }[] = [
  { value: "time", label: "Po vremenu" },
  { value: "late", label: "Kasnije prvo" },
  { value: "title", label: "Po nazivu" },
  { value: "venue", label: "Po imenu mesta" },
];
export const AGENDA_BAND_ORDER: Record<"time" | "late", readonly CalendarTimeBandKey[]> = {
  time: ["daytime", "evening", "night", "time-not-announced", "after-midnight"],
  late: ["after-midnight", "night", "evening", "daytime", "time-not-announced"],
};
export function normalizeAgendaSortMode(value?: string): AgendaSortMode {
  return value === "late" || value === "title" || value === "venue" ? value : "time";
}
