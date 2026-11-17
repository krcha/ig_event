"use client";

import { useEffect, useRef } from "react";
import type { Coordinates } from "@/lib/travel/location";
import "leaflet/dist/leaflet.css";

export function RouteMap({ origin, destination, coordinates }: {
  origin: Coordinates; destination: Coordinates; coordinates: [number, number][];
}) {
  const container = useRef<HTMLDivElement>(null);
  const originLat = origin.latitude, originLon = origin.longitude;
  const destinationLat = destination.latitude, destinationLon = destination.longitude;
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    void import("leaflet").then((L) => {
      if (cancelled || !container.current) return;
      const map = L.map(container.current, { scrollWheelZoom: false });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
      }).addTo(map);
      const line = L.polyline(coordinates.map(([lon, lat]) => [lat, lon]), { color: "#D5F56B", weight: 5, opacity: 1 }).addTo(map);
      L.circleMarker([originLat, originLon], { radius: 7, color: "#fff", weight: 3, fillColor: "#779DFF", fillOpacity: 1 }).addTo(map);
      L.circleMarker([destinationLat, destinationLon], { radius: 8, color: "#10141F", weight: 3, fillColor: "#D5F56B", fillOpacity: 1 }).addTo(map);
      map.fitBounds(line.getBounds(), { padding: [24, 24], maxZoom: 17, animate: false });
      const observer = new ResizeObserver(() => map.invalidateSize());
      observer.observe(container.current);
      cleanup = () => { observer.disconnect(); map.remove(); };
    });
    return () => { cancelled = true; cleanup?.(); };
  }, [coordinates, originLat, originLon, destinationLat, destinationLon]);
  return <div ref={container} aria-label="OpenStreetMap" className="relative z-0 h-full min-h-0 w-full overflow-hidden rounded-2xl bg-card" />;
}
