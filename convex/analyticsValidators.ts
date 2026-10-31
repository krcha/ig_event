import { v } from "convex/values";

export const analyticsEventFields = {
  eventId: v.string(), visitorId: v.string(), sessionId: v.string(),
  kind: v.union(v.literal("pageview"), v.literal("click")),
  path: v.string(), target: v.string(), source: v.string(), medium: v.string(), campaign: v.string(),
  country: v.string(), device: v.string(), browser: v.string(), os: v.string(), at: v.number(),
};
export const analyticsGroup = v.union(v.literal("hour"), v.literal("day"), v.literal("month"));
const totals = v.object({
  views: v.number(), clicks: v.number(), visitors: v.number(), sessions: v.number(), clickers: v.number(), conversion: v.number(),
});
const point = v.object({ key: v.string(), views: v.number(), clicks: v.number(), visitors: v.number() });
const row = v.object({ name: v.string(), views: v.number(), clicks: v.number(), visitors: v.number() });
export const analyticsReport = v.object({
  start: v.string(), end: v.string(), group: analyticsGroup, timezone: v.string(), generatedAt: v.number(),
  totals, previous: totals, series: v.array(point), activity: v.array(point), activeVisitors: v.number(),
  countries: v.array(row), devices: v.array(row), browsers: v.array(row), operatingSystems: v.array(row),
  sources: v.array(row), pages: v.array(row), buttons: v.array(row),
});
