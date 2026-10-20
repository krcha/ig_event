"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Expand, LoaderCircle, LocateFixed, MapPin } from "lucide-react";
import type { Map as LeafletMap, Marker } from "leaflet";
import type { EventMapLocation } from "@/lib/events/event-map";
import { getEventSessionLabel } from "@/lib/events/event-session";
import { resolveEventTimePresentation } from "@/lib/events/event-time-presentation";
import { OPEN_NOW_POSSIBLE_LABEL } from "@/components/events/open-now-status";
import { cn } from "@/lib/utils";
import "leaflet/dist/leaflet.css";
import "./event-map.css";

const BELGRADE_CENTER: [number, number] = [44.8125, 20.4612];

type EventLocationMapProps = {
  className?: string;
  controls?: ReactNode;
  locations: EventMapLocation[];
  selectedLocationId: string | null;
  onSelectLocation: (id: string) => void;
  possibleEventIds?: readonly string[];
};

export function EventLocationMap({ className, controls, locations, selectedLocationId, onSelectLocation, possibleEventIds = [] }: EventLocationMapProps) {
  // Server refreshes create new prop objects. Keep Leaflet alive when their
  // content is unchanged so open popups, the viewport, and location tracking
  // survive the Open now clock refresh.
  const locationsSnapshot = JSON.stringify(locations);
  const mapLocations = useMemo(() => JSON.parse(locationsSnapshot) as EventMapLocation[], [locationsSnapshot]);
  const possibleIdsSnapshot = JSON.stringify(possibleEventIds);
  const possibleIds = useMemo(() => new Set<string>(JSON.parse(possibleIdsSnapshot)), [possibleIdsSnapshot]);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapInstanceId = useId();
  const mapRef = useRef<LeafletMap | null>(null);
  const markersRef = useRef(new Map<string, Marker>());
  const popupButtonsRef = useRef(new Map<string, HTMLButtonElement>());
  const fitMapRef = useRef<(() => void) | null>(null);
  const locateUserRef = useRef<(() => void) | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [tilesUnavailable, setTilesUnavailable] = useState(false);
  const [locationStatus, setLocationStatus] = useState<"idle" | "locating" | "ready" | "error">("idle");
  const [locationMessage, setLocationMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    let resizeObserver: ResizeObserver | undefined;
    let removeViewportListener: (() => void) | undefined;
    let locationWatchId: number | undefined;
    const viewportMarkerCleanup: (() => void)[] = [];
    const markers = markersRef.current;
    const popupButtons = popupButtonsRef.current;
    setStatus("loading");
    setTilesUnavailable(false);
    setLocationStatus("idle");
    setLocationMessage("");

    async function initializeMap() {
      const L = await import("leaflet");
      if (cancelled || !containerRef.current) return;
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const desktopViewport = window.matchMedia("(min-width: 1024px)");
      const map = L.map(containerRef.current, {
        center: BELGRADE_CENTER,
        zoom: desktopViewport.matches ? 13 : 14,
        scrollWheelZoom: false,
        zoomControl: false,
        zoomAnimation: !reducedMotion,
        fadeAnimation: !reducedMotion,
        markerZoomAnimation: !reducedMotion,
      });
      mapRef.current = map;
      const locationPane = map.createPane("user-location");
      locationPane.style.zIndex = "625";
      locationPane.style.pointerEvents = "none";
      let userMarker: ReturnType<typeof L.circleMarker> | undefined;
      let accuracyCircle: ReturnType<typeof L.circle> | undefined;
      let locationRequest = 0;
      locateUserRef.current = () => {
        if (!navigator.geolocation) {
          setLocationStatus("error");
          setLocationMessage("Your browser does not support location. Try another browser.");
          return;
        }
        if (locationWatchId !== undefined) navigator.geolocation.clearWatch(locationWatchId);
        const request = ++locationRequest;
        let centerOnNextFix = true;
        setLocationStatus("locating");
        setLocationMessage("");
        locationWatchId = navigator.geolocation.watchPosition((position) => {
          if (cancelled || request !== locationRequest) return;
          const { latitude, longitude, accuracy } = position.coords;
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(accuracy)) return;
          const point: [number, number] = [latitude, longitude];
          if (accuracyCircle) {
            accuracyCircle.setLatLng(point).setRadius(Math.max(accuracy, 0));
            userMarker?.setLatLng(point);
          } else {
            accuracyCircle = L.circle(point, {
              radius: Math.max(accuracy, 0),
              pane: "user-location",
              color: "#60a5fa",
              weight: 1,
              fillColor: "#3b82f6",
              fillOpacity: 0.12,
              interactive: false,
            }).addTo(map);
            userMarker = L.circleMarker(point, {
              radius: 8,
              pane: "user-location",
              className: "event-map-user-location",
              color: "#ffffff",
              weight: 3,
              fillColor: "#3b82f6",
              fillOpacity: 1,
              interactive: false,
            }).addTo(map);
            userMarker.getElement()?.setAttribute("role", "img");
            userMarker.getElement()?.setAttribute("aria-label", "Your location");
          }
          if (centerOnNextFix) {
            centerOnNextFix = false;
            map.closePopup();
            map.setView(point, 15, { animate: !reducedMotion });
          }
          setLocationStatus("ready");
          setLocationMessage("Your location is shown in blue.");
        }, (error) => {
          if (cancelled || request !== locationRequest) return;
          if (locationWatchId !== undefined) navigator.geolocation.clearWatch(locationWatchId);
          locationWatchId = undefined;
          accuracyCircle?.remove();
          userMarker?.remove();
          accuracyCircle = undefined;
          userMarker = undefined;
          setLocationStatus("error");
          setLocationMessage(error.code === 1
            ? "Location is blocked. Allow it in your browser settings and try again."
            : error.code === 3
              ? "Finding your location took too long. Try again."
              : "Your location is unavailable. Check location services and try again.");
        }, { enableHighAccuracy: true, maximumAge: 30_000, timeout: 20_000 });
      };
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
      mapLocations.forEach((location, index) => {
        const point = JSON.stringify([location.latitude, location.longitude]);
        const group = pointGroups.get(point) ?? [];
        group.push({ location, number: index + 1 });
        pointGroups.set(point, group);
      });

      [...pointGroups.values()].forEach((group, groupIndex) => {
        const { location, number } = group[0];
        const shared = group.length > 1;
        const markerLabel = shared
          ? `${group.length} venues at this location. Show events.`
          : `${location.name}, ${location.events.length} ${location.events.length === 1 ? "event" : "events"}. Show events.`;
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

        const popupContent = document.createElement("div");
        popupContent.id = `${mapInstanceId}-events-${groupIndex}`;
        popupContent.setAttribute("role", "dialog");
        const mobileEvents = document.createElement("div");
        mobileEvents.className = "event-map-mobile-events";
        group.forEach((entry) => {
          entry.location.events.forEach((event) => {
            const time = resolveEventTimePresentation(event);
            const eventRow = document.createElement("article");
            eventRow.className = "event-map-popup-event";
            eventRow.dataset.eventMapPopupEventId = event._id;
            const eventTime = document.createElement("p");
            eventTime.className = "event-map-popup-event-time";
            eventTime.textContent = time.label;
            const eventTitle = document.createElement("p");
            eventTitle.className = "event-map-popup-event-title";
            const session = getEventSessionLabel(event);
            eventTitle.textContent = session ? `${event.title} \u00b7 ${session}` : event.title;
            const eventLink = document.createElement("a");
            eventLink.className = "event-map-popup-event-venue";
            eventLink.href = `/events/${encodeURIComponent(event._id)}`;
            eventLink.textContent = event.venue;
            eventLink.setAttribute("aria-label", `${event.venue}: open ${event.title}, ${time.label}${session ? `, ${session}` : ""}`);
            eventRow.append(eventTime, eventTitle, eventLink);
            if (possibleIds.has(event._id)) {
              const possibleLabel = document.createElement("p");
              possibleLabel.className = "mt-1 rounded-md bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-medium leading-4 text-amber-200";
              possibleLabel.dataset.openNowStatus = "possible";
              possibleLabel.dataset.openNowEventId = event._id;
              possibleLabel.textContent = OPEN_NOW_POSSIBLE_LABEL;
              eventRow.append(possibleLabel);
            }
            mobileEvents.append(eventRow);
          });
        });
        popupContent.append(mobileEvents);
        const popup = L.popup({
          className: "event-map-shared-popup event-map-events-popup",
          minWidth: 210,
          maxWidth: 280,
          offset: [0, -42],
          autoPanPaddingTopLeft: [12, 128],
          autoPanPaddingBottomRight: [12, 24],
          autoClose: true,
          closeOnClick: true,
        }, marker).setContent(popupContent);

        function activateMarker() {
          if (desktopViewport.matches && !shared) {
            onSelectLocation(location.id);
            return;
          }
          if (map.hasLayer(popup)) {
            map.closePopup(popup);
            return;
          }
          popupContent.setAttribute("aria-label", desktopViewport.matches ? "Choose a venue at this location" : "Events at this location");
          marker.closeTooltip();
          popup.setLatLng(marker.getLatLng()).openOn(map);
        }

        marker.on("click", activateMarker);
        if (element) {
          element.setAttribute("role", "button");
          element.setAttribute("aria-label", markerLabel);
          element.addEventListener("keydown", (event) => {
            if (event.key === " " || event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              activateMarker();
            }
          });
        }

        if (shared) {
          const desktopVenues = document.createElement("div");
          desktopVenues.className = "event-map-shared-venues";
          const heading = document.createElement("p");
          heading.className = "event-map-shared-heading";
          heading.textContent = `${group.length} venues at this location`;
          desktopVenues.append(heading);

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
              map.closePopup(popup);
              onSelectLocation(entry.location.id);
            });
            popupButtons.set(entry.location.id, button);
            desktopVenues.append(button);
          });
          popupContent.append(desktopVenues);
        }
        function updatePopupSemantics() {
          if (shared || !desktopViewport.matches) {
            element?.setAttribute("aria-haspopup", "dialog");
            element?.setAttribute("aria-controls", popupContent.id);
            element?.setAttribute("aria-expanded", "false");
          } else {
            element?.removeAttribute("aria-haspopup");
            element?.removeAttribute("aria-controls");
            element?.removeAttribute("aria-expanded");
          }
        }
        updatePopupSemantics();
        desktopViewport.addEventListener("change", updatePopupSemantics);
        viewportMarkerCleanup.push(() => desktopViewport.removeEventListener("change", updatePopupSemantics));
        popupContent.addEventListener("keydown", (event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            map.closePopup(popup);
          }
        });
        marker.on("popupopen", () => {
          element?.setAttribute("aria-expanded", "true");
          if (desktopViewport.matches) {
            const selected = group.find((entry) => popupButtons.get(entry.location.id)?.getAttribute("aria-pressed") === "true");
            popupButtons.get((selected ?? group[0]).location.id)?.focus({ preventScroll: true });
          } else {
            mobileEvents.querySelector<HTMLAnchorElement>("a")?.focus({ preventScroll: true });
          }
        });
        marker.on("popupclose", () => {
          element?.setAttribute("aria-expanded", "false");
          if (!cancelled && (popupContent.contains(document.activeElement) || document.activeElement === document.body)) {
            element?.focus({ preventScroll: true });
          }
        });
        group.forEach((entry) => markers.set(entry.location.id, marker));
      });

      function fitMap() {
        if (mapLocations.length === 0) {
          map.setView(BELGRADE_CENTER, desktopViewport.matches ? 13 : 14);
        } else {
          map.fitBounds(L.latLngBounds(mapLocations.map((location) => [location.latitude, location.longitude])), {
            paddingTopLeft: [64, 112],
            paddingBottomRight: [64, 88],
            maxZoom: 15,
            animate: false,
          });
        }
      }
      fitMapRef.current = fitMap;
      if (desktopViewport.matches) fitMap();
      else map.setView(BELGRADE_CENTER, 14, { animate: false });
      const updateViewport = () => {
        map.closePopup();
        map.invalidateSize({ pan: false });
        if (desktopViewport.matches) fitMap();
        else map.setView(BELGRADE_CENTER, 14, { animate: false });
      };
      desktopViewport.addEventListener("change", updateViewport);
      removeViewportListener = () => {
        desktopViewport.removeEventListener("change", updateViewport);
      };
      resizeObserver = new ResizeObserver(() => map.invalidateSize({ pan: false }));
      resizeObserver.observe(containerRef.current);
      setStatus("ready");
    }

    initializeMap().catch(() => {
      if (!cancelled) setStatus("failed");
    });

    return () => {
      cancelled = true;
      if (locationWatchId !== undefined) navigator.geolocation.clearWatch(locationWatchId);
      locateUserRef.current = null;
      resizeObserver?.disconnect();
      removeViewportListener?.();
      viewportMarkerCleanup.forEach((cleanup) => cleanup());
      markers.clear();
      popupButtons.clear();
      fitMapRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [mapLocations, mapInstanceId, onSelectLocation, possibleIds]);

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
    <div className={cn("event-map-shell relative isolate h-full min-w-0 overflow-hidden rounded-[1.25rem] border border-border lg:h-auto", className)}>
      <div aria-label="Event locations in Belgrade. Use arrow keys to pan and plus or minus to zoom." className="event-location-map h-full w-full lg:h-[620px]" ref={containerRef} />
      {status === "loading" || status === "failed" ? (
        <div className="pointer-events-none absolute inset-0 z-[500] flex items-center justify-center bg-card/90 px-6 text-center">
          <div>
            {status === "loading" ? <LoaderCircle aria-hidden="true" className="mx-auto mb-3 h-6 w-6 animate-spin text-primary" /> : <MapPin aria-hidden="true" className="mx-auto mb-3 h-6 w-6 text-primary" />}
            <p role="status" className="text-sm text-muted-foreground">{status === "loading" ? "Loading Belgrade map..." : "Map unavailable. Please reload to try again."}</p>
          </div>
        </div>
      ) : null}
      <div className="pointer-events-none absolute inset-x-2 top-3 z-[600] flex flex-col items-start gap-2 sm:inset-x-3 md:top-20 lg:top-3">
        <div className="pointer-events-auto flex w-full items-center justify-between gap-1.5 sm:w-auto sm:justify-start sm:gap-2">
          {controls}
          {status === "ready" ? (
            <>
              <button aria-label={locationStatus === "locating" ? "Finding your location" : "Show my location"} aria-busy={locationStatus === "locating"} className="button-secondary h-8 min-h-8 shrink-0 gap-1.5 whitespace-nowrap bg-card/95 px-2 py-0 text-[11px] leading-none shadow-lg disabled:cursor-wait sm:px-2.5" disabled={locationStatus === "locating"} onClick={() => locateUserRef.current?.()} type="button">
                {locationStatus === "locating" ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" /> : <LocateFixed aria-hidden="true" className={cn("size-3.5", locationStatus === "ready" && "text-blue-400")} />}
                {locationStatus === "locating" ? "Locating..." : "My location"}
              </button>
              <button className="button-secondary h-8 min-h-8 shrink-0 gap-1.5 whitespace-nowrap bg-card/95 px-2 py-0 text-[11px] leading-none shadow-lg sm:px-2.5" onClick={() => { mapRef.current?.closePopup(); fitMapRef.current?.(); }} type="button">
                <Expand aria-hidden="true" className="size-3.5" />
                Show all
              </button>
            </>
          ) : null}
        </div>
        {status === "ready" ? (
          <span className="hidden rounded-full border border-border bg-card/95 px-3 py-2 text-xs font-semibold text-foreground shadow-lg lg:inline">
            {mapLocations.length} {mapLocations.length === 1 ? "venue" : "venues"} on the map
          </span>
        ) : null}
      </div>
      <p role="status" aria-live="polite" className={locationStatus === "error" ? "pointer-events-none absolute bottom-28 left-3 right-14 z-[500] rounded-xl border border-border bg-card/95 px-3 py-2 text-xs text-foreground" : "sr-only"}>
        {locationStatus === "locating" ? "Finding your location. Allow location access when your browser asks." : locationMessage}
      </p>
      {tilesUnavailable && status === "ready" ? (
        <p role="status" className="pointer-events-none absolute bottom-14 left-3 right-14 z-[500] rounded-xl border border-border bg-card/95 px-3 py-2 text-xs text-muted-foreground">
          The street map could not load. Venue pins and event details are still available.
        </p>
      ) : null}
      {mapLocations.length === 0 && status === "ready" && !tilesUnavailable ? (
        <p className="pointer-events-none absolute bottom-14 left-3 z-[500] max-w-[75%] rounded-xl border border-border bg-card/95 px-3 py-2 text-xs text-muted-foreground">
          No mapped locations for this day.
        </p>
      ) : null}
    </div>
  );
}
