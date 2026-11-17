"use client";

import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { useLocale } from "@/i18n/client";
import { travelText } from "@/lib/travel/copy";
import type { Coordinates } from "@/lib/travel/location";
import { loadLeaflet } from "@/lib/maps/leaflet-loader";
import "leaflet/dist/leaflet.css";

type Leaflet = typeof import("leaflet");
export { preloadLeaflet } from "@/lib/maps/leaflet-loader";

export function RouteMap({ origin, destination, coordinates, routePending = false }: {
  origin: Coordinates; destination: Coordinates; coordinates?: [number, number][]; routePending?: boolean;
}) {
  const locale = useLocale();
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<import("leaflet").Map | null>(null);
  const leaflet = useRef<Leaflet | null>(null);
  const routeLine = useRef<import("leaflet").Polyline | null>(null);
  const [mapVersion, setMapVersion] = useState(0);
  const [tileStatus, setTileStatus] = useState<"loading" | "ready" | "error">("loading");
  const originLat = origin.latitude, originLon = origin.longitude;
  const destinationLat = destination.latitude, destinationLon = destination.longitude;
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    setTileStatus("loading");
    void loadLeaflet().then((L) => {
      if (cancelled || !container.current) return;
      const instance = L.map(container.current, { scrollWheelZoom: false });
      map.current = instance;
      leaflet.current = L;
      let tileFailed = false;
      const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
      });
      tiles.on("loading", () => { tileFailed = false; if (!cancelled) setTileStatus("loading"); });
      tiles.on("tileerror", () => { tileFailed = true; if (!cancelled) setTileStatus("error"); });
      tiles.on("load", () => { if (!cancelled) setTileStatus(tileFailed ? "error" : "ready"); });
      tiles.addTo(instance);
      L.circleMarker([originLat, originLon], { radius: 7, color: "#fff", weight: 3, fillColor: "#779DFF", fillOpacity: 1 }).addTo(instance);
      L.circleMarker([destinationLat, destinationLon], { radius: 8, color: "#10141F", weight: 3, fillColor: "#D5F56B", fillOpacity: 1 }).addTo(instance);
      instance.fitBounds(L.latLngBounds([[originLat, originLon], [destinationLat, destinationLon]]), { padding: [24, 24], maxZoom: 17, animate: false });
      const observer = new ResizeObserver(() => instance.invalidateSize({ pan: false, debounceMoveend: true }));
      observer.observe(container.current);
      setMapVersion(version => version + 1);
      cleanup = () => { observer.disconnect(); instance.remove(); map.current = null; leaflet.current = null; routeLine.current = null; };
    }).catch(() => { if (!cancelled) setTileStatus("error"); });
    return () => { cancelled = true; cleanup?.(); };
  }, [originLat, originLon, destinationLat, destinationLon]);
  useEffect(() => {
    const instance = map.current, L = leaflet.current;
    if (!instance || !L) return;
    routeLine.current?.remove();
    routeLine.current = null;
    // The basemap and endpoints can appear immediately; only the real server route draws a line.
    if (!coordinates?.length) return;
    const line = L.polyline(coordinates.map(([lon, lat]) => [lat, lon]), { color: "#D5F56B", weight: 5, opacity: 1 }).addTo(instance);
    routeLine.current = line;
    instance.fitBounds(line.getBounds(), { padding: [24, 24], maxZoom: 17, animate: false });
  }, [coordinates, mapVersion]);
  const feedback = routePending ? "routeLoading" : tileStatus === "loading" ? "mapLoading" : tileStatus === "error" ? "mapTilesError" : null;
  return <div className="relative z-0 h-full min-h-0 w-full overflow-hidden rounded-2xl bg-card" aria-busy={routePending || tileStatus === "loading"}>
    <div ref={container} aria-label="OpenStreetMap" className="absolute inset-0" />
    {feedback ? <p className="pointer-events-none absolute left-12 right-12 top-2 z-[450] flex items-center justify-center gap-1.5 rounded-lg bg-background/95 px-2 py-1.5 text-center text-[10px] leading-3.5 text-foreground" role="status">{tileStatus !== "error" ? <LoaderCircle size={12} className="shrink-0 motion-safe:animate-spin" aria-hidden="true" /> : null}{travelText(locale, feedback)}</p> : null}
  </div>;
}
