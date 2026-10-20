import type { OpenNowEventState } from "@/lib/venues/venue-open-now";

export const OPEN_NOW_POSSIBLE_LABEL = "Possibly still on - end unconfirmed";

export function OpenNowStatus({ eventId, state }: { eventId: string; state?: OpenNowEventState }) {
  if (state !== "possible") return null;

  return (
    <span
      className="mt-1 inline-block rounded-md bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-medium leading-4 text-amber-200"
      data-open-now-event-id={eventId}
      data-open-now-status="possible"
    >
      {OPEN_NOW_POSSIBLE_LABEL}
    </span>
  );
}
