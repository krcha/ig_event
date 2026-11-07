"use client";

import { createElement, useMemo, type ComponentProps, type ComponentPropsWithRef, type JSX } from "react";
import NextLink from "next/link";
import { useRouter as useNextRouter } from "next/navigation";
import { useLocale } from "@/i18n/client";
import { localizeHref } from "@/i18n/config";
import { publicText } from "@/lib/i18n/public-messages";
import { formatEventCount, formatPublicDate } from "@/lib/i18n/display";

export function PublicText({ text }: { text: string | null | undefined }) {
  const locale = useLocale();
  return text ? publicText(locale, text) : null;
}

export function PublicEventCount({ count }: { count: number }) {
  return formatEventCount(useLocale(), count);
}

export function PublicDate({ value, options }: { value: string | Date; options: Intl.DateTimeFormatOptions }) {
  return formatPublicDate(useLocale(), value, options);
}

export function PublicWeekday({ day }: { day: number }) {
  return formatPublicDate(useLocale(), new Date(Date.UTC(2026, 10, 1 + day, 12)), { weekday: "short", timeZone: "UTC" });
}

/** Explicitly localizes human-facing attributes while preserving element,
 * refs, handlers, enum values and children exactly as supplied. */
export function LocalizedElement<T extends keyof JSX.IntrinsicElements>(
  { as, ...props }: { as: T } & Omit<ComponentPropsWithRef<T>, "as">,
) {
  const locale = useLocale();
  const translated = { ...props } as Record<string, unknown>;
  for (const key of ["aria-label", "title", "placeholder", "alt"]) {
    if (typeof translated[key] === "string") translated[key] = publicText(locale, translated[key]);
  }
  if (as === "a" && typeof translated.href === "string") translated.href = localizeHref(translated.href, locale);
  if (as === "form" && typeof translated.action === "string") translated.action = localizeHref(translated.action, locale);
  return createElement(as, translated);
}

export function LocalizedLink({ href, ...props }: ComponentProps<typeof NextLink>) {
  const locale = useLocale();
  const localized = typeof href === "string" ? localizeHref(href, locale)
    : href.pathname && !href.host && !href.hostname && !href.protocol
      ? { ...href, pathname: localizeHref(href.pathname, locale) } : href;
  return <NextLink {...props} aria-label={typeof props["aria-label"] === "string" ? publicText(locale, props["aria-label"]) : props["aria-label"]} title={typeof props.title === "string" ? publicText(locale, props.title) : props.title} href={localized} />;
}

export function useLocalizedRouter() {
  const router = useNextRouter();
  const locale = useLocale();
  return useMemo(() => ({ ...router,
    push: (href: string, options?: Parameters<typeof router.push>[1]) => router.push(localizeHref(href, locale), options),
    replace: (href: string, options?: Parameters<typeof router.replace>[1]) => router.replace(localizeHref(href, locale), options),
    prefetch: (href: string, options?: Parameters<typeof router.prefetch>[1]) => router.prefetch(localizeHref(href, locale), options),
  }), [router, locale]);
}
