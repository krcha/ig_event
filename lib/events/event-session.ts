import { getDisplayEventTime } from "./event-time.ts";

type EventAgeInput = { description?: string | null };

export type EventSessionInput = EventAgeInput & {
  displayTimeLabel?: string | null;
  time?: string | null;
  timeStatus?: string | null;
};

// A shared announcement can describe several age groups. Only the individual
// occurrence description can supply a label; never fall back to sourceCaption.
export function getEventAgeRange(event: EventAgeInput): string | null {
  const description = event.description?.trim();
  if (!description) return null;

  const agePattern = /(?:\b(?:for\s+)?ages?\b|\buzrast(?:a)?\b|\u0443\u0437\u0440\u0430\u0441\u0442\u0430?)[\s:=-]*(?:od\s+|\u043e\u0434\s+)?(\d{1,3})\s*(?:[-\u2010-\u2015]|to\b|do\b|\u0434\u043e)\s*(\d{1,3})(?!\d)/giu;
  const ranges = new Set<string>();
  for (const match of description.matchAll(agePattern)) {
    const minimum = Number(match[1]);
    const maximum = Number(match[2]);
    if (minimum > maximum || maximum > 130) return null;
    ranges.add(`${minimum}-${maximum}`);
  }
  if (ranges.size !== 1) return null;

  // Also reject a combined group such as "For ages 5-8 and 9-14".
  if (/\d{1,3}\s*[-\u2010-\u2015]\s*\d{1,3}\s*(?:and|or|i|ili|\u0438|\u0438\u043b\u0438|\/)\s*\d{1,3}\s*[-\u2010-\u2015]\s*\d{1,3}/iu.test(description)) {
    return null;
  }
  return [...ranges][0];
}

export function getEventSessionLabel(event: EventSessionInput): string | null {
  const ageRange = getEventAgeRange(event);
  if (!ageRange) return null;
  const ageLabel = `Ages ${ageRange.replace("-", "\u2013")}`;
  const time = event.timeStatus === "unknown"
    ? null
    : event.displayTimeLabel?.trim() || getDisplayEventTime(event.time);
  return time ? `${ageLabel} \u00b7 ${time}` : ageLabel;
}
