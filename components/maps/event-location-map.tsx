"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Expand, LoaderCircle, MapPin } from "lucide-react";
import type { Map as LeafletMap, Marker } from "leaflet";
import type { EventMapLocation } from "@/lib/events/event-map";
import "leaflet/dist/leaflet.css";
import "./event-map.css";

const BELGRADE_CENTER: [number, number] = [44.8125, 20.4612];

type EventLocationMapProps = {
  locations: EventMapLocation[];
  selectedLocationId: string | null;
  onSelectLocation: (id: string) => void;
};

export function EventLocationMap({ locations, selectedLocationId, onSelectLocation }: EventLocationMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapInstanceId = useId();
  const mapRef = useRef<LeafletMap | null>(null);
  const markersRef = useRef(new Map<string, Marker>());
  const popupButtonsRef = useRef(new Map<string, HTMLButtonElement>());
  const fitMapRef = useRef<(() => void) | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [tilesUnavailable, setTilesUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let resizeObserver: ResizeObserver | undefined;
    const markers = markersRef.current;
    const popupButtons = popupButtonsRef.current;
    setStatus("loading");
    setTilesUnavailable(false);

    async function initializeMap() {
      const L = await import("leaflet");
      if (cancelled || !containerRef.current) return;
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const map = L.map(containerRef.current, {
        center: BELGRADE_CENTER,
        zoom: 13,
        scrollWheelZoom: false,
        zoomControl: false,
        zoomAnimation: !reducedMotion,
        fadeAnimation: !reducedMotion,
        markerZoomAnimation: !reducedMotion,
      });
      mapRef.current = map;
      L.control.zoom({ position: "bottomright" }).addTo(map);
      let loadedTiles = 0;
      const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
      });
      tiles.on("tileload", () => {
        loadedTiles += 1;
        if (!cancelled) setTilesUnavailable(false);
      });
      tiles.on("tileerror", () => {
        if (!cancelled && loadedTiles === 0) setTilesUnavailable(true);
      });
      tiles.addTo(map);

      const pointGroups = new Map<string, { location: EventMapLocation; number: number }[]>();
      locations.forEach((location, index) => {
        const point = JSON.stringify([location.latitude, location.longitude]);
        const group = pointGroups.get(point) ?? [];
        group.push({ location, number: index + 1 });
        pointGroups.set(point, group);
      });

      [...pointGroups.values()].forEach((group, groupIndex) => {
        const { location, number } = group[0];
        const shared = group.length > 1;
        const markerLabel = shared
          ? `${group.length} venues at this location. Choose a venue to show its lineup.`
          : `${location.name}, ${location.events.length} ${location.events.length === 1 ? "event" : "events"}. Show lineup.`;
        const marker = L.marker([location.latitude, location.longitude], {
          icon: L.divIcon({
            className: shared ? "event-map-pin is-shared" : "event-map-pin",
            html: shared
              ? `<span class="event-map-pin-number">${group.length}<span class="event-map-pin-caption">venues</span></span><span class="event-map-pin-dot"></span>`
              : `<span class="event-map-pin-number">${number}</span><span class="event-map-pin-dot"></span>`,
            iconSize: shared ? [56, 54] : [40, 48],
            iconAnchor: shared ? [28, 50] : [20, 44],
          }),
          title: markerLabel,
          alt: shared ? `${group.length} venues` : location.name,
          keyboard: true,
          riseOnHover: true,
        }).addTo(map);
        const tooltip = document.createElement("span");
        tooltip.textContent = shared ? `${group.length} venues at this location` : location.name;
        marker.bindTooltip(tooltip, { direction: "top", offset: [0, shared ? -50 : -42] });
        const element = marker.getElement();
        if (element) {
          element.setAttribute("role", "button");
          element.setAttribute("aria-label", markerLabel);
          element.addEventListener("keydown", (event) => {
            if (event.key === " " || event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              if (shared) marker.openPopup();
              else onSelectLocation(location.id);
            }
          });
        }

        if (shared) {
          const popupContent = document.createElement("div");
          popupContent.className = "event-map-shared-venues";
          popupContent.id = `${mapInstanceId}-shared-${groupIndex}`;
          popupContent.setAttribute("role", "dialog");
          popupContent.setAttribute("aria-label", "Choose a venue at this location");
          const heading = document.createElement("p");
          heading.className = "event-map-shared-heading";
          heading.textContent = `${group.length} venues at this location`;
          popupContent.append(heading);

          group.forEach((entry) => {
            const button = document.createElement("button");
            button.className = "event-map-venue-choice";
            button.type = "button";
            button.setAttribute("aria-label", `${entry.number}. ${entry.location.name}, ${entry.location.events.length} ${entry.location.events.length === 1 ? "event" : "events"}. Show lineup.`);
            const venueNumber = document.createElement("span");
            venueNumber.className = "event-map-venue-number";
            venueNumber.setAttribute("aria-hidden", "true");
            venueNumber.textContent = String(entry.number);
            const venueLabel = document.createElement("span");
            venueLabel.className = "event-map-venue-label";
            const venueName = document.createElement("span");
            venueName.className = "event-map-venue-name";
            venueName.textContent = entry.location.name;
            const eventCount = document.createElement("span");
            eventCount.className = "event-map-venue-count";
            eventCount.textContent = `${entry.location.events.length} ${entry.location.events.length === 1 ? "event" : "events"}`;
            venueLabel.append(venueName, eventCount);
            button.append(venueNumber, venueLabel);
            button.addEventListener("click", () => {
              marker.closePopup();
              onSelectLocation(entry.location.id);
            });
            popupButtons.set(entry.location.id, button);
            popupContent.append(button);
          });

          popupContent.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              marker.closePopup();
            }
          });
          marker.bindPopup(popupContent, {
            className: "event-map-shared-popup",
            minWidth: 210,
            maxWidth: 280,
            offset: [0, -42],
            autoPanPaddingTopLeft: [12, 92],
            autoPanPaddingBottomRight: [12, 24],
          });
          element?.setAttribute("aria-haspopup", "dialog");
          element?.setAttribute("aria-controls", popupContent.id);
          element?.setAttribute("aria-expanded", "false");
          marker.on("popupopen", () => {
            element?.setAttribute("aria-expanded", "true");
            const selected = group.find((entry) => popupButtons.get(entry.location.id)?.getAttribute("aria-pressed") === "true");
            popupButtons.get((selected ?? group[0]).location.id)?.focus({ preventScroll: true });
          });
          marker.on("popupclose", () => {
            element?.setAttribute("aria-expanded", "false");
            if (!cancelled && (popupContent.contains(document.activeElement) || document.activeElement === document.body)) {
              element?.focus({ preventScroll: true });
            }
          });
        } else {
          marker.on("click", () => onSelectLocation(location.id));
        }
        group.forEach((entry) => markers.set(entry.location.id, marker));
      });

      function fitMap() {
        if (locations.length === 0) {
          map.setView(BELGRADE_CENTER, 13);
        } else {
          map.fitBounds(L.latLngBounds(locations.map((location) => [location.latitude, location.longitude])), {
            paddingTopLeft: [64, 112],
            paddingBottomRight: [64, 88],
            maxZoom: 15,
            animate: false,
          });
        }
      }
      fitMapRef.current = fitMap;
      fitMap();
      resizeObserver = new ResizeObserver(() => map.invalidateSize({ pan: false }));
      resizeObserver.observe(containerRef.current);
      setStatus("ready");
    }

    initializeMap().catch(() => {
      if (!cancelled) setStatus("failed");
    });

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      markers.clear();
      popupButtons.clear();
      fitMapRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [locations, mapInstanceId, onSelectLocation]);

  useEffect(() => {
    if (status !== "ready") return;
    const selectedMarker = selectedLocationId ? markersRef.current.get(selectedLocationId) : undefined;
    new Set(markersRef.current.values()).forEach((marker) => {
      const selected = marker === selectedMarker;
      marker.getElement()?.classList.toggle("is-selected", selected);
      marker.getElement()?.setAttribute("aria-pressed", String(selected));
      marker.setZIndexOffset(selected ? 1000 : 0);
      if (selected) {
        mapRef.current?.setView(marker.getLatLng(), Math.max(mapRef.current.getZoom(), 14), {
          animate: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        });
      }
    });
    popupButtonsRef.current.forEach((button, id) => {
      button.setAttribute("aria-pressed", String(id === selectedLocationId));
    });
  }, [selectedLocationId, status]);

  return (
    <div className="event-map-shell relative isolate min-w-0 overflow-hidden rounded-[1.25rem] border border-border">
      <div aria-label="Event locations in Belgrade. Use arrow keys to pan and plus or minus to zoom." className="event-location-map h-[380px] w-full sm:h-[480px] lg:h-[620px]" ref={containerRef} />
      {status === "loading" || status === "failed" ? (
        <div className="pointer-events-none absolute inset-0 z-[500] flex items-center justify-center bg-card/90 px-6 text-center">
          <div>
            {status === "loading" ? <LoaderCircle aria-hidden="true" className="mx-auto mb-3 h-6 w-6 animate-spin text-primary" /> : <MapPin aria-hidden="true" className="mx-auto mb-3 h-6 w-6 text-primary" />}
            <p role="status" className="text-sm text-muted-foreground">{status === "loading" ? "Loading Belgrade map..." : "Map unavailable. Browse the events below."}</p>
          </div>
        </div>
      ) : null}
      {status === "ready" ? (
        <div className="pointer-events-none absolute left-3 right-3 top-3 z-[500] flex items-start justify-between gap-2">
          <span className="rounded-full border border-border bg-card/95 px-3 py-2 text-xs font-semibold text-foreground shadow-lg">
            {locations.length} {locations.length === 1 ? "venue" : "venues"} on the map
          </span>
          <button className="button-secondary pointer-events-auto min-h-10 gap-2 bg-card/95 px-3 py-0 text-xs shadow-lg" onClick={() => fitMapRef.current?.()} type="button">
            <Expand aria-hidden="true" className="h-4 w-4" />
            Show all
          </button>
        </div>
      ) : null}
      {tilesUnavailable && status === "ready" ? (
        <p role="status" className="pointer-events-none absolute bottom-14 left-3 right-14 z-[500] rounded-xl border border-border bg-card/95 px-3 py-2 text-xs text-muted-foreground">
          The street map could not load. Venue pins and event details are still available.
        </p>
      ) : null}
      {locations.length === 0 && status === "ready" && !tilesUnavailable ? (
        <p className="pointer-events-none absolute bottom-14 left-3 z-[500] max-w-[75%] rounded-xl border border-border bg-card/95 px-3 py-2 text-xs text-muted-foreground">
          No mapped locations for this day.
        </p>
      ) : null}
    </div>
  );
}
