import "server-only";

// Counters are background work. Share one RPC slot across month/week/filter
// scopes, leaving the backend free to serve foreground day-detail queries.
const MAX_WAITERS = 64;
let busy = false;
const waiters: Array<() => void> = [];

export async function runCalendarOverviewRead<T>(read: () => Promise<T>): Promise<T> {
  if (busy) {
    if (waiters.length >= MAX_WAITERS) throw new Error("Calendar counts are busy.");
    await new Promise<void>(resolve => waiters.push(resolve));
  } else {
    busy = true;
  }
  try {
    return await read();
  } finally {
    const next = waiters.shift();
    if (next) next(); // Transfer the reserved slot; a new caller cannot overtake it.
    else busy = false;
  }
}
