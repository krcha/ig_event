import { ArrowLeft, ArrowUpRight, MapPin } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";
import type { Locale } from "@/i18n/config";
import Link from "next/link";
import { notFound } from "next/navigation";

import { api } from "@/convex/_generated/api";
import { CompareTiming } from "@/components/travel/compare-timing";
import { CompassMatchSpectrum } from "@/components/travel/compass-match-spectrum";
import { localizeHref } from "@/i18n/config";
import { getLocale } from "@/i18n/server";
import { isPlausibleConvexPublicId } from "@/lib/convex/public-id";
import { readTravelPart } from "@/lib/travel/public-read-client";
import { getDisplayEventTime } from "@/lib/events/event-time";
import { addDaysToDateKey } from "@/lib/events/nightlife-date";
import type { PublicEvent } from "@/lib/events/public-events";
import { loadRecommendationWindow } from "@/lib/travel/recommendation-window";
import { formatPublicDate } from "@/lib/i18n/display";
import { localizedMetadata } from "@/lib/i18n/seo";
import { travelText } from "@/lib/travel/copy";
import { getEventRecommendationWindow, rankEventRecommendations } from "@/lib/travel/event-recommendations";

export const revalidate = 60;

type PageProps = { params: Promise<{ eventId: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const [{ eventId }, locale] = await Promise.all([params, getLocale()]);
  const title = travelText(locale, "compareEvents");
  return localizedMetadata({ locale, path: `/next/event/${eventId}`, title, description: title, index: false });
}

export default async function CompareEventPage({ params }: PageProps) {
  const [{ eventId }, locale] = await Promise.all([params, getLocale()]);
  if (!isPlausibleConvexPublicId(eventId)) notFound();

  let reference: PublicEvent | null;
  try {
    reference = await readTravelPart(10_000, client => client.query(
      api.events.getPublicApprovedEvent,
      { id: eventId, includeEventTaxonomy: true },
    )) as PublicEvent | null;
  } catch {
    return <main className="app-page"><CompareTiming key={Date.now()} stage="reference" failed /></main>;
  }
  if (!reference) notFound();

  const now = Date.now();
  const window = getEventRecommendationWindow(reference.date, now);
  const t = (key: Parameters<typeof travelText>[1]) => travelText(locale, key);
  const dateLabel = (date: string) => formatPublicDate(locale, date, { day: "numeric", month: "short" });

  return (
    <main className="app-page gap-5 pb-24">
      <nav className="flex flex-wrap items-center justify-between gap-2" aria-label={t("compareEvents")}>
        <Link className="button-secondary min-h-10 gap-2 px-3" href={localizeHref(`/events/${reference._id}`, locale)}>
          <ArrowLeft aria-hidden="true" size={16} />{t("details")}
        </Link>
        <Link className="button-secondary min-h-10 gap-2 px-3" href={localizeHref("/next", locale)}>
          <MapPin aria-hidden="true" size={16} />{t("useLocationInstead")}
        </Link>
      </nav>

      <header className="hero-panel grid gap-4 p-4 sm:p-6">
        <h1 className="text-3xl font-semibold tracking-tight">{t("compareEvents")}</h1>
        <div className="grid gap-0.5 border-l-2 border-primary pl-3">
          <p className="text-xs text-muted-foreground">{t("compareReference")}</p>
          <h2 className="break-words text-lg font-semibold">{reference.title}</h2>
          <p className="text-sm text-muted-foreground">{reference.venue} · {dateLabel(reference.date)}</p>
        </div>
        <p className="text-xs text-muted-foreground">{t("comparePeriod")} · {dateLabel(window.fromDate)} – {dateLabel(addDaysToDateKey(window.beforeDate, -1))}</p>
      </header>

      <CompareTiming stage="reference" />
      <Suspense fallback={<p role="status">{t("loadingProgrammes")}</p>}>
        <RecommendationResults reference={reference} window={window} now={now} locale={locale} />
      </Suspense>
    </main>
  );
}

async function RecommendationResults({ reference, window, now, locale }: {
  reference: PublicEvent; window: ReturnType<typeof getEventRecommendationWindow>; now: number; locale: Locale;
}) {
  const calendar = await readTravelPart(22_000, client => loadRecommendationWindow(client, window)).catch(() => null);
  const t = (key: Parameters<typeof travelText>[1]) => travelText(locale, key);
  if (!calendar || calendar.error) return <CompareTiming key={now} stage="recommendations" failed />;
  const results = rankEventRecommendations(reference, calendar.events, now);
  const dateLabel = (date: string) => formatPublicDate(locale, date, { day: "numeric", month: "short" });
  return (
    <div className="grid grid-cols-1 items-start gap-5 md:grid-cols-2">
      <CompareTiming stage="recommendations" />
      {(["same", "different"] as const).map((mode) => (
        <section key={mode} className="grid min-w-0 gap-3" aria-labelledby={`compare-${mode}`}>
          <h2 className="text-xl font-semibold" id={`compare-${mode}`}>{t(mode)}</h2>
          {results[mode].length ? (
            <ul className="grid gap-2">
              {results[mode].map(({ event, match }) => {
                const time = event.timeStatus === "unknown" ? undefined : getDisplayEventTime(event.time);
                return (
                  <li key={event._id} className="grid gap-3 rounded-xl border border-border bg-card p-3 sm:p-4">
                    <Link className="group flex items-start justify-between gap-2 font-semibold hover:text-primary focus-visible:text-primary" href={localizeHref(`/events/${event._id}`, locale)} prefetch={false}>
                      <span className="break-words">{event.title}</span><ArrowUpRight aria-hidden="true" size={18} className="shrink-0 text-muted-foreground group-hover:text-primary" />
                    </Link>
                    <p className="text-sm text-muted-foreground">
                      {event.venue} · {dateLabel(event.date)}{time ? ` · ${time}` : ""}
                    </p>
                    <CompassMatchSpectrum score={match.score} reason={match.reason} locale={locale} />
                  </li>
                );
              })}
            </ul>
          ) : <p className="text-sm text-muted-foreground">{t("noEventMatches")}</p>}
        </section>
      ))}
    </div>
  );
}
