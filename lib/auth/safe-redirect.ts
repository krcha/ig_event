import { localizeHref, stripLocalePrefix, type Locale } from "@/i18n/config";

/** Accept only same-origin relative destinations, excluding localized auth
 * routes as well as their encoded equivalents to prevent return loops. */
export function getSafeRedirectPath(value: string | null, locale?: Locale): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/u.test(value)) return null;
  try {
    const origin = "https://eventzeka.invalid";
    const url = new URL(value, origin);
    if (url.origin !== origin) return null;
    const pathname = stripLocalePrefix(decodeURIComponent(url.pathname));
    if (/^\/(?:sign-in|sign-up|sso-callback)(?:\/|$)/u.test(pathname)) return null;
    const destination = `${url.pathname}${url.search}${url.hash}`;
    return locale ? localizeHref(destination, locale) : destination;
  } catch {
    return null;
  }
}
