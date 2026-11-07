import { LOCALE_LANGUAGE_TAGS, type Locale } from "@/i18n/config";
import { getMobileDayHeading } from "@/lib/events/mobile-week";
import { addDaysToDateKey } from "@/lib/events/nightlife-date";

export function eventNoun(locale: Locale, count: number): string {
  const form = new Intl.PluralRules(LOCALE_LANGUAGE_TAGS[locale]).select(count);
  if (locale === "en") return form === "one" ? "event" : "events";
  if (locale === "sr") return form === "one" ? "događaj" : "događaja";
  return form === "one" ? "событие" : form === "many" ? "событий" : "события";
}

export function formatEventCount(locale: Locale, count: number): string {
  return `${new Intl.NumberFormat(LOCALE_LANGUAGE_TAGS[locale]).format(count)} ${eventNoun(locale, count)}`;
}

export function formatVenueCount(locale: Locale, count: number): string {
  const form = new Intl.PluralRules(LOCALE_LANGUAGE_TAGS[locale]).select(count);
  const noun = locale === "en" ? (form === "one" ? "venue" : "venues")
    : locale === "sr" ? (form === "one" ? "mesto" : "mesta")
      : form === "one" ? "место" : form === "few" ? "места" : "мест";
  return `${count} ${noun}`;
}

export function formatPublicDate(locale: Locale, value: Date | string, options: Intl.DateTimeFormatOptions): string {
  const dateOnly = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value);
  const date = typeof value === "string" ? new Date(dateOnly ? `${value}T12:00:00Z` : value) : value;
  return new Intl.DateTimeFormat(LOCALE_LANGUAGE_TAGS[locale], {
    timeZone: dateOnly ? "UTC" : "Europe/Belgrade", ...options,
  }).format(date);
}

export function publicDayLabel(locale: Locale, day: string, today: string): string {
  if (day === today) return { sr: "Danas", en: "Today", ru: "Сегодня" }[locale];
  if (day === addDaysToDateKey(today, 1)) return { sr: "Sutra", en: "Tmrw", ru: "Завтра" }[locale];
  return formatPublicDate(locale, day, { weekday: "short" }).replace(/\.$/u, "");
}

export function publicDayHeading(locale: Locale, day: string, today: string): string {
  if (locale === "sr") return getMobileDayHeading(day, today);
  if (day === today) return locale === "en" ? "What's on today?" : "Куда сегодня?";
  if (day === addDaysToDateKey(today, 1)) return locale === "en" ? "What's on tomorrow?" : "Куда завтра?";
  return formatPublicDate(locale, day, { weekday: "long", day: "numeric", month: "long" });
}
