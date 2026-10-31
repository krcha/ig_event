import {
  ANALYTICS_TIMEZONE, bucketKey, getAnalyticsRange, localMidnight, shiftDay,
  type AnalyticsEvent, type AnalyticsGroup, type AnalyticsReport, type AnalyticsRow,
} from "./model";

function total(events: AnalyticsEvent[]) {
  const views = events.filter((event) => event.kind === "pageview");
  const visitors = new Set(views.map((event) => event.visitorId));
  const clickers = new Set(events.filter((event) => event.kind === "click" && visitors.has(event.visitorId)).map((event) => event.visitorId));
  return {
    views: views.length,
    clicks: events.length - views.length,
    visitors: visitors.size,
    sessions: new Set(views.map((event) => event.sessionId)).size,
    clickers: clickers.size,
    conversion: visitors.size ? clickers.size / visitors.size * 100 : 0,
  };
}

function breakdown(events: AnalyticsEvent[], key: (event: AnalyticsEvent) => string, clicksOnly = false): AnalyticsRow[] {
  const rows = new Map<string, { views: number; clicks: number; visitors: Set<string> }>();
  for (const event of events) {
    if (clicksOnly && event.kind !== "click") continue;
    const name = key(event) || "Unknown";
    const row = rows.get(name) ?? { views: 0, clicks: 0, visitors: new Set<string>() };
    if (event.kind === "pageview") row.views++;
    else row.clicks++;
    if (clicksOnly || event.kind === "pageview") row.visitors.add(event.visitorId);
    rows.set(name, row);
  }
  return Array.from(rows, ([name, row]) => ({ name, views: row.views, clicks: row.clicks, visitors: row.visitors.size }))
    .sort((a, b) => (clicksOnly ? b.clicks - a.clicks : b.views - a.views) || a.name.localeCompare(b.name));
}

export function buildAnalyticsReport(
  events: AnalyticsEvent[], start: string, end: string, group: AnalyticsGroup, now = Date.now(),
): AnalyticsReport {
  const range = getAnalyticsRange(start, end, group, now);
  const current = events.filter((event) => event.at >= range.from && event.at < range.to);
  const previous = events.filter((event) => event.at >= range.previousFrom && event.at < range.previousTo);
  const buckets = new Map<string, AnalyticsEvent[]>();
  if (group === "hour") {
    for (let at = range.from; at < range.to; at += 3_600_000) buckets.set(bucketKey(at, group), []);
  } else {
    for (let day = start; day <= end; day = shiftDay(day, 1)) buckets.set(bucketKey(localMidnight(day), group), []);
  }
  for (const event of current) {
    const key = bucketKey(event.at, group);
    buckets.get(key)?.push(event);
  }
  const activityStart = now - 3_600_000;
  const activity = Array.from({ length: 12 }, (_, i) => {
    const at = activityStart + i * 300_000;
    const values = events.filter((event) => event.at >= at && event.at < at + 300_000);
    const counts = total(values);
    return { key: String(at), views: counts.views, clicks: counts.clicks, visitors: counts.visitors };
  });
  return {
    start, end, group, timezone: ANALYTICS_TIMEZONE, generatedAt: now,
    totals: total(current), previous: total(previous),
    series: Array.from(buckets, ([key, values]) => {
      const counts = total(values);
      return { key, views: counts.views, clicks: counts.clicks, visitors: counts.visitors };
    }),
    activity,
    activeVisitors: new Set(events.filter((event) => event.at >= now - 300_000).map((event) => event.visitorId)).size,
    countries: breakdown(current, (event) => event.country),
    devices: breakdown(current, (event) => event.device),
    browsers: breakdown(current, (event) => event.browser),
    operatingSystems: breakdown(current, (event) => event.os),
    sources: breakdown(current, (event) => [event.source, event.medium, event.campaign].filter(Boolean).join(" / ")),
    pages: breakdown(current, (event) => event.path),
    buttons: breakdown(current, (event) => event.target, true),
  };
}
