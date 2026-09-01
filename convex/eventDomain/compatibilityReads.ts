import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { DomainError } from "../../lib/domain/errors";
import { canonicalizeSourceUrlOrEmpty } from "../../lib/domain/source-url";
import { normalizeInstagramPostUrl } from "../../lib/images/apify-images";
import { requireAdminIdentity, requireAdminOrServiceSecret } from "../authz";
import { assertPublicEventDateWindow } from "./publicReads";

const DEFAULT_EVENT_COMPATIBILITY_LIST_SIZE = 100;
const MAX_EVENT_COMPATIBILITY_LIST_SIZE = 200;
const DEFAULT_EVENT_STATUS_LIST_SIZE = 100;
const MAX_EVENT_STATUS_LIST_SIZE = 1_000;
const MAX_EVENT_STATUS_PAGE_SIZE = 100;
const MAX_EVENT_STATUS_DATE_WINDOW_SIZE = 1_000;
const MAX_EVENT_SOURCE_IDENTITY_MATCHES = 100;
const MAX_EVENTS_GET_MANY_BY_IDS = 100;
const MAX_PUBLIC_EVENT_WINDOW_DAYS = 400;

type EventStatus = "pending" | "approved" | "rejected";
type PaginationOptions = { cursor: string | null; numItems: number };

function normalizeCompatibilityListLimit(
  value: number | undefined,
  defaultValue: number,
  maxValue: number,
): number {
  const requested = Number.isFinite(value)
    ? Math.trunc(value as number)
    : defaultValue;
  return Math.max(1, Math.min(maxValue, requested));
}

function buildEventStatusPaginationOptions(options: PaginationOptions) {
  const requested = Number.isFinite(options.numItems)
    ? Math.trunc(options.numItems)
    : 1;
  return {
    cursor: options.cursor,
    numItems: Math.max(1, Math.min(MAX_EVENT_STATUS_PAGE_SIZE, requested)),
  };
}

export async function getEventHandler(
  ctx: QueryCtx,
  args: { id: Id<"events"> },
) {
  await requireAdminIdentity(ctx);
  return ctx.db.get(args.id);
}

export async function listEventsHandler(
  ctx: QueryCtx,
  args: { limit?: number },
) {
  await requireAdminIdentity(ctx);
  const limit = normalizeCompatibilityListLimit(
    args.limit,
    DEFAULT_EVENT_COMPATIBILITY_LIST_SIZE,
    MAX_EVENT_COMPATIBILITY_LIST_SIZE,
  );
  return ctx.db.query("events").order("desc").take(limit);
}

export async function getByInstagramPostIdHandler(
  ctx: QueryCtx,
  args: { instagramPostId: string; serviceSecret?: string },
) {
  await requireAdminOrServiceSecret(ctx, args.serviceSecret);
  const matches = await ctx.db
    .query("events")
    .withIndex("by_instagramPostId", (q) =>
      q.eq("instagramPostId", args.instagramPostId),
    )
    .take(2);
  if (matches.length > 1) {
    throw new DomainError(
      "EVENT_AMBIGUOUS",
      "Multiple events share this Instagram post ID; use the bounded list lookup.",
    );
  }
  return matches[0] ?? null;
}

async function listEventsByCanonicalSourceUrl(
  ctx: QueryCtx,
  instagramPostUrl: string,
  limit: number,
  requireComplete = false,
): Promise<Doc<"events">[]> {
  const byId = new Map<Id<"events">, Doc<"events">>();
  const readLimit = requireComplete ? limit + 1 : limit;
  const canonicalSourceUrl = canonicalizeSourceUrlOrEmpty(
    "instagram",
    instagramPostUrl,
  );
  if (canonicalSourceUrl) {
    const canonicalMatches = await ctx.db
      .query("events")
      .withIndex("by_canonicalSourceUrl", (q) =>
        q.eq("canonicalSourceUrl", canonicalSourceUrl),
      )
      .take(readLimit);
    for (const event of canonicalMatches) byId.set(event._id, event);
  }
  const normalizedInstagramPostUrl =
    normalizeInstagramPostUrl(instagramPostUrl);
  if ((requireComplete || byId.size < limit) && normalizedInstagramPostUrl) {
    const normalizedMatches = await ctx.db
      .query("events")
      .withIndex("by_normalizedInstagramPostUrl", (q) =>
        q.eq("normalizedInstagramPostUrl", normalizedInstagramPostUrl),
      )
      .take(requireComplete ? readLimit : limit - byId.size);
    for (const event of normalizedMatches) byId.set(event._id, event);
  }
  if (requireComplete || byId.size < limit) {
    const legacyMatches = await ctx.db
      .query("events")
      .withIndex("by_instagramPostUrl", (q) =>
        q.eq("instagramPostUrl", instagramPostUrl),
      )
      .take(requireComplete ? readLimit : limit - byId.size);
    for (const event of legacyMatches) byId.set(event._id, event);
  }
  if (requireComplete && byId.size > limit) {
    if (limit === 1) {
      throw new DomainError(
        "EVENT_AMBIGUOUS",
        "Multiple events share this Instagram post URL; use the bounded list lookup.",
      );
    }
    throw new Error(
      `E_EVENT_SOURCE_MATCH_LIMIT: Instagram post URL matches exceed the safe bound of ${limit}.`,
    );
  }
  return [...byId.values()].slice(0, limit);
}

export async function getByInstagramPostUrlHandler(
  ctx: QueryCtx,
  args: { instagramPostUrl: string; serviceSecret?: string },
) {
  await requireAdminOrServiceSecret(ctx, args.serviceSecret);
  const matches = await listEventsByCanonicalSourceUrl(
    ctx,
    args.instagramPostUrl,
    1,
    true,
  );
  return matches[0] ?? null;
}

export async function listByInstagramPostIdHandler(
  ctx: QueryCtx,
  args: { instagramPostId: string; serviceSecret?: string },
) {
  await requireAdminOrServiceSecret(ctx, args.serviceSecret);
  const matches = await ctx.db
    .query("events")
    .withIndex("by_instagramPostId", (q) =>
      q.eq("instagramPostId", args.instagramPostId),
    )
    .take(MAX_EVENT_SOURCE_IDENTITY_MATCHES + 1);
  if (matches.length > MAX_EVENT_SOURCE_IDENTITY_MATCHES) {
    throw new Error(
      `E_EVENT_SOURCE_MATCH_LIMIT: Instagram post ID matches exceed the safe bound of ${MAX_EVENT_SOURCE_IDENTITY_MATCHES}.`,
    );
  }
  return matches;
}

export async function listByInstagramPostUrlHandler(
  ctx: QueryCtx,
  args: { instagramPostUrl: string; serviceSecret?: string },
) {
  await requireAdminOrServiceSecret(ctx, args.serviceSecret);
  return listEventsByCanonicalSourceUrl(
    ctx,
    args.instagramPostUrl,
    MAX_EVENT_SOURCE_IDENTITY_MATCHES,
    true,
  );
}

export async function listByStatusHandler(
  ctx: QueryCtx,
  args: { limit?: number; serviceSecret?: string; status: EventStatus },
) {
  await requireAdminOrServiceSecret(ctx, args.serviceSecret);
  const limit = normalizeCompatibilityListLimit(
    args.limit,
    DEFAULT_EVENT_STATUS_LIST_SIZE,
    MAX_EVENT_STATUS_LIST_SIZE,
  );
  return ctx.db
    .query("events")
    .withIndex("by_status", (q) => q.eq("status", args.status))
    .order("desc")
    .take(limit);
}

export async function listByStatusPaginatedHandler(
  ctx: QueryCtx,
  args: {
    paginationOpts: PaginationOptions;
    serviceSecret?: string;
    status: EventStatus;
  },
) {
  await requireAdminOrServiceSecret(ctx, args.serviceSecret);
  return ctx.db
    .query("events")
    .withIndex("by_status", (q) => q.eq("status", args.status))
    .order("desc")
    .paginate(buildEventStatusPaginationOptions(args.paginationOpts));
}

export async function getManyByIdsHandler(
  ctx: QueryCtx,
  args: { ids: Id<"events">[]; serviceSecret?: string },
) {
  await requireAdminOrServiceSecret(ctx, args.serviceSecret);
  if (args.ids.length === 0 || args.ids.length > MAX_EVENTS_GET_MANY_BY_IDS) {
    throw new Error(
      `Event ID reads require 1-${MAX_EVENTS_GET_MANY_BY_IDS} IDs.`,
    );
  }
  if (new Set(args.ids).size !== args.ids.length) {
    throw new Error("Event ID reads require unique IDs.");
  }
  const events = await Promise.all(args.ids.map((id) => ctx.db.get(id)));
  return events.filter((event): event is Doc<"events"> => event !== null);
}

export async function listByStatusDateWindowHandler(
  ctx: QueryCtx,
  args: {
    beforeDate: string;
    fromDate: string;
    serviceSecret?: string;
    status: EventStatus;
  },
) {
  await requireAdminOrServiceSecret(ctx, args.serviceSecret);
  assertPublicEventDateWindow(
    args.fromDate,
    args.beforeDate,
    MAX_PUBLIC_EVENT_WINDOW_DAYS,
  );
  const events = await ctx.db
    .query("events")
    .withIndex("by_status_date", (q) =>
      q
        .eq("status", args.status)
        .gte("date", args.fromDate)
        .lt("date", args.beforeDate),
    )
    .take(MAX_EVENT_STATUS_DATE_WINDOW_SIZE + 1);
  if (events.length > MAX_EVENT_STATUS_DATE_WINDOW_SIZE) {
    throw new Error(
      `Event status/date compatibility window exceeds its safe bound of ${MAX_EVENT_STATUS_DATE_WINDOW_SIZE}; use listByStatusDateWindowPaginated.`,
    );
  }
  return events;
}

export async function listByStatusDateWindowPaginatedHandler(
  ctx: QueryCtx,
  args: {
    beforeDate: string;
    fromDate: string;
    paginationOpts: PaginationOptions;
    serviceSecret?: string;
    status: EventStatus;
  },
) {
  await requireAdminOrServiceSecret(ctx, args.serviceSecret);
  assertPublicEventDateWindow(
    args.fromDate,
    args.beforeDate,
    MAX_PUBLIC_EVENT_WINDOW_DAYS,
  );
  return ctx.db
    .query("events")
    .withIndex("by_status_date", (q) =>
      q
        .eq("status", args.status)
        .gte("date", args.fromDate)
        .lt("date", args.beforeDate),
    )
    .paginate(buildEventStatusPaginationOptions(args.paginationOpts));
}

export async function listByDateHandler(
  ctx: QueryCtx,
  args: { date: string; serviceSecret?: string },
) {
  await requireAdminOrServiceSecret(ctx, args.serviceSecret);
  const events = await ctx.db
    .query("events")
    .withIndex("by_date", (q) => q.eq("date", args.date))
    .take(251);
  if (events.length > 250) {
    throw new DomainError(
      "EVENT_AMBIGUOUS",
      "Legacy same-date event lookup exceeds its compatibility safety bound.",
    );
  }
  return events;
}
