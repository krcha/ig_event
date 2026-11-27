import { addDaysToDateKey, getNightlifeDefaultDateKey } from "../events/nightlife-date";
import { normalizeEventTime } from "../events/event-time";
import { createBelgradeInstantResolver, getBelgradeNow } from "../venues/venue-open-now";

export const PRIORITY_CATEGORY_VERSION = 1;
export const UPCOMING_DAILY_BUDGET = 96;
const HOUR = 3_600_000;

export type CategoryScanPhase = "confirmed" | "undated" | "boundary";
type WindowEvent = { date: string; time?: string; timeStatus?: string };

export function categoryWindow(now: number) {
  const start = getBelgradeNow(now), until = now + 48 * HOUR;
  const end = getBelgradeNow(until);
  const throughDate = end.date;
  const fromDate = addDaysToDateKey(start.date, -1);
  const outing = getNightlifeDefaultDateKey(new Date(now));
  const resolve = createBelgradeInstantResolver();
  function unscheduled(date: string): CategoryScanPhase | "local-only" | undefined {
    if (date < outing || (date === throughDate && end.minuteOfDay === 0 && until % 60_000 === 0)) return;
    if (date < start.date) return "local-only";
    return date === throughDate ? "boundary" : "undated";
  }
  function tier(event: WindowEvent): CategoryScanPhase | "local-only" | undefined {
    if (event.date < fromDate || event.date > throughDate) return;
    const time = normalizeEventTime(event.timeStatus === "confirmed" ? event.time : undefined);
    if (!time.startLabel) return unscheduled(event.date);
    const wall = (label: string) => Date.parse(`${event.date}T${label}:00Z`) / 60_000;
    const first = resolve(wall(time.startLabel), "start");
    if (first === null) return unscheduled(event.date); // An announced time inside the spring clock gap is uncertain.
    let lastWall = time.endLabel ? wall(time.endLabel) : wall(time.startLabel);
    if (time.endLabel && time.endLabel <= time.startLabel) lastWall += 1440;
    const last = resolve(lastWall, "end");
    if (first >= until) return;
    if (last === null) return unscheduled(event.date);
    if (last + (time.endLabel ? 0 : 60_000) > now) return "confirmed";
  }
  return { fromDate, throughDate, tier, includes: (event: WindowEvent) => tier(event) !== undefined };
}

export function discoveryBudgets(now: number, state: { dayKey: string; attempted: number;
  categoryBudget?: { dayKey: string; attempted: number; consecutive: number } } | null) {
  const { date: dayKey, minuteOfDay } = getBelgradeNow(now);
  const total = state?.dayKey === dayKey ? state.attempted : 0;
  const priority = state?.categoryBudget?.dayKey === dayKey ? state.categoryBudget : { dayKey, attempted: 0, consecutive: 0 };
  const remaining = Math.max(0, UPCOMING_DAILY_BUDGET - total);
  // Keep 24 slots for late-arriving urgent events through the afternoon; also
  // keep at least 24 for the continuing full-calendar and genre sweep.
  const general = minuteOfDay < 18 * 60 ? Math.min(remaining, Math.max(0, 72 - (total - priority.attempted))) : remaining;
  const regularTurn = priority.consecutive >= 3 && general > 0 && remaining > 12;
  const urgent = regularTurn ? 0 : Math.min(remaining, Math.max(0, 72 - priority.attempted));
  return { dayKey, total, priority, general, urgent };
}
