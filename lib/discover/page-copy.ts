import { addDaysToDateKey, parseDateKeyToUtcNoon } from "../events/nightlife-date.ts";

export function getDiscoverPageCopy(selectedDate: string, today: string) {
  const date = parseDateKeyToUtcNoon(selectedDate);
  const dateLabel = date
    ? new Intl.DateTimeFormat("en-US", {
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "Europe/Belgrade",
      }).format(date)
    : selectedDate;
  const when = selectedDate === today
    ? "tonight"
    : selectedDate === addDaysToDateKey(today, 1)
      ? "tomorrow"
      : `on ${dateLabel}`;

  return {
    title: `Belgrade events ${when}`,
    description: `Find concerts, club nights, DJ sets, exhibitions, and other events in Belgrade ${when}. See venues, announced times, and original event posts.`,
    introduction: `Concerts, club nights, DJ sets, and culture in Belgrade ${when}.`,
  };
}
