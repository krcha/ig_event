import { addDaysToDateKey, parseDateKeyToUtcNoon } from "../events/nightlife-date.ts";
import { LOCALE_LANGUAGE_TAGS, type Locale } from "../../i18n/config.ts";

export function getDiscoverPageCopy(selectedDate: string, today: string, locale: Locale = "en") {
  const date = parseDateKeyToUtcNoon(selectedDate);
  const dateLabel = date
    ? new Intl.DateTimeFormat(locale === "en" ? "en-US" : LOCALE_LANGUAGE_TAGS[locale], {
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "Europe/Belgrade",
      }).format(date)
    : selectedDate;
  if (locale !== "en") {
    const when = selectedDate === today
      ? { sr: "večeras", ru: "сегодня вечером" }[locale]
      : selectedDate === addDaysToDateKey(today, 1)
        ? { sr: "sutra", ru: "завтра" }[locale]
        : dateLabel;
    return locale === "sr" ? {
      title: `Događaji u Beogradu ${when}`,
      introduction: `Koncerti, žurke, DJ nastupi i kultura u Beogradu ${when}.`,
      description: `Pronađi koncerte, žurke, DJ nastupe, izložbe i druge događaje u Beogradu ${when}. Pogledaj mesta, najavljene termine i originalne objave.`,
    } : {
      title: `События в Белграде ${when}`,
      introduction: `Концерты, вечеринки, DJ-сеты и культура в Белграде ${when}.`,
      description: `Концерты, вечеринки, DJ-сеты, выставки и другие события Белграда ${when}. Места, объявленное время и исходные публикации.`,
    };
  }
  const when = selectedDate === today
    ? "tonight"
    : selectedDate === addDaysToDateKey(today, 1)
      ? "tomorrow"
      : `on ${dateLabel}`;

  return {
    title: `Belgrade events ${when}`,
    description: `Find concerts, club nights, DJ sets, exhibitions, and other events in Belgrade ${when}. See venues, announced times, and original event posts.`,
    introduction: `Concerts, club nights, DJ sets, and culture in Belgrade ${when}.`,
  };
}
