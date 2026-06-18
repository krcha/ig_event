const WEEKDAY_BY_NAME: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  weds: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
  nedelja: 0,
  ned: 0,
  ponedeljak: 1,
  pon: 1,
  utorak: 2,
  uto: 2,
  sreda: 3,
  sre: 3,
  cetvrtak: 4,
  cet: 4,
  petak: 5,
  pet: 5,
  subota: 6,
  sub: 6,
};

const DATE_SHAPE_RE = /^\s*(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?\s*$/;
const TIME_MARKER_RE = /(?:\d\s*h|h\s*\d|:|[ap]\.?m\.?)/i;

function foldText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function findNamedWeekday(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const folded = foldText(value);
  for (const [name, weekday] of Object.entries(WEEKDAY_BY_NAME)) {
    if (new RegExp(`\\b${name}\\b`, "u").test(folded)) {
      return weekday;
    }
  }

  return null;
}

export function weekdayOfIsoDate(value: string | null | undefined): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value?.trim() ?? "");
  if (!match) {
    return null;
  }

  const parsed = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  return Number.isNaN(parsed.getTime()) ? null : parsed.getUTCDay();
}

export type WeekdayConsistency =
  | { status: "ok" | "no_weekday_named" | "no_date" }
  | { dateWeekday: number; namedWeekday: number; status: "mismatch" };

export function checkWeekdayConsistency(
  isoDate: string | null | undefined,
  sourceText: string | null | undefined,
): WeekdayConsistency {
  const namedWeekday = findNamedWeekday(sourceText);
  if (namedWeekday === null) {
    return { status: "no_weekday_named" };
  }

  const dateWeekday = weekdayOfIsoDate(isoDate);
  if (dateWeekday === null) {
    return { status: "no_date" };
  }

  return namedWeekday === dateWeekday
    ? { status: "ok" }
    : { dateWeekday, namedWeekday, status: "mismatch" };
}

export function looksLikeBareDate(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }

  if (TIME_MARKER_RE.test(value)) {
    return false;
  }

  const match = DATE_SHAPE_RE.exec(value);
  if (!match) {
    return false;
  }

  const second = Number(match[2]);
  const hasYear = match[3] !== undefined;
  return hasYear || (second >= 1 && second <= 12);
}

export function sanitizeTimeAgainstDate(
  time: string | null | undefined,
  rawDateText?: string | null,
): string {
  const value = (time ?? "").trim();
  if (!value) {
    return "";
  }

  if (looksLikeBareDate(value)) {
    return "";
  }

  if (rawDateText && foldText(value) === foldText(rawDateText.trim())) {
    return "";
  }

  return value;
}

export type EventConsistencyIssue = "time_is_date" | "weekday_date_mismatch";

export type EventConsistencyResult = {
  action: "accept" | "reject";
  issues: EventConsistencyIssue[];
  ok: boolean;
  sanitizedTime: string;
};

export function checkEventConsistency(input: {
  isoDate: string | null | undefined;
  rawDateText?: string | null;
  time: string | null | undefined;
  weekdayEvidence: string | null | undefined;
}): EventConsistencyResult {
  const issues: EventConsistencyIssue[] = [];
  const originalTime = (input.time ?? "").trim();
  const sanitizedTime = sanitizeTimeAgainstDate(originalTime, input.rawDateText);

  if (sanitizedTime !== originalTime) {
    issues.push("time_is_date");
  }

  const weekday = checkWeekdayConsistency(input.isoDate, input.weekdayEvidence);
  if (weekday.status === "mismatch") {
    issues.push("weekday_date_mismatch");
  }

  return {
    action: weekday.status === "mismatch" ? "reject" : "accept",
    issues,
    ok: issues.length === 0,
    sanitizedTime,
  };
}
