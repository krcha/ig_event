import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { action, internalMutation, internalQuery, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireViewerIdentity } from "./authz";
import { analyticsEventFields, analyticsGroup, analyticsReport } from "./analyticsValidators";
import { isAnalyticsOwner } from "../lib/analytics/access";
import { buildAnalyticsReport } from "../lib/analytics/aggregate";
import { ANALYTICS_RETENTION_DAYS, DAY_MS, getAnalyticsRange, isPublicAnalyticsPath, type AnalyticsEvent } from "../lib/analytics/model";

// Collection is server-to-server only. No visitor can write to Convex directly.
export const record = mutation({
  args: { serviceSecret: v.string(), event: v.object(analyticsEventFields) },
  returns: v.null(),
  handler: async (ctx, { serviceSecret, event }) => {
    const expected = process.env.CRON_SECRET?.trim();
    if (!expected || serviceSecret !== expected) throw new Error("Analytics collection is not authorized.");
    if (!isPublicAnalyticsPath(event.path) || Object.values(event).some((value) => typeof value === "string" && value.length > 500)) {
      throw new Error("Invalid analytics event.");
    }
    const now = Date.now();
    if (!Number.isFinite(event.at) || Math.abs(now - event.at) > 60_000) throw new Error("Invalid event timestamp.");
    const duplicate = await ctx.db.query("analyticsEvents").withIndex("by_eventId", (q) => q.eq("eventId", event.eventId)).first();
    if (duplicate) return null;
    const recent = await ctx.db.query("analyticsEvents")
      .withIndex("by_visitorId_at", (q) => q.eq("visitorId", event.visitorId).gte("at", now - 60_000)).take(60);
    if (recent.length >= 60) return null;
    await ctx.db.insert("analyticsEvents", event);
    return null;
  },
});

export const readPage = internalQuery({
  args: { from: v.number(), to: v.number(), paginationOpts: paginationOptsValidator },
  returns: v.object({ events: v.array(v.object(analyticsEventFields)), cursor: v.string(), done: v.boolean() }),
  handler: async (ctx, args) => {
    const result = await ctx.db.query("analyticsEvents")
      .withIndex("by_at", (q) => q.gte("at", args.from).lt("at", args.to))
      .paginate({ ...args.paginationOpts, numItems: Math.min(args.paginationOpts.numItems, 500) });
    return {
      events: result.page.map(({ _id, _creationTime, ...event }) => { void _id; void _creationTime; return event; }),
      cursor: result.continueCursor, done: result.isDone,
    };
  },
});

export const report = action({
  args: { start: v.string(), end: v.string(), group: analyticsGroup },
  returns: analyticsReport,
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    if (!isAnalyticsOwner(identity.subject, process.env)) throw new Error("Analytics owner access required.");
    const now = Date.now();
    const range = getAnalyticsRange(args.start, args.end, args.group, now);
    const events: AnalyticsEvent[] = [];
    let cursor: string | null = null;
    const readWindow = async (from: number, to: number) => {
      cursor = null;
      for (let page = 0; page < 250; page++) {
        const result: { events: AnalyticsEvent[]; cursor: string; done: boolean } = await ctx.runQuery(internal.analytics.readPage, {
          from, to, paginationOpts: { cursor, numItems: 500 },
        });
        events.push(...result.events);
        if (events.length > 100_000) throw new Error("This range contains too much traffic. Choose a shorter date range.");
        if (result.done) return;
        cursor = result.cursor;
      }
      throw new Error("This range contains too much traffic. Choose a shorter date range.");
    };
    await readWindow(range.previousFrom, range.to);
    // Live activity remains current when the owner browses a historical period.
    if (range.to < now + 1) await readWindow(Math.max(range.to, now - 3_600_000), now + 1);
    return buildAnalyticsReport(events, args.start, args.end, args.group, now);
  },
});

export const cleanup = internalMutation({
  args: {}, returns: v.null(),
  handler: async (ctx) => {
    const expired = await ctx.db.query("analyticsEvents")
      .withIndex("by_at", (q) => q.lt("at", Date.now() - ANALYTICS_RETENTION_DAYS * DAY_MS)).take(500);
    for (const row of expired) await ctx.db.delete(row._id);
    if (expired.length === 500) await ctx.scheduler.runAfter(0, internal.analytics.cleanup, {});
    return null;
  },
});
