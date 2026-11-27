import { addDaysToDateKey, getNightlifeDefaultDateKey } from "../events/nightlife-date";
import { normalizeEventTime } from "../events/event-time";
import { createBelgradeInstantResolver, getBelgradeNow } from "../venues/venue-open-now";

export const PRIORITY_CATEGORY_VERSION = 1;
export const UPCOMING_DAILY_BUDGET = 96;
const HOUR = 3_600_000;

export function categoryWindow(now: number) {
  const start = getBelgradeNow(now), until = now + 48 * HOUR;
  const throughDate = getBelgradeNow(until).date;
  const fromDate = addDaysToDateKey(start.date, -1);
  const outing = getNightlifeDefaultDateKey(new Date(now));
  const resolve = createBelgradeInstantResolver();
  return { fromDate, throughDate, includes(event: { date: string; time?: string; timeStatus?: string }) {
    if (event.date < fromDate || event.date > throughDate) return false;
    const time = normalizeEventTime(event.timeStatus === "confirmed" ? event.time : undefined);
    if (!time.startLabel) return event.date >= outing;
    const wall = (label: string) => Date.parse(`${event.date}T${label}:00Z`) / 60_000;
    const first = resolve(wall(time.startLabel), "start");
    if (first === null) return event.date >= outing; // An announced time inside the spring clock gap is uncertain.
    let lastWall = time.endLabel ? wall(time.endLabel) : wall(time.startLabel);
    if (time.endLabel && time.endLabel <= time.startLabel) lastWall += 1440;
    const last = resolve(lastWall, "end");
    return first < until && (last === null ? event.date >= outing : last + (time.endLabel ? 0 : 60_000) > now);
  } };
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
  const urgent = priority.consecutive >= 3 && general > 0 ? 0 : Math.min(remaining, Math.max(0, 72 - priority.attempted));
  return { dayKey, total, priority, general, urgent };
}
