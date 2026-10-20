import type { CSSProperties } from "react";
import type { EventDayPeriod } from "@/lib/events/event-time";
import {
  EVENT_PRIMARY_CATEGORIES,
  getEventPrimaryCategory,
  getEventTags,
  isFreeEventAdmission,
  type EventCategoryInput,
  type EventPrimaryCategory,
} from "@/lib/taxonomy/event-categories";
import { cn } from "@/lib/utils";

export type EventCategoryKind = EventPrimaryCategory;

export type EventMetaInput = EventCategoryInput & {
  attendance?: number | string | null;
  attendanceCount?: number | string | null;
  attendeeCount?: number | string | null;
  attendees?: number | string | null;
  attendeesCount?: number | string | null;
  going?: number | string | null;
  goingCount?: number | string | null;
  ticketPrice?: string | null;
  dayPeriod?: EventDayPeriod | null;
};

type EventCategoryTone = {
  backgroundColor: string;
  color: string;
  label: string;
};

type EventPriceDisplay = {
  isFree: boolean;
  label: string;
};

type EventDayPeriodTone = {
  backgroundColor: string;
  color: string;
  label: "Day" | "Night";
};

const EVENT_CATEGORY_LABELS = Object.fromEntries(
  EVENT_PRIMARY_CATEGORIES.map((category) => [category.key, category.label]),
) as Record<EventCategoryKind, string>;

export const EVENT_CATEGORY_TONES: Record<EventCategoryKind, EventCategoryTone> = {
  club: {
    backgroundColor: "rgba(139, 134, 251, 0.14)",
    color: "#8B86FB",
    label: EVENT_CATEGORY_LABELS.club,
  },
  live: {
    backgroundColor: "rgba(251, 113, 133, 0.14)",
    color: "#FB7185",
    label: EVENT_CATEGORY_LABELS.live,
  },
  culture: {
    backgroundColor: "rgba(251, 191, 36, 0.14)",
    color: "#FBBF24",
    label: EVENT_CATEGORY_LABELS.culture,
  },
  social: {
    backgroundColor: "rgba(125, 211, 252, 0.14)",
    color: "#7DD3FC",
    label: EVENT_CATEGORY_LABELS.social,
  },
  event: {
    backgroundColor: "rgba(52, 211, 153, 0.14)",
    color: "#34D399",
    label: EVENT_CATEGORY_LABELS.event,
  },
};

export const EVENT_DAY_PERIOD_TONES: Record<"day" | "night", EventDayPeriodTone> = {
  day: {
    backgroundColor: "rgba(125, 211, 252, 0.16)",
    color: "#7DD3FC",
    label: "Day",
  },
  night: {
    backgroundColor: "rgba(167, 139, 250, 0.14)",
    color: "#A78BFA",
    label: "Night",
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
  return getEventPrimaryCategory(event);
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

  const isFree = isFreeEventAdmission(normalized);

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
  const category = getEventCategoryKind(event);
  const tone = EVENT_CATEGORY_TONES[category];

  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center rounded-full px-2 py-0.5 text-[10px] font-semibold leading-4",
        className,
      )}
      data-event-category={category}
      style={{ backgroundColor: tone.backgroundColor, color: tone.color, ...style }}
    >
      <span className="truncate">{tone.label}</span>
    </span>
  );
}

export function EventSecondaryTags({
  className,
  event,
  limit,
}: {
  className?: string;
  event: EventCategoryInput;
  limit?: number;
}) {
  // Free entry already has a dedicated price chip alongside these tags.
  const tags = getEventTags(event).filter((tag) => normalizeSearchText(tag) !== "besplatan ulaz");
  const visibleTags = limit === undefined ? tags : tags.slice(0, limit);

  return visibleTags.map((tag) => (
    <span
      className={cn(
        "inline-flex max-w-full items-center rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] font-medium leading-4 text-muted-foreground",
        className,
      )}
      data-event-tag={tag}
      key={tag}
    >
      <span className="truncate">{tag}</span>
    </span>
  ));
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

export function EventDayPeriodChip({
  className,
  value,
}: {
  className?: string;
  value: EventDayPeriod | null | undefined;
}) {
  if (value !== "day" && value !== "night") {
    return null;
  }

  const tone = EVENT_DAY_PERIOD_TONES[value];
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center rounded-full px-2 py-0.5 text-[10px] font-semibold leading-4",
        className,
      )}
      data-event-day-period={value}
      style={{ backgroundColor: tone.backgroundColor, color: tone.color }}
    >
      <span className="truncate">{tone.label}</span>
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
      <EventCategoryPill className="min-w-0" event={event} />
      <EventDayPeriodChip className="flex-none" value={event.dayPeriod} />
      {hasPrice ? <EventPriceChip className="flex-none" value={event.ticketPrice} /> : null}
      <EventSecondaryTags className="hidden flex-none sm:inline-flex" event={event} limit={2} />
      {goingCount ? (
        <>
          <span className="flex-none text-muted-foreground/60">·</span>
          <span className="min-w-0 truncate text-muted-foreground">{goingCount} going</span>
        </>
      ) : null}
    </div>
  );
}
