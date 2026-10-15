import { getEventSessionLabel, type EventSessionInput } from "@/lib/events/event-session";
import { cn } from "@/lib/utils";

export function EventSessionLabel({
  className,
  event,
}: {
  className?: string;
  event: EventSessionInput;
}) {
  const label = getEventSessionLabel(event);
  if (!label) return null;

  return (
    <span
      className={cn("mt-1 block text-xs font-semibold leading-5 tabular-nums text-primary", className)}
      data-event-session="true"
    >
      {label}
    </span>
  );
}
