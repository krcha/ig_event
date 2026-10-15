import { findNamedWeekdays, weekdayOfIsoDate } from "@/lib/events/event-validation";
import { collectSupportedDates, SOURCE_GROUNDING_MONTH_PATTERN } from "@/lib/pipeline/ingestion/parsing-source-evidence";

export type DayScopedSourceBlock = { text: string; dates: string[]; weekday: number | null };

const explicitDatePrefix = new RegExp(
  String.raw`^(?:20\d{2}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}(?:[./-](?:\d{4}|\d{2}))?\.?|\d{1,2}(?:st|nd|rd|th|\.)?\s+(?:${SOURCE_GROUNDING_MONTH_PATTERN})(?:\s+20\d{2})?|(?:${SOURCE_GROUNDING_MONTH_PATTERN})\s+\d{1,2}(?:st|nd|rd|th)?(?:\s+20\d{2})?)`,
  "iu",
);

export function getDayScopedSourceBlocks(sourceText: string, postedAt: string | null): DayScopedSourceBlock[] {
  const blocks: DayScopedSourceBlock[] = [];
  for (const line of sourceText.split(/\r?\n|;/u)) {
    const leadingText = line.trim().replace(/^[^\p{L}\p{N}@]+/u, "");
    const firstWord = leadingText.match(/^[\p{L}]+/u)?.[0] ?? "";
    const weekdays = findNamedWeekdays(firstWord);
    const afterFirstWord = leadingText.slice(firstWord.length);
    const followingDate = afterFirstWord.replace(/^[\s,:.|()\-\u2013\u2014]+/u, "").match(explicitDatePrefix)?.[0];
    const clearWeekdayHeading = !afterFirstWord.trim() ||
      /^[\s]*[:|/,\-\u2013\u2014@]/u.test(afterFirstWord) || Boolean(followingDate);
    const weekday = weekdays.length === 1 && clearWeekdayHeading ? weekdays[0]! : null;
    const dateText = (weekday === null ? leadingText : leadingText.slice(firstWord.length))
      .replace(/^[\s,:.|()\-\u2013\u2014]+/u, "").match(explicitDatePrefix)?.[0];
    const dates = dateText ? collectSupportedDates(dateText, postedAt) : [];
    if (weekday !== null || dates.length > 0) {
      blocks.push({ text: line, dates, weekday });
    } else if (blocks.length > 0) {
      blocks[blocks.length - 1]!.text += `\n${line}`;
    }
  }
  return blocks;
}

function preheaderNamesSharedLeader(options: {
  text: string;
  identity: string;
  identityAppearsInText: (text: string, identity: string) => boolean;
}): boolean {
  const rolePatterns = [
    /(?:hosted|led|taught|guided)\s+by\s+([^;\n]+)/giu,
    /(?:host|teacher|instructor|guide|predava[čc]|instruktor|doma[ćc]in|moderator)\s*:\s*([^;\n]+)/giu,
    /(?:vodi|vode|moderira|predaje)\s+([^;\n]+)/giu,
    // COMMON introduces the conversation-club leader in Russian before its
    // bilingual weekday list: "club with [name] — a native language speaker".
    /разговорн\p{L}*\s+клуб\s+с\s+([^\n;—]+)\s*[—-]\s*носител\p{L}*/giu,
    /conversation\s+club\s+with\s+([^;\n,]+),\s*a?\s*native\s+speaker/giu,
  ];
  return rolePatterns.some((pattern) => [...options.text.matchAll(pattern)].some((match) =>
    options.identityAppearsInText(match[1] ?? "", options.identity),
  ));
}

/** A quote from a multi-day caption cannot bill another day's act.
 * Only explicit leading date/weekday schedule headings establish scope; prose,
 * artist names such as DJ Sunday, and multiple sessions on one day do not.
 */
export function sourceIdentityMatchesSelectedDay(options: {
  sourceText: string;
  selectedDate: string;
  postedAt: string | null;
  identity: string;
  identityAppearsInText: (text: string, identity: string) => boolean;
}): boolean {
  const blocks = getDayScopedSourceBlocks(options.sourceText, options.postedAt);
  const selectedWeekday = weekdayOfIsoDate(options.selectedDate);
  const days = new Set(blocks.flatMap((block) => block.dates.length > 0
    ? block.dates : block.weekday === null ? [] : [`weekday:${block.weekday}`]));
  if (days.size < 2) return true;
  const firstHeading = blocks[0]?.text.split("\n")[0];
  const scheduleStart = firstHeading ? options.sourceText.indexOf(firstHeading) : -1;
  // A preheader roster alone does not assign every act to every day. Only an
  // explicit shared host/teacher/leader role can establish common identity.
  if (scheduleStart > 0 && preheaderNamesSharedLeader({
    text: options.sourceText.slice(0, scheduleStart),
    identity: options.identity,
    identityAppearsInText: options.identityAppearsInText,
  })) return true;
  const matchingBlock = blocks.some((block) =>
    (block.dates.length > 0
      ? block.dates.includes(options.selectedDate)
      : block.weekday === selectedWeekday) &&
    options.identityAppearsInText(block.text, options.identity),
  );
  if (matchingBlock) return true;

  // A separately stated common act remains valid when the caption explicitly
  // bills it for both days. A general weekend heading alone is insufficient.
  return options.sourceText.split(/\r?\n|;/u).some((line) =>
    /\b(?:oba\s+dana|obe\s+ve[čc]eri|both\s+(?:days|nights)|svak(?:og|e)\s+(?:dana|ve[čc]eri)|every\s+(?:day|night))\b/iu.test(line) &&
    options.identityAppearsInText(line, options.identity),
  );
}
