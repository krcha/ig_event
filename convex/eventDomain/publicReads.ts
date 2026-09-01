import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { paginateVisibleRows } from "../../lib/domain/publication/visible-pagination";
import {
  decodePublicationCursor,
  encodePublicationCursor,
} from "../../lib/domain/publication/cursor";
import {
  buildApprovedEventAutoCleanupGroups,
  type ApprovedEventDuplicateRecord,
} from "../../lib/events/approved-event-duplicates";
import {
  HUMAN_REVIEWED_LEGACY_SOURCE_POLICY_VERSION,
  hasHumanReviewedLegacySourcePolicyMarker,
} from "../../lib/events/event-update-precondition";
import { hasCrossPostCampaignAggregateAttestationField } from "../../lib/events/cross-post-campaign-aggregate-attestation";
import { isVenuePublic } from "../../lib/venues/venue-lifecycle";
import { requireAdminOrServiceSecret } from "../authz";
import { projectPublicEvent } from "../publicEventProjection";
import { isEventPubliclyVisible } from "../publicationPolicy";
import {
  resolvePublicationReadMode,
  type PublicationReadMode,
} from "../publicationCutover";

const PUBLIC_EVENT_PAGE_SIZE = 50;
const MAX_PUBLIC_EVENT_WINDOW_DAYS = 400;
const MAX_PUBLIC_CALENDAR_WINDOW_DAYS = 45;
const PUBLIC_DUPLICATE_DATE_COHORT_LIMIT = 25;
const DISCOVER_ORGANIC_SCAN_LIMIT = 120;
const DISCOVER_PROMOTION_SCAN_LIMIT = 120;

type PublicPaginationOptions = {
  cursor: string | null;
  numItems: number;
};

function buildPublicPaginationOptions(options: PublicPaginationOptions) {
  const requested = Number.isFinite(options.numItems)
    ? Math.trunc(options.numItems)
    : 1;
  return {
    cursor: options.cursor,
    numItems: Math.max(1, Math.min(PUBLIC_EVENT_PAGE_SIZE, requested)),
  };
}

async function paginatePublicationRows<TRaw, TVisible>(options: {
  cursor: string | null;
  loadRawPage: (options: {
    cursor: string | null;
    numItems: number;
  }) => Promise<{ continueCursor: string; isDone: boolean; page: TRaw[] }>;
  mode: PublicationReadMode;
  numItems: number;
  projectVisible: (rows: TRaw[]) => Promise<TVisible[]>;
}) {
  const page = await paginateVisibleRows({
    cursor: decodePublicationCursor(options.cursor, options.mode),
    loadRawPage: options.loadRawPage,
    numItems: options.numItems,
    projectVisible: options.projectVisible,
  });
  return {
    ...page,
    continueCursor: encodePublicationCursor(page.continueCursor, options.mode),
  };
}

function readDateParts(
  value: string,
): { day: number; month: number; year: number } | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day)
  ) {
    return null;
  }
  return { day, month, year };
}

function formatDateKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(
    2,
    "0",
  )}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function dateKeyToUtcMs(value: string): number | null {
  const parts = readDateParts(value);
  if (!parts) return null;
  const timestamp = Date.UTC(parts.year, parts.month - 1, parts.day);
  return formatDateKey(new Date(timestamp)) === value ? timestamp : null;
}

export function assertPublicEventDateWindow(
  fromDate: string,
  beforeDate: string,
  maximumDays: number,
): void {
  const fromTimestamp = dateKeyToUtcMs(fromDate);
  const beforeTimestamp = dateKeyToUtcMs(beforeDate);
  const spanDays =
    fromTimestamp === null || beforeTimestamp === null
      ? Number.NaN
      : (beforeTimestamp - fromTimestamp) / 86_400_000;
  if (!Number.isInteger(spanDays) || spanDays < 1 || spanDays > maximumDays) {
    throw new Error(
      `Public event date window must span 1-${maximumDays} days using valid YYYY-MM-DD dates.`,
    );
  }
}

function addDaysToDateKey(value: string, days: number): string {
  const parts = readDateParts(value);
  if (!parts) return value;
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  date.setUTCDate(date.getUTCDate() + days);
  return formatDateKey(date);
}

function getUtcDayForDateKey(value: string): number {
  const parts = readDateParts(value);
  if (!parts) return 1;
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

function getUpcomingWeekendDates(today: string): Set<string> {
  const day = getUtcDayForDateKey(today);
  const startOffset = day >= 1 && day <= 4 ? 5 - day : 0;
  const endOffset =
    day === 5 ? 2 : day === 6 ? 1 : day === 0 ? 0 : startOffset + 2;
  const dates = new Set<string>();
  for (let offset = startOffset; offset <= endOffset; offset += 1) {
    const date = addDaysToDateKey(today, offset);
    const dateDay = getUtcDayForDateKey(date);
    if (dateDay === 5 || dateDay === 6 || dateDay === 0) dates.add(date);
  }
  return dates;
}

async function loadPublicVenueIdsForEvents(
  ctx: QueryCtx,
  events: Doc<"events">[],
): Promise<Set<Id<"venues">>> {
  const venueIds = [
    ...new Set(
      events
        .map((event) => event.venueId)
        .filter((id): id is Id<"venues"> => id !== undefined),
    ),
  ];
  const venues = await Promise.all(
    venueIds.map((venueId) => ctx.db.get(venueId)),
  );
  return new Set(
    venues
      .filter(
        (venue): venue is Doc<"venues"> =>
          venue !== null && isVenuePublic(venue),
      )
      .map((venue) => venue._id),
  );
}

async function projectCanonicallyGroundedPublicEventPage(
  ctx: QueryCtx,
  groundedEvents: Doc<"events">[],
) {
  const publicVenueIds = await loadPublicVenueIdsForEvents(ctx, groundedEvents);
  return groundedEvents.map((event) =>
    projectPublicEvent(
      event,
      event.venueId !== undefined && publicVenueIds.has(event.venueId),
    ),
  );
}

async function projectPublicEventPage(ctx: QueryCtx, events: Doc<"events">[]) {
  const visibility = await Promise.all(
    events.map((event) => isEventPubliclyVisible(ctx, event)),
  );
  return projectCanonicallyGroundedPublicEventPage(
    ctx,
    events.filter((_, index) => visibility[index]),
  );
}

function usesEventEvidenceV2(event: Doc<"events">): boolean {
  try {
    const normalized = JSON.parse(
      event.normalizedFieldsJson ?? "null",
    ) as unknown;
    if (
      normalized &&
      typeof normalized === "object" &&
      !Array.isArray(normalized) &&
      ((normalized as Record<string, unknown>).extractionContractVersion ===
        "event_evidence_v2" ||
        (normalized as Record<string, unknown>).sourceGroundingVersion === 5 ||
        (normalized as Record<string, unknown>).sourceGroundingEvidence ===
          "persisted_openai_event_evidence_v2")
    ) {
      return true;
    }
  } catch {
    // A valid raw extraction contract below can still identify the row.
  }
  try {
    const raw = JSON.parse(event.rawExtractionJson ?? "null") as unknown;
    return Boolean(
      raw &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      (raw as Record<string, unknown>).extraction_contract_version ===
        "event_evidence_v2",
    );
  } catch {
    return false;
  }
}

async function filterLegacyCompatiblePublicEvents(
  ctx: QueryCtx,
  events: Doc<"events">[],
): Promise<Doc<"events">[]> {
  const visibility = await Promise.all(
    events.map((event) => {
      const requiresLiveGroundingCheck =
        hasCrossPostCampaignAggregateAttestationField(
          event.normalizedFieldsJson,
        ) ||
        usesEventEvidenceV2(event) ||
        event.humanReviewedLegacySourcePolicyVersion ===
          HUMAN_REVIEWED_LEGACY_SOURCE_POLICY_VERSION ||
        hasHumanReviewedLegacySourcePolicyMarker(event.normalizedFieldsJson);
      return isEventPubliclyVisible(ctx, event, {
        allowNeverMigratedApproved: !requiresLiveGroundingCheck,
      });
    }),
  );
  return events.filter((_, index) => visibility[index]);
}

async function projectLegacyCompatiblePublicEventPage(
  ctx: QueryCtx,
  events: Doc<"events">[],
) {
  return projectCanonicallyGroundedPublicEventPage(
    ctx,
    await filterLegacyCompatiblePublicEvents(ctx, events),
  );
}

function toApprovedEventDuplicateRecord(
  event: Doc<"events">,
): ApprovedEventDuplicateRecord {
  return {
    id: event._id,
    title: event.title,
    date: event.date,
    time: event.time ?? null,
    venue: event.venue,
    artists: event.artists,
    description: event.description ?? null,
    imageUrl: event.imageUrl ?? null,
    instagramPostUrl: event.instagramPostUrl ?? null,
    instagramPostId: event.instagramPostId ?? null,
    ticketPrice: event.ticketPrice ?? null,
    eventType: event.eventType,
    sourceCaption: event.sourceCaption ?? null,
    sourcePostedAt: event.sourcePostedAt ?? null,
    normalizedFieldsJson: event.normalizedFieldsJson ?? null,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

async function loadApprovedDateCohort(
  ctx: QueryCtx,
  date: string,
): Promise<Doc<"events">[] | null> {
  const cohort = await ctx.db
    .query("events")
    .withIndex("by_status_date", (q) =>
      q.eq("status", "approved").eq("date", date),
    )
    .take(PUBLIC_DUPLICATE_DATE_COHORT_LIMIT + 1);
  if (cohort.length > PUBLIC_DUPLICATE_DATE_COHORT_LIMIT) return null;
  const visibility = await Promise.all(
    cohort.map((event) => isEventPubliclyVisible(ctx, event)),
  );
  return cohort.filter((_, index) => visibility[index]);
}

export async function getPublicDuplicateEventIds(
  ctx: QueryCtx,
  page: Doc<"events">[],
): Promise<Set<Id<"events">>> {
  if (page.length === 0) return new Set();
  const eventsByDate = new Map<string, Doc<"events">[]>();
  for (const event of page) {
    const cohort = eventsByDate.get(event.date) ?? [];
    cohort.push(event);
    eventsByDate.set(event.date, cohort);
  }
  const boundaryDates = new Set([page[0].date, page[page.length - 1].date]);
  for (const date of boundaryDates) {
    const completeCohort = await loadApprovedDateCohort(ctx, date);
    if (completeCohort === null) eventsByDate.delete(date);
    else eventsByDate.set(date, completeCohort);
  }
  const duplicateIds = new Set<Id<"events">>();
  for (const cohort of eventsByDate.values()) {
    if (
      cohort.length < 2 ||
      cohort.length > PUBLIC_DUPLICATE_DATE_COHORT_LIMIT
    ) {
      continue;
    }
    const groups = buildApprovedEventAutoCleanupGroups(
      cohort.map(toApprovedEventDuplicateRecord),
    );
    for (const group of groups) {
      for (const duplicateId of group.duplicateEventIds) {
        duplicateIds.add(duplicateId as Id<"events">);
      }
    }
  }
  return duplicateIds;
}

/**
 * Single public-window storage boundary. Materialized-publication cutover must
 * switch indexes here, while the compatibility and rollback paths continue to
 * share identical cursor semantics and visibility projection.
 */
async function loadApprovedWindowRawPage(
  ctx: QueryCtx,
  mode: PublicationReadMode,
  options: {
    beforeDate?: string;
    cursor: string | null;
    fromDate: string;
    numItems: number;
  },
) {
  const pagination = {
    cursor: options.cursor,
    numItems: options.numItems,
  };
  if (mode === "materialized") {
    return ctx.db
      .query("events")
      .withIndex("by_publicationState_date", (q) => {
        const publishable = q
          .eq("publicationState", "publishable")
          .gte("date", options.fromDate);
        return options.beforeDate
          ? publishable.lt("date", options.beforeDate)
          : publishable;
      })
      .paginate(pagination);
  }
  return ctx.db
    .query("events")
    .withIndex("by_status_date", (q) => {
      const approved = q.eq("status", "approved").gte("date", options.fromDate);
      return options.beforeDate
        ? approved.lt("date", options.beforeDate)
        : approved;
    })
    .paginate(pagination);
}

export async function getPublicApprovedEventHandler(
  ctx: QueryCtx,
  args: { id: string },
) {
  const eventId = ctx.db.normalizeId("events", args.id);
  if (!eventId) return null;
  const event = await ctx.db.get(eventId);
  if (!event || event.status !== "approved") return null;
  return (
    (await projectLegacyCompatiblePublicEventPage(ctx, [event]))[0] ?? null
  );
}

export async function listPublicEventsWindowHandler(
  ctx: QueryCtx,
  args: {
    beforeDate: string;
    fromDate: string;
    paginationOpts: PublicPaginationOptions;
  },
) {
  assertPublicEventDateWindow(
    args.fromDate,
    args.beforeDate,
    MAX_PUBLIC_EVENT_WINDOW_DAYS,
  );
  const pagination = buildPublicPaginationOptions(args.paginationOpts);
  const readMode = await resolvePublicationReadMode(ctx);
  return paginatePublicationRows({
    cursor: pagination.cursor,
    mode: readMode,
    numItems: pagination.numItems,
    loadRawPage: ({ cursor, numItems }) =>
      loadApprovedWindowRawPage(ctx, readMode, {
        beforeDate: args.beforeDate,
        cursor,
        fromDate: args.fromDate,
        numItems,
      }),
    projectVisible: (events) =>
      projectLegacyCompatiblePublicEventPage(ctx, events),
  });
}

function toPublicCalendarEvent(event: ReturnType<typeof projectPublicEvent>) {
  return {
    _id: event._id,
    artists: event.artists,
    date: event.date,
    eventType: event.eventType,
    status: event.status,
    title: event.title,
    venue: event.venue,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    ...(event.instagramPostId
      ? { instagramPostId: event.instagramPostId }
      : {}),
    ...(event.instagramPostUrl
      ? { instagramPostUrl: event.instagramPostUrl }
      : {}),
    ...(event.ticketPrice ? { ticketPrice: event.ticketPrice } : {}),
    ...(event.time ? { time: event.time } : {}),
    ...(event.timeSource ? { timeSource: event.timeSource } : {}),
    ...(event.timeEvidenceText
      ? { timeEvidenceText: event.timeEvidenceText }
      : {}),
    ...(event.timeConfidence !== undefined
      ? { timeConfidence: event.timeConfidence }
      : {}),
    ...(event.timeStatus ? { timeStatus: event.timeStatus } : {}),
    ...(event.venueCategory ? { venueCategory: event.venueCategory } : {}),
    ...(event.venueId ? { venueId: event.venueId } : {}),
    ...(event.venueInstagramHandle
      ? { venueInstagramHandle: event.venueInstagramHandle }
      : {}),
    ...(event.venueLatitude !== undefined
      ? { venueLatitude: event.venueLatitude }
      : {}),
    ...(event.venueLocation ? { venueLocation: event.venueLocation } : {}),
    ...(event.venueLongitude !== undefined
      ? { venueLongitude: event.venueLongitude }
      : {}),
  };
}

export async function listPublicCalendarEventsWindowPaginatedHandler(
  ctx: QueryCtx,
  args: { beforeDate: string; cursor?: string | null; fromDate: string },
) {
  assertPublicEventDateWindow(
    args.fromDate,
    args.beforeDate,
    MAX_PUBLIC_CALENDAR_WINDOW_DAYS,
  );
  const readMode = await resolvePublicationReadMode(ctx);
  return paginatePublicationRows({
    cursor: args.cursor ?? null,
    mode: readMode,
    numItems: PUBLIC_EVENT_PAGE_SIZE,
    loadRawPage: ({ cursor, numItems }) =>
      loadApprovedWindowRawPage(ctx, readMode, {
        beforeDate: args.beforeDate,
        cursor,
        fromDate: args.fromDate,
        numItems,
      }),
    projectVisible: async (events) =>
      (await projectLegacyCompatiblePublicEventPage(ctx, events)).map(
        toPublicCalendarEvent,
      ),
  });
}

export async function listApprovedUpcomingByDatePaginatedHandler(
  ctx: QueryCtx,
  args: {
    fromDate: string;
    paginationOpts: PublicPaginationOptions;
    serviceSecret?: string;
  },
) {
  await requireAdminOrServiceSecret(ctx, args.serviceSecret);
  const pagination = buildPublicPaginationOptions(args.paginationOpts);
  const readMode = await resolvePublicationReadMode(ctx);
  return paginatePublicationRows({
    cursor: pagination.cursor,
    mode: readMode,
    numItems: pagination.numItems,
    loadRawPage: ({ cursor, numItems }) =>
      loadApprovedWindowRawPage(ctx, readMode, {
        cursor,
        fromDate: args.fromDate,
        numItems,
      }),
    projectVisible: (events) => projectPublicEventPage(ctx, events),
  });
}

function isPromotionActive(
  event: { promotionEnd?: string; promotionStart?: string },
  today: string,
): boolean {
  return Boolean(
    event.promotionStart &&
    event.promotionEnd &&
    event.promotionStart <= today &&
    today <= event.promotionEnd,
  );
}

function comparePromotionEvents(
  left: {
    _id: Id<"events">;
    date: string;
    promotionPriority?: number;
    title: string;
  },
  right: {
    _id: Id<"events">;
    date: string;
    promotionPriority?: number;
    title: string;
  },
): number {
  const priorityDelta =
    (left.promotionPriority ?? Number.POSITIVE_INFINITY) -
    (right.promotionPriority ?? Number.POSITIVE_INFINITY);
  if (priorityDelta !== 0) return priorityDelta;
  const dateResult = left.date.localeCompare(right.date);
  if (dateResult !== 0) return dateResult;
  const titleResult = left.title.localeCompare(right.title, undefined, {
    sensitivity: "base",
  });
  return titleResult !== 0 ? titleResult : left._id.localeCompare(right._id);
}

function compareOrganicEvents(
  left: { _id: Id<"events">; date: string; time?: string; title: string },
  right: { _id: Id<"events">; date: string; time?: string; title: string },
): number {
  const dateResult = left.date.localeCompare(right.date);
  if (dateResult !== 0) return dateResult;
  const timeResult = (left.time ?? "99:99").localeCompare(
    right.time ?? "99:99",
  );
  if (timeResult !== 0) return timeResult;
  const titleResult = left.title.localeCompare(right.title, undefined, {
    sensitivity: "base",
  });
  return titleResult !== 0 ? titleResult : left._id.localeCompare(right._id);
}

function hasFreeTicketPrice(value: string | undefined): boolean {
  const normalized = value
    ?.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return (
    !normalized ||
    normalized === "0" ||
    normalized === "free" ||
    normalized === "besplatno" ||
    normalized === "slobodan ulaz" ||
    normalized === "slobodne donacije" ||
    normalized === "donacije"
  );
}

function loadPromotionCandidates(
  ctx: QueryCtx,
  mode: PublicationReadMode,
  tier: "featured" | "promoted",
) {
  return mode === "materialized"
    ? ctx.db
        .query("events")
        .withIndex("by_publicationState_promotionTier", (q) =>
          q.eq("publicationState", "publishable").eq("promotionTier", tier),
        )
        .take(DISCOVER_PROMOTION_SCAN_LIMIT + 1)
    : ctx.db
        .query("events")
        .withIndex("by_status_promotionTier", (q) =>
          q.eq("status", "approved").eq("promotionTier", tier),
        )
        .take(DISCOVER_PROMOTION_SCAN_LIMIT + 1);
}

function loadDiscoverDateCandidates(
  ctx: QueryCtx,
  mode: PublicationReadMode,
  options: { fromDate: string; throughDate?: string },
) {
  return mode === "materialized"
    ? ctx.db
        .query("events")
        .withIndex("by_publicationState_date", (q) => {
          const publishable = q
            .eq("publicationState", "publishable")
            .gte("date", options.fromDate);
          return options.throughDate
            ? publishable.lte("date", options.throughDate)
            : publishable;
        })
        .take(DISCOVER_ORGANIC_SCAN_LIMIT + 1)
    : ctx.db
        .query("events")
        .withIndex("by_status_date", (q) => {
          const approved = q
            .eq("status", "approved")
            .gte("date", options.fromDate);
          return options.throughDate
            ? approved.lte("date", options.throughDate)
            : approved;
        })
        .take(DISCOVER_ORGANIC_SCAN_LIMIT + 1);
}

export async function getDiscoverFeedHandler(
  ctx: QueryCtx,
  args: { today: string },
) {
  const readMode = await resolvePublicationReadMode(ctx);
  const [featuredCandidates, promotedCandidates] = await Promise.all([
    loadPromotionCandidates(ctx, readMode, "featured"),
    loadPromotionCandidates(ctx, readMode, "promoted"),
  ]);
  const [visibleFeaturedCandidates, visiblePromotedCandidates] =
    await Promise.all([
      filterLegacyCompatiblePublicEvents(
        ctx,
        featuredCandidates.slice(0, DISCOVER_PROMOTION_SCAN_LIMIT),
      ),
      filterLegacyCompatiblePublicEvents(
        ctx,
        promotedCandidates.slice(0, DISCOVER_PROMOTION_SCAN_LIMIT),
      ),
    ]);
  const featured = visibleFeaturedCandidates
    .filter((event) => isPromotionActive(event, args.today))
    .sort(comparePromotionEvents)
    .slice(0, 1);
  const promoted = visiblePromotedCandidates
    .filter((event) => isPromotionActive(event, args.today))
    .sort(comparePromotionEvents)
    .slice(0, 10);
  const paidIds = new Set([...featured, ...promoted].map((event) => event._id));

  const tonightCandidates = await loadDiscoverDateCandidates(ctx, readMode, {
    fromDate: args.today,
    throughDate: args.today,
  });
  const tonight = (
    await filterLegacyCompatiblePublicEvents(
      ctx,
      tonightCandidates.slice(0, DISCOVER_ORGANIC_SCAN_LIMIT),
    )
  )
    .filter((event) => !paidIds.has(event._id))
    .sort(compareOrganicEvents)
    .slice(0, 12);

  const weekendDates = getUpcomingWeekendDates(args.today);
  const weekendEnd = [...weekendDates].sort().at(-1) ?? args.today;
  const weekendCandidates = await loadDiscoverDateCandidates(ctx, readMode, {
    fromDate: args.today,
    throughDate: weekendEnd,
  });
  const weekend = (
    await filterLegacyCompatiblePublicEvents(
      ctx,
      weekendCandidates.slice(0, DISCOVER_ORGANIC_SCAN_LIMIT),
    )
  )
    .filter((event) => weekendDates.has(event.date))
    .filter((event) => !paidIds.has(event._id))
    .sort(compareOrganicEvents)
    .slice(0, 12);

  const freeCandidates = await loadDiscoverDateCandidates(ctx, readMode, {
    fromDate: args.today,
  });
  const free = (
    await filterLegacyCompatiblePublicEvents(
      ctx,
      freeCandidates.slice(0, DISCOVER_ORGANIC_SCAN_LIMIT),
    )
  )
    .filter((event) => !paidIds.has(event._id))
    .filter((event) => hasFreeTicketPrice(event.ticketPrice))
    .sort(compareOrganicEvents)
    .slice(0, 12);

  const selectedEvents = [
    ...featured,
    ...free,
    ...promoted,
    ...tonight,
    ...weekend,
  ];
  const selectedEventIds = new Set(selectedEvents.map((event) => event._id));
  const publicVenueIds = await loadPublicVenueIdsForEvents(ctx, selectedEvents);
  const projectGroup = (events: Doc<"events">[]) =>
    events
      .filter((event) => selectedEventIds.has(event._id))
      .map((event) =>
        projectPublicEvent(
          event,
          event.venueId !== undefined && publicVenueIds.has(event.venueId),
        ),
      );
  return {
    featured: projectGroup(featured),
    free: projectGroup(free),
    promoted: projectGroup(promoted),
    tonight: projectGroup(tonight),
    weekend: projectGroup(weekend),
  };
}
