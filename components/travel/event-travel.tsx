"use client";

import { CarFront, Footprints, LocateFixed } from "lucide-react";
import { useLocale } from "@/i18n/client";
import { travelText } from "@/lib/travel/copy";
import { estimateTravel, isCoordinates } from "@/lib/travel/location";
import { formatTravelDuration } from "@/lib/travel/duration";
import { useUserLocation } from "./user-location";
import { YandexTaxiButton } from "./yandex-taxi-button";

export function EventTravel({ venueLatitude, venueLongitude, venueName, showTaxi = true, className = "" }: {
  venueLatitude?: number; venueLongitude?: number; venueName?: string; showTaxi?: boolean; className?: string;
}) {
  const locale = useLocale();
  const { position, status, error, requestLocation } = useUserLocation();
  const destination = { latitude: venueLatitude!, longitude: venueLongitude! };
  if (!isCoordinates(destination)) return null;
  const times = position ? estimateTravel(position, destination) : null;
  return <div className={`flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground ${className}`} title={travelText(locale, "estimate")}>
    {times ? <>
      <span className={`inline-flex items-center gap-1.5 ${times.walkMinutes <= 10 ? "font-semibold text-foreground" : ""}`}><Footprints aria-hidden="true" className="h-3.5 w-3.5" />≈ {formatTravelDuration(times.walkMinutes, locale)} {travelText(locale, "walk")}</span>
      <span className={`inline-flex items-center gap-1.5 ${times.walkMinutes > 10 ? "font-semibold text-foreground" : ""}`}><CarFront aria-hidden="true" className="h-3.5 w-3.5" />≈ {formatTravelDuration(times.driveMinutes, locale)} {travelText(locale, "drive")}</span>
    </> : <button type="button" onClick={requestLocation} disabled={status === "loading"} className="inline-flex min-h-11 items-center gap-1.5 text-left hover:text-foreground disabled:opacity-60"><LocateFixed aria-hidden="true" className="h-3.5 w-3.5" />{travelText(locale, status === "loading" ? "locating" : "locate")}</button>}
    {showTaxi ? <span className="ml-auto"><YandexTaxiButton {...destination} venueName={venueName} /></span> : null}
    {error ? <span className="basis-full" role="status">{error}</span> : null}
  </div>;
}
