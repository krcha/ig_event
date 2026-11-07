import type { Locale } from "../../i18n/config.ts";

type EventContent = {
  title: string;
  venue: string;
  artists: string[];
  eventType?: string;
  description?: string;
  sourceCaption?: string;
};

export type LocalizedEventDescription = { text: string; original: boolean };

/** Display-only: canonical descriptions also feed classification and dedupe. */
export function getLocalizedEventDescription(event: EventContent, locale: Locale): LocalizedEventDescription {
  const description = event.description?.trim() ?? "";
  const artists = event.artists.map(value => value.trim()).filter(Boolean);
  const rawKind = event.eventType?.trim() ?? "";
  const humanKind = rawKind ? rawKind[0].toUpperCase() + rawKind.slice(1) : "Event";
  const kind = /\bevent\b/iu.test(humanKind) ? humanKind : `${humanKind} event`;
  const lists = [artists.join(", ")];
  if (artists.length > 1) {
    lists.push(`${artists.slice(0, -1).join(", ")} and ${artists.at(-1)}`);
    lists.push(new Intl.ListFormat("en", { type: "conjunction" }).format(artists));
  }
  const known = new Set(lists.flatMap(lineup => [
    `${kind} with ${lineup} at ${event.venue}.`,
    `Nightlife event with ${lineup} at ${event.venue}.`,
    `Event with ${lineup} at ${event.venue}.`,
  ]));
  const identityOnly = new Set([
    `${event.title} at ${event.venue}.`,
    `${event.title} at ${event.venue} in Belgrade.`,
  ]);
  if (description && !known.has(description) && !identityOnly.has(description)) {
    return { text: description, original: true };
  }
  const list = new Intl.ListFormat(locale === "sr" ? "sr-Latn" : locale, { type: "conjunction" }).format(artists);
  if (artists.length && known.has(description)) {
    return { text: {
      sr: `Događaj sa izvođačima ${list}, mesto: ${event.venue}.`,
      en: `Event with ${list} at ${event.venue}.`,
      ru: `Событие с участием ${list}. Место: ${event.venue}.`,
    }[locale], original: false };
  }
  return { text: {
    sr: `${event.title} — ${event.venue}, Beograd.`,
    en: `${event.title} at ${event.venue}, Belgrade.`,
    ru: `${event.title} — ${event.venue}, Белград.`,
  }[locale], original: false };
}

/** Existing Serbian URLs retain eligibility; alternates require translated prose. */
export function getEventContentLocales(event: EventContent): Locale[] {
  const preferred = event.sourceCaption?.trim() || event.description;
  return getLocalizedEventDescription({ ...event, description: preferred }, "sr").original ? ["sr"] : ["sr", "en", "ru"];
}
