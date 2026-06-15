import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

export type EventCategoryKind = "club" | "live" | "culture" | "event";

type EventCategoryInput = {
  artists?: readonly string[];
  eventType: string;
  title?: string;
};

export type EventMetaInput = EventCategoryInput & {
  attendance?: number | string | null;
  attendanceCount?: number | string | null;
  attendeeCount?: number | string | null;
  attendees?: number | string | null;
  attendeesCount?: number | string | null;
  going?: number | string | null;
  goingCount?: number | string | null;
  ticketPrice?: string | null;
};

type EventCategoryTone = {
  backgroundColor: string;
  color: string;
  label: "Club" | "Live" | "Culture" | "Event";
};

type EventPriceDisplay = {
  isFree: boolean;
  label: string;
};

export const EVENT_CATEGORY_TONES: Record<EventCategoryKind, EventCategoryTone> = {
  club: {
    backgroundColor: "rgba(139, 134, 251, 0.14)",
    color: "#8B86FB",
    label: "Club",
  },
  live: {
    backgroundColor: "rgba(251, 113, 133, 0.14)",
    color: "#FB7185",
    label: "Live",
  },
  culture: {
    backgroundColor: "rgba(251, 191, 36, 0.14)",
    color: "#FBBF24",
    label: "Culture",
  },
  event: {
    backgroundColor: "rgba(52, 211, 153, 0.14)",
    color: "#34D399",
    label: "Event",
  },
};

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .trim();
}

function normalizePriceLabel(value: string): string {
  return value
    .replace(/(\d)\s*(rsd|din(?:ara)?\.?)/gi, "$1 RSD")
    .replace(/\brsd\b/gi, "RSD")
    .replace(/\bRSD(?:\s+RSD\b)+/gi, "RSD")
    .replace(/\s+/g, " ")
    .trim();
}

function coerceGoingCount(value: number | string | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const count = Math.trunc(value);
    return count > 0 ? count : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const match = value.match(/\d+/);
  if (!match) {
    return null;
  }

  const count = Number.parseInt(match[0], 10);
  return Number.isFinite(count) && count > 0 ? count : null;
}

export function getEventCategoryKind(event: EventCategoryInput): EventCategoryKind {
  const eventType = normalizeSearchText(event.eventType);
  const detailText = normalizeSearchText(`${event.title ?? ""} ${(event.artists ?? []).join(" ")}`);

  if (
    eventType.includes("nightlife") ||
    eventType.includes("club") ||
    eventType.includes("party") ||
    eventType.includes("rave") ||
    eventType.includes("dj")
  ) {
    return "club";
  }

  if (
    eventType.includes("live") ||
    eventType.includes("concert") ||
    eventType.includes("music") ||
    eventType.includes("gig")
  ) {
    return "live";
  }

  if (
    eventType.includes("culture") ||
    eventType.includes("art") ||
    eventType.includes("gallery") ||
    eventType.includes("learning") ||
    eventType.includes("workshop") ||
    eventType.includes("film") ||
    eventType.includes("theater") ||
    eventType.includes("theatre") ||
    eventType.includes("exhibition")
  ) {
    return "culture";
  }

  if (
    detailText.includes("club") ||
    detailText.includes(" dj") ||
    detailText.startsWith("dj") ||
    detailText.includes("party") ||
    detailText.includes("rave") ||
    detailText.includes("techno") ||
    detailText.includes("house") ||
    detailText.includes("disco")
  ) {
    return "club";
  }

  if (
    detailText.includes("live") ||
    detailText.includes("band") ||
    detailText.includes("concert") ||
    detailText.includes("tribute") ||
    detailText.includes("rock") ||
    detailText.includes("metal") ||
    detailText.includes("jazz") ||
    detailText.includes("blues") ||
    detailText.includes("bluz")
  ) {
    return "live";
  }

  if (
    detailText.includes("exhibition") ||
    detailText.includes("izloz") ||
    detailText.includes("gallery") ||
    detailText.includes("workshop") ||
    detailText.includes("film") ||
    detailText.includes("theater") ||
    detailText.includes("theatre")
  ) {
    return "culture";
  }

  return "event";
}

export function getEventCategoryTone(event: EventCategoryInput): EventCategoryTone {
  return EVENT_CATEGORY_TONES[getEventCategoryKind(event)];
}

export function getEventPriceDisplay(value: string | null | undefined): EventPriceDisplay | null {
  const price = value?.trim();
  if (!price) {
    return null;
  }

  const normalized = normalizePriceLabel(price);
  if (/^(?:RSD|din|dinara)$/i.test(normalized)) {
    return null;
  }

  const searchable = normalizeSearchText(normalized);
  const isFree =
    /\b(free|no cover|besplatno|besplatan|slobodan ulaz|ulaz slobodan)\b/.test(searchable) ||
    /^0\s*(?:rsd|din|dinara)?$/.test(searchable);

  return {
    isFree,
    label: isFree ? "Free" : normalized,
  };
}

export function getEventGoingCount(event: EventMetaInput): number | null {
  return (
    coerceGoingCount(event.goingCount) ??
    coerceGoingCount(event.attendanceCount) ??
    coerceGoingCount(event.attendeeCount) ??
    coerceGoingCount(event.attendeesCount) ??
    coerceGoingCount(event.going) ??
    coerceGoingCount(event.attendance) ??
    coerceGoingCount(event.attendees)
  );
}

export function EventCategoryPill({
  className,
  event,
  style,
}: {
  className?: string;
  event: EventCategoryInput;
  style?: CSSProperties;
}) {
  const tone = getEventCategoryTone(event);

  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center rounded-full px-2 py-0.5 text-[10px] font-semibold leading-4",
        className,
      )}
      data-event-category={tone.label.toLowerCase()}
      style={{ backgroundColor: tone.backgroundColor, color: tone.color, ...style }}
    >
      <span className="truncate">{tone.label}</span>
    </span>
  );
}

export function EventPriceChip({
  className,
  value,
}: {
  className?: string;
  value: string | null | undefined;
}) {
  const price = getEventPriceDisplay(value);
  if (!price) {
    return null;
  }

  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center rounded-full px-2 py-0.5 text-[10px] font-semibold leading-4",
        price.isFree ? "bg-[#34D399]/[0.14] text-[#34D399]" : "bg-white/[0.06] text-foreground",
        className,
      )}
      data-event-price={price.isFree ? "free" : "paid"}
    >
      <span className="truncate">{price.label}</span>
    </span>
  );
}

export function EventMetaRow({
  className,
  event,
}: {
  className?: string;
  event: EventMetaInput;
}) {
  const goingCount = getEventGoingCount(event);
  const hasPrice = Boolean(getEventPriceDisplay(event.ticketPrice));

  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-1.5 overflow-hidden text-[12px] leading-4 text-muted-foreground",
        className,
      )}
      data-event-meta-row="true"
    >
      <EventCategoryPill className="flex-none" event={event} />
      {hasPrice ? <EventPriceChip className="flex-none" value={event.ticketPrice} /> : null}
      {goingCount ? (
        <>
          <span className="flex-none text-muted-foreground/60">·</span>
          <span className="min-w-0 truncate text-muted-foreground">{goingCount} going</span>
        </>
      ) : null}
    </div>
  );
}
