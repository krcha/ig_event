/** Presentation locales only. Canonical event/source values never use these. */
export const LOCALES = ["sr", "en", "ru"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "sr";
export const LOCALE_HEADER = "x-eventzeka-locale";

export const LOCALE_LANGUAGE_TAGS: Record<Locale, string> = {
  sr: "sr-Latn-RS",
  en: "en-RS",
  ru: "ru-RS",
};

export const LOCALE_NAMES: Record<Locale, string> = {
  sr: "Srpski",
  en: "English",
  ru: "Русский",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && LOCALES.some((locale) => locale === value);
}

/** A whole URL segment is required: /english and /envelope are ordinary paths. */
export function getLocaleFromPath(pathname: string): Locale {
  const match = /^\/(sr|en|ru)(?=\/|[?#]|$)/u.exec(pathname);
  return match && isLocale(match[1]) ? match[1] : DEFAULT_LOCALE;
}

export function stripLocalePrefix(pathname: string): string {
  const match = /^\/(?:sr|en|ru)(?=\/|[?#]|$)/u.exec(pathname);
  if (!match) return pathname;
  const remainder = pathname.slice(match[0].length);
  return !remainder || /^[?#]/u.test(remainder) ? `/${remainder}` : remainder;
}

export function isPublicPagePath(pathname: string): boolean {
  return /^\/(?:$|discover\/?$|map\/?$|saved\/?$|you\/?$|install\/?$|calendar\/?$|events(?:\/[^/]+)?\/?$|venues(?:\/[^/]+)?\/?$|sign-in(?:\/.*)?$|sign-up(?:\/.*)?$)/u.test(pathname);
}

/** Only public pages acquire prefixes. APIs, assets and operations stay stable. */
export function localizeHref(href: string, locale: Locale): string {
  if (!href.startsWith("/") || href.startsWith("//")) return href;
  const path = stripLocalePrefix(href);
  const boundary = path.search(/[?#]/u);
  const pathname = boundary === -1 ? path : path.slice(0, boundary);
  const suffix = boundary === -1 ? "" : path.slice(boundary);
  if (!isPublicPagePath(pathname)) return href;
  if (locale === DEFAULT_LOCALE) return `${pathname}${suffix}`;
  return `${pathname === "/" ? `/${locale}` : `/${locale}${pathname}`}${suffix}`;
}

export type LocaleRequestResolution = {
  kind: "next" | "rewrite" | "redirect" | "not_found";
  locale: Locale;
  pathname: string;
};

/** Pure URL policy shared by middleware and deterministic route regressions. */
export function resolveLocaleRequestPath(pathname: string): LocaleRequestResolution {
  const prefix = /^\/(sr|en|ru)(?=\/|$)/u.exec(pathname);
  if (!prefix) {
    return { kind: "next", locale: DEFAULT_LOCALE, pathname };
  }
  const locale = getLocaleFromPath(pathname);
  const unprefixed = stripLocalePrefix(pathname);
  if (!isPublicPagePath(unprefixed)) {
    return { kind: "not_found", locale, pathname: unprefixed };
  }
  return {
    kind: locale === DEFAULT_LOCALE ? "redirect" : "rewrite",
    locale,
    pathname: unprefixed,
  };
}
