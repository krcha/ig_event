"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocale } from "@/i18n/client";
import { travelText } from "@/lib/travel/copy";
import { isCoordinates, type Coordinates } from "@/lib/travel/location";

type Position = Coordinates & { accuracy: number; timestamp: number };
type LocationState = {
  position: Position | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
};
const initialState: LocationState = { position: null, status: "idle", error: null };
const LocationContext = createContext<LocationState & { requestLocation: () => void }>({ ...initialState, requestLocation() {} });

/** Memory only: no coordinates in storage, analytics or query strings. */
export function UserLocationProvider({ children }: { children: ReactNode }) {
  const locale = useLocale();
  const [state, setState] = useState<LocationState>(initialState);
  const watch = useRef<number | null>(null);
  const request = useRef(0);
  const stop = useCallback(() => {
    if (watch.current !== null) navigator.geolocation?.clearWatch(watch.current);
    watch.current = null;
  }, []);
  useEffect(() => () => { request.current++; stop(); }, [stop]);
  // Backgrounding invalidates a fix; a new request always uses a fresh GPS fix.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) { request.current++; stop(); setState(initialState); }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [stop]);
  const requestLocation = useCallback(() => {
    stop();
    const id = ++request.current;
    if (!navigator.geolocation || !window.isSecureContext) {
      setState({ position: null, status: "error", error: travelText(locale, "unavailable") });
      return;
    }
    setState({ position: null, status: "loading", error: null });
    watch.current = navigator.geolocation.watchPosition((fix) => {
      if (id !== request.current || !isCoordinates(fix.coords)) return;
      setState({
        position: { latitude: fix.coords.latitude, longitude: fix.coords.longitude, accuracy: fix.coords.accuracy, timestamp: fix.timestamp },
        status: "ready", error: null,
      });
    }, (error) => {
      if (id !== request.current) return;
      stop();
      setState({ position: null, status: "error", error: travelText(locale, error.code === 1 ? "denied" : error.code === 3 ? "timeout" : "unavailable") });
    }, { enableHighAccuracy: true, maximumAge: 15_000, timeout: 10_000 });
  }, [locale, stop]);
  return <LocationContext.Provider value={{ ...state, requestLocation }}>{children}</LocationContext.Provider>;
}

export function useUserLocation() { return useContext(LocationContext); }
