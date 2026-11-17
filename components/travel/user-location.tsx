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
const permissionPreferenceKey = "eventzeka.location-permission.v1";

function rememberPermission(value: "granted" | "denied") {
  try { localStorage.setItem(permissionPreferenceKey, value); } catch { /* GPS also works without storage. */ }
}

function rememberedPermission() {
  try { return localStorage.getItem(permissionPreferenceKey); } catch { return null; }
}

/** Coordinates stay in memory; storage contains only the permission preference. */
export function UserLocationProvider({ children }: { children: ReactNode }) {
  const locale = useLocale();
  const currentLocale = useRef(locale);
  currentLocale.current = locale;
  const [state, setState] = useState<LocationState>(initialState);
  const watch = useRef<number | null>(null);
  const request = useRef(0);
  const resume = useRef(false);
  const stop = useCallback(() => {
    if (watch.current !== null) navigator.geolocation?.clearWatch(watch.current);
    watch.current = null;
  }, []);
  const requestLocation = useCallback(() => {
    stop();
    const id = ++request.current;
    resume.current = true;
    if (!navigator.geolocation || !window.isSecureContext) {
      resume.current = false;
      setState({ position: null, status: "error", error: travelText(currentLocale.current, "unavailable") });
      return;
    }
    if (document.hidden) return;
    setState({ position: null, status: "loading", error: null });
    let grantRecorded = false;
    watch.current = navigator.geolocation.watchPosition((fix) => {
      if (id !== request.current || !isCoordinates(fix.coords)) return;
      if (!grantRecorded) { rememberPermission("granted"); grantRecorded = true; }
      setState({
        position: { latitude: fix.coords.latitude, longitude: fix.coords.longitude, accuracy: fix.coords.accuracy, timestamp: fix.timestamp },
        status: "ready", error: null,
      });
    }, (error) => {
      if (id !== request.current) return;
      stop();
      if (error.code === 1) { resume.current = false; rememberPermission("denied"); }
      setState({ position: null, status: "error", error: travelText(currentLocale.current, error.code === 1 ? "denied" : error.code === 3 ? "timeout" : "unavailable") });
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 10_000 });
  }, [stop]);
  useEffect(() => {
    let disposed = false;
    let permission: PermissionStatus | undefined;
    const initialRequest = request.current;
    function invalidate() { request.current++; stop(); }
    function blocked() {
      resume.current = false;
      invalidate();
      rememberPermission("denied");
      setState({ position: null, status: "error", error: travelText(currentLocale.current, "denied") });
    }
    function permissionChanged() {
      if (disposed || !permission) return;
      if (permission.state === "denied") blocked();
      else if (permission.state === "granted") {
        rememberPermission("granted");
        resume.current = true;
        if (!document.hidden && watch.current === null) requestLocation();
      } else { resume.current = false; invalidate(); setState(initialState); }
    }
    async function start() {
      try { permission = await navigator.permissions?.query({ name: "geolocation" }); } catch { /* Safari may omit the permission query. */ }
      if (disposed) return;
      permission?.addEventListener("change", permissionChanged);
      if (permission?.state === "denied") { blocked(); return; }
      // A browser grant is authoritative if the user changed settings since last visit.
      if (permission?.state !== "granted" && rememberedPermission() === "denied") { blocked(); return; }
      if (initialRequest === request.current) requestLocation();
    }
    void start();
    function visibilityChanged() {
      if (document.hidden) {
        invalidate();
        setState(initialState);
      } else if (resume.current && watch.current === null) requestLocation();
    }
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      disposed = true;
      invalidate();
      permission?.removeEventListener("change", permissionChanged);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [requestLocation, stop]);
  return <LocationContext.Provider value={{ ...state, requestLocation }}>{children}</LocationContext.Provider>;
}

export function useUserLocation() { return useContext(LocationContext); }
