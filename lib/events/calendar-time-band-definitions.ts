export type CalendarTimeBandKey =
  | "after-midnight"
  | "daytime"
  | "evening"
  | "night"
  | "time-not-announced";

export type CalendarTimeBandDefinition = {
  key: CalendarTimeBandKey;
  label: string;
  description: string;
};


export const CALENDAR_TIME_BANDS: readonly CalendarTimeBandDefinition[] = [
  {
    key: "after-midnight",
    label: "After midnight",
    description: "00:00-05:59",
  },
  {
    key: "daytime",
    label: "Daytime",
    description: "06:00-17:59",
  },
  {
    key: "evening",
    label: "Evening",
    description: "18:00-21:59",
  },
  {
    key: "night",
    label: "Night",
    description: "22:00-23:59",
  },
  {
    key: "time-not-announced",
    label: "Time not announced",
    description: "No source-confirmed start time",
  },
] as const;
