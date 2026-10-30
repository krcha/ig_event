import { addDaysToDateKey, parseDateKeyToUtcNoon } from "./nightlife-date";

const WEEKDAY_LABELS = ["Ned", "Pon", "Uto", "Sre", "Čet", "Pet", "Sub"];
const WEEKDAY_ACCUSATIVE = ["nedelju", "ponedeljak", "utorak", "sredu", "četvrtak", "petak", "subotu"];

export function getMobileWeekDateKeys(todayKey: string): string[] {
  return Array.from({ length: 7 }, (_, index) => addDaysToDateKey(todayKey, index));
}

// Month counters already cover part (or all) of the mobile week. Only request
// the uncovered dates, including when the week crosses a month/year boundary.
export function getMobileWeekOverviewWindows(
  todayKey: string,
  covered?: { fromDate: string; beforeDate: string },
): Array<{ fromDate: string; beforeDate: string }> {
  const beforeDate = addDaysToDateKey(todayKey, 7);
  if (!covered || covered.beforeDate <= todayKey || covered.fromDate >= beforeDate) {
    return [{ fromDate: todayKey, beforeDate }];
  }
  const windows = [];
  if (todayKey < covered.fromDate) {
    windows.push({ fromDate: todayKey, beforeDate: covered.fromDate });
  }
  if (beforeDate > covered.beforeDate) {
    windows.push({ fromDate: covered.beforeDate, beforeDate });
  }
  return windows;
}

export function getMobileDayHeading(dayKey: string, todayKey: string): string {
  if (dayKey === todayKey) return "Gde danas?";
  if (dayKey === addDaysToDateKey(todayKey, 1)) return "Gde sutra?";
  const day = parseDateKeyToUtcNoon(dayKey)?.getUTCDay();
  return day === undefined ? "Gde danas?" : `Gde u ${WEEKDAY_ACCUSATIVE[day]}?`;
}

export function getMobileDayLabel(dayKey: string, todayKey: string): string {
  if (dayKey === todayKey) return "Danas";
  if (dayKey === addDaysToDateKey(todayKey, 1)) return "Sutra";
  return WEEKDAY_LABELS[parseDateKeyToUtcNoon(dayKey)?.getUTCDay() ?? 0];
}

export function getMobileWeekFill(eventCount: number, maxEventCount: number): number {
  return Math.max(6, Math.min(100, (Math.max(0, eventCount) / Math.max(1, maxEventCount)) * 100));
}
