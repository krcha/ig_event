export type AnalyticsGroup = "hour" | "day" | "month";
export type AnalyticsEvent = {
  eventId: string;
  visitorId: string;
  sessionId: string;
  kind: "pageview" | "click";
  path: string;
  target: string;
  source: string;
  medium: string;
  campaign: string;
  country: string;
  device: string;
  browser: string;
  os: string;
  at: number;
};

export type AnalyticsRow = { name: string; views: number; clicks: number; visitors: number };
export type AnalyticsPoint = { key: string; views: number; clicks: number; visitors: number };
export type AnalyticsTotals = { views: number; clicks: number; visitors: number; sessions: number; clickers: number; conversion: number };
export type AnalyticsReport = {
  start: string;
  end: string;
  group: AnalyticsGroup;
  timezone: string;
  generatedAt: number;
  totals: AnalyticsTotals;
  previous: AnalyticsTotals;
  series: AnalyticsPoint[];
  activity: AnalyticsPoint[];
  activeVisitors: number;
  countries: AnalyticsRow[];
  devices: AnalyticsRow[];
  browsers: AnalyticsRow[];
  operatingSystems: AnalyticsRow[];
  sources: AnalyticsRow[];
  pages: AnalyticsRow[];
  buttons: AnalyticsRow[];
};

export const ANALYTICS_TIMEZONE = "Europe/Belgrade";
export const DAY_MS = 86_400_000;
export const ANALYTICS_RETENTION_DAYS = 400;

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: ANALYTICS_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
});
const hourFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: ANALYTICS_TIMEZONE, hour: "2-digit", hourCycle: "h23",
});

export function localDay(at: number): string {
  const parts = dayFormatter.formatToParts(at);
  const part = (name: string) => parts.find((item) => item.type === name)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function shiftDay(day: string, amount: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + amount * DAY_MS).toISOString().slice(0, 10);
}

export function validDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const at = Date.parse(`${day}T12:00:00Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === day;
}

// Resolve civil midnight using the zone's actual offset, including DST changes.
export function localMidnight(day: string): number {
  const base = Date.parse(`${day}T00:00:00Z`);
  let at = base;
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: ANALYTICS_TIMEZONE, timeZoneName: "longOffset",
  });
  for (let i = 0; i < 3; i++) {
    const offset = formatter.formatToParts(at).find((part) => part.type === "timeZoneName")?.value ?? "GMT";
    const match = offset.match(/GMT([+-])(\d{2}):(\d{2})/);
    const minutes = match ? (Number(match[2]) * 60 + Number(match[3])) * (match[1] === "+" ? 1 : -1) : 0;
    at = base - minutes * 60_000;
  }
  return at;
}

export function getAnalyticsRange(start: string, end: string, group: AnalyticsGroup, now = Date.now()) {
  if (!validDay(start) || !validDay(end) || start > end || end > localDay(now)) {
    throw new Error("Choose a valid date range ending today or earlier.");
  }
  const days = Math.round((Date.parse(end) - Date.parse(start)) / DAY_MS) + 1;
  if (days > 366 || (group === "hour" && days > 14)) {
    throw new Error("Choose up to 366 days, or up to 14 days for hourly detail.");
  }
  if (start < shiftDay(localDay(now), -ANALYTICS_RETENTION_DAYS + 1)) {
    throw new Error("Analytics are retained for 400 days. Choose a more recent range.");
  }
  const from = localMidnight(start);
  const to = Math.min(localMidnight(shiftDay(end, 1)), now + 1);
  const previousStart = shiftDay(start, -days);
  // Compare the same elapsed civil-time portion when the selected period ends today.
  const previousEnd = localMidnight(start);
  const previousTo = end === localDay(now)
    ? Math.min(previousEnd, localMidnight(shiftDay(start, -1)) + (to - localMidnight(end)))
    : previousEnd;
  return { from, to, previousFrom: localMidnight(previousStart), previousTo, days };
}

export function bucketKey(at: number, group: AnalyticsGroup): string {
  const day = localDay(at);
  if (group === "month") return day.slice(0, 7);
  if (group === "day") return day;
  // Include the offset to keep the repeated autumn hour separate.
  const offset = new Intl.DateTimeFormat("en-GB", { timeZone: ANALYTICS_TIMEZONE, timeZoneName: "shortOffset" })
    .formatToParts(at).find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  return `${day} ${hourFormatter.format(at)}:00 ${offset}`;
}

export function isPublicAnalyticsPath(path: string): boolean {
  return path === "/" || /^\/(events(?:\/[^/]+)?|calendar|discover|map|venues(?:\/[^/]+)?)\/?$/.test(path);
}

export function cleanLabel(value: unknown, max = 100): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
  return text.includes("@") ? "" : text;
}

export function cleanPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 500) return null;
  try {
    const url = new URL(value, "https://analytics.invalid");
    return url.origin === "https://analytics.invalid" && isPublicAnalyticsPath(url.pathname) ? url.pathname : null;
  } catch { return null; }
}
