import {
  formatVenueHoursWindow,
  parseVenueHoursJson,
  type VenueHoursSource,
} from "@/lib/venues/venue-hours-cache";
import { cn } from "@/lib/utils";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Venue-friendly order, Monday first. Underlying weekly array is 0 = Sunday.
const DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

const SOURCE_LABELS: Partial<Record<VenueHoursSource, string>> = {
  google: "Hours via Google",
  manual: "Hours set manually",
  osm: "Hours via OpenStreetMap",
};

type VenueWeeklyHoursProps = {
  className?: string;
  hoursJson: string | null | undefined;
  hoursSource?: VenueHoursSource | null;
};

export function VenueWeeklyHours({ className, hoursJson, hoursSource }: VenueWeeklyHoursProps) {
  const parsed = parseVenueHoursJson(hoursJson);
  if (!parsed || !parsed.weekly.some((day) => day.windows.length > 0)) {
    return null;
  }

  const byDay = new Map(parsed.weekly.map((day) => [day.day, day]));
  const attribution = hoursSource ? SOURCE_LABELS[hoursSource] : undefined;

  return (
    <section className={cn("rounded-xl border border-border/70 bg-white/[0.02] p-4", className)}>
      <h3 className="text-sm font-medium text-foreground">Venue hours</h3>
      <dl className="mt-3 space-y-1.5">
        {DISPLAY_ORDER.map((dayIndex) => {
          const day = byDay.get(dayIndex);
          const isClosed = !day || day.closed || day.windows.length === 0;
          return (
            <div key={dayIndex} className="flex items-baseline justify-between gap-4 text-sm">
              <dt className="text-muted-foreground">{DAY_LABELS[dayIndex]}</dt>
              <dd className={cn("text-right tabular-nums", isClosed && "text-muted-foreground/70")}>
                {isClosed
                  ? "Closed"
                  : day.windows.map((window) => formatVenueHoursWindow(window)).join(", ")}
              </dd>
            </div>
          );
        })}
      </dl>
      {attribution ? <p className="mt-3 text-xs text-muted-foreground/80">{attribution}</p> : null}
    </section>
  );
}
