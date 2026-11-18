import type { Locale } from "@/i18n/config";
import { travelText } from "./copy";

const rules: Partial<Record<Locale, Intl.PluralRules>> = {};
const units = {
  hour: { one: "durationHourOne", few: "durationHourFew", other: "durationHourMany" },
  minute: { one: "durationMinuteOne", few: "durationMinuteFew", other: "durationMinuteMany" },
} as const;

function quantity(value: number, unit: keyof typeof units, locale: Locale): string {
  const category = (rules[locale] ??= new Intl.PluralRules(locale)).select(value);
  const form = category === "one" || category === "few" ? category : "other";
  return `${value} ${travelText(locale, units[unit][form])}`;
}

/** Keep short estimates compact; longer trips use localized hours and minutes. */
export function formatTravelDuration(minutes: number, locale: Locale): string {
  const total = Math.ceil(minutes);
  if (!Number.isSafeInteger(total) || total < 0) return "\u2014";
  if (total <= 60) return `${total} ${travelText(locale, "durationShortMinute")}`;
  const hours = quantity(Math.floor(total / 60), "hour", locale);
  const remainder = total % 60;
  return remainder ? `${hours} ${travelText(locale, "durationAnd")} ${quantity(remainder, "minute", locale)}` : hours;
}
