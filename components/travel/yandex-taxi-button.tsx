"use client";

import { yandexDestinationHref } from "@/lib/travel/location";

export function YandexTaxiButton({ latitude, longitude, venueName = "", className = "" }: {
  latitude: number; longitude: number; venueName?: string; className?: string;
}) {
  const href = yandexDestinationHref({ latitude, longitude });
  if (!href) return null;
  return <a href={href} aria-label={`Yandex Taxi${venueName ? ` · ${venueName}` : ""}`} title={`Yandex Taxi${venueName ? ` · ${venueName}` : ""}`}
    className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${className}`}>
    {/* The native app selects pickup. Never send a remembered GPS/venue origin. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src="/images/yandex-go.webp" alt="" width={32} height={32} className="h-8 w-8 rounded-[7px] object-contain transition-[filter] hover:brightness-110" />
  </a>;
}
