import type { Metadata } from "next";
import { LOCALES, LOCALE_LANGUAGE_TAGS, localizeHref, type Locale } from "../../i18n/config.ts";

export const SITE_ORIGIN = "https://eventzeka.com";
export const OG_LOCALES: Record<Locale, string> = { sr: "sr_RS", en: "en_RS", ru: "ru_RS" };

export const SITE_COPY = {
  sr: {
    homeTitle: "Dešavanja u Beogradu: žurke i koncerti",
    description: "Dešavanja u Beogradu danas i za vikend: pronađi žurke, koncerte, kvizove i izložbe. Izaberi datum i saznaj gde da izađeš.",
    calendarTitle: "Događaji u Beogradu",
    mapTitle: "Mapa događaja u Beogradu",
    mapDescription: "Izaberi dan i pogledaj gde se održavaju koncerti, žurke, DJ nastupi i kulturni događaji u Beogradu.",
    directoryTitle: "Mesta u Beogradu: noćni život i kultura",
    directoryDescription: "Istraži klubove, barove, koncertne prostore, galerije, pozorišta i druga mesta u Beogradu, uz lokacije i zvanične Instagram profile.",
    installTitle: "Instaliraj EventZeka App",
    installDescription: "Dodaj EventZeka App na početni ekran. Uputstvo za iPhone, Android i računar.",
    savedTitle: "Sačuvani događaji i mesta", profileTitle: "Tvoj profil", accountTitle: "Tvoj nalog",
    venueTitle: "događaji i informacije o mestu", page: "Strana", belgrade: "Beograd", events: "Događaji", venues: "Mesta",
  },
  en: {
    homeTitle: "Belgrade events: parties and concerts",
    description: "Find events in Belgrade today and this weekend: parties, concerts, quizzes and exhibitions. Choose a date and plan your next night out.",
    calendarTitle: "Belgrade events",
    mapTitle: "Belgrade event map",
    mapDescription: "Choose a day and see where Belgrade concerts, club nights, DJ sets and cultural events are happening.",
    directoryTitle: "Belgrade venues: nightlife and culture guide",
    directoryDescription: "Explore Belgrade clubs, bars, concert spaces, galleries, theatres and cultural venues, with locations and official Instagram profiles.",
    installTitle: "Install EventZeka App",
    installDescription: "Add EventZeka App to your home screen. Instructions for iPhone, Android and desktop.",
    savedTitle: "Saved events and venues", profileTitle: "Your profile", accountTitle: "Your account",
    venueTitle: "venue events and information", page: "Page", belgrade: "Belgrade", events: "Events", venues: "Venues",
  },
  ru: {
    homeTitle: "События в Белграде: вечеринки и концерты",
    description: "События в Белграде сегодня и в выходные: вечеринки, концерты, квизы и выставки. Выберите дату и спланируйте отдых.",
    calendarTitle: "События в Белграде",
    mapTitle: "Карта событий Белграда",
    mapDescription: "Выберите день и посмотрите, где проходят концерты, вечеринки, DJ-сеты и культурные события Белграда.",
    directoryTitle: "Места Белграда: ночная жизнь и культура",
    directoryDescription: "Клубы, бары, концертные площадки, галереи, театры и культурные пространства Белграда: адреса и официальные профили Instagram.",
    installTitle: "Установить EventZeka App",
    installDescription: "Добавьте EventZeka App на главный экран. Инструкции для iPhone, Android и компьютера.",
    savedTitle: "Сохранённые события и места", profileTitle: "Ваш профиль", accountTitle: "Ваш аккаунт",
    venueTitle: "события и информация о месте", page: "Страница", belgrade: "Белград", events: "События", venues: "Места",
  },
} as const;

export function localizedAbsoluteUrl(path: string, locale: Locale): string {
  return new URL(localizeHref(path, locale), SITE_ORIGIN).toString();
}

export function localizedAlternates(path: string, locale: Locale, readyLocales: readonly Locale[] = LOCALES) {
  return {
    canonical: localizedAbsoluteUrl(path, locale),
    ...(readyLocales.includes(locale) ? { languages: Object.fromEntries([
      ...readyLocales.map(value => [value === "sr" ? "sr-Latn" : value, localizedAbsoluteUrl(path, value)]),
      ["x-default", localizedAbsoluteUrl(path, "sr")],
    ]) } : {}),
  };
}

export function localizedMetadata(options: {
  locale: Locale; path: string; title: string; description?: string; type?: "article" | "website";
  index?: boolean; follow?: boolean; image?: string | null; readyLocales?: readonly Locale[];
}): Metadata {
  const { locale, path, title, description, type = "website", index = true, follow = true, image, readyLocales = LOCALES } = options;
  const canIndex = index && readyLocales.includes(locale);
  const images = [{ url: image ? new URL(image, SITE_ORIGIN).toString() : `${SITE_ORIGIN}/api/og?locale=${locale}`, alt: title }];
  return {
    title: path === "/" ? { absolute: `${title} | Event Zeka` } : title,
    ...(description ? { description } : {}),
    alternates: localizedAlternates(path, locale, readyLocales),
    openGraph: {
      title: `${title} | Event Zeka`, description, type,
      locale: OG_LOCALES[locale], alternateLocale: readyLocales.filter(value => value !== locale).map(value => OG_LOCALES[value]),
      siteName: "Event Zeka", url: localizedAbsoluteUrl(path, locale),
      ...(images ? { images } : {}),
    },
    twitter: { card: "summary_large_image", title: `${title} | Event Zeka`, description, ...(images ? { images: images.map(value => value.url) } : {}) },
    robots: { index: canIndex, follow, googleBot: { index: canIndex, follow, "max-image-preview": "large", "max-snippet": -1, "max-video-preview": -1 } },
  };
}

export function getHomeFaqItems(locale: Locale) {
  return {
    sr: [
      { question: "Koje događaje mogu da pronađem na Event Zeka?", answer: "Pronađi žurke, koncerte, izložbe, pozorišne predstave i druge događaje u Beogradu. Izaberi datum u kalendaru i pogledaj program." },
      { question: "Da li Event Zeka mogu da koriste turisti?", answer: "Da. Interfejs je dostupan na srpskom, engleskom i ruskom. Pogledaj najavljene termine, mesta, izvođače, dostupne informacije o ulaznicama i originalne Instagram objave." },
      { question: "Kako da pronađem događaj?", answer: "Izaberi datum, pretraži naziv događaja, izvođača ili mesto, pa otvori detalje i originalnu najavu. Nazivi i sadržaj objave ostaju onakvi kakvi su najavljeni." },
    ],
    en: [
      { question: "What events can I find on Event Zeka?", answer: "Find club nights, concerts, exhibitions, theatre and other events in Belgrade. Choose a calendar date to see what's on." },
      { question: "Is Event Zeka useful for tourists?", answer: "Yes. The interface is available in Serbian, English and Russian, with announced times, venues, artists, available ticket information and original Instagram sources." },
      { question: "How do I find an event?", answer: "Choose a date, search for an event, artist or venue, then open the details and original announcement. Announced names and original posts retain their original wording." },
    ],
    ru: [
      { question: "Какие события можно найти на Event Zeka?", answer: "Вечеринки, концерты, выставки, спектакли и другие события Белграда. Выберите дату в календаре, чтобы посмотреть программу." },
      { question: "Подходит ли Event Zeka туристам?", answer: "Да. Интерфейс доступен на сербском, английском и русском языках. В карточках указаны объявленное время, места, участники, доступная информация о билетах и исходные публикации Instagram." },
      { question: "Как найти событие?", answer: "Выберите дату, найдите событие, артиста или место и откройте подробности и исходный анонс. Названия и оригинальные публикации сохраняют исходный текст." },
    ],
  }[locale];
}

export function formatSeoDate(dateKey: string, locale: Locale): string {
  return new Intl.DateTimeFormat(LOCALE_LANGUAGE_TAGS[locale], { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${dateKey}T12:00:00Z`));
}
