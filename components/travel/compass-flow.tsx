"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, CarFront, Check, Compass, Footprints, LocateFixed, MapPin, Music2, Route, Shuffle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocale } from "@/i18n/client";
import { localizeHref } from "@/i18n/config";
import { MUSIC_GENRES } from "@/lib/taxonomy/event-discovery";
import { compassCandidates, type CompassPlace } from "@/lib/travel/compass";
import { travelText } from "@/lib/travel/copy";
import { bearingDegrees, estimateTravel, haversineMeters, type Coordinates } from "@/lib/travel/location";
import { useUserLocation } from "./user-location";
import { YandexTaxiButton } from "./yandex-taxi-button";
import styles from "./compass-flow.module.css";

const RouteMap = dynamic(() => import("./route-map").then((module) => module.RouteMap), { ssr: false });
type StreetRoute = { distance: number; coordinates: [number, number][]; origin: Coordinates; mode: "foot" | "car" };
type Orientation = DeviceOrientationEvent & { webkitCompassHeading?: number; webkitCompassAccuracy?: number };

export function CompassFlow({ places, initialNow, loadFailed }: { places: CompassPlace[]; initialNow: number; loadFailed: boolean }) {
  const locale = useLocale();
  const t = (key: Parameters<typeof travelText>[1]) => travelText(locale, key);
  const router = useRouter();
  const { position, status, error, requestLocation } = useUserLocation();
  const [now, setNow] = useState(initialNow);
  const [phase, setPhase] = useState<"confirm" | "vibe" | "results">("confirm");
  const [rejectedIds, setRejectedIds] = useState<string[]>([]);
  const [source, setSource] = useState<CompassPlace | null>(null);
  const [vibe, setVibe] = useState<"same" | "different" | "nearby">("same");
  const [mounted, setMounted] = useState(false);
  const [index, setIndex] = useState(0);
  const [route, setRoute] = useState<StreetRoute | null>(null);
  const [routeStatus, setRouteStatus] = useState<"idle" | "loading" | "error">("idle");
  const routeRequest = useRef<AbortController | null>(null);
  const [heading, setHeading] = useState<number | null>(null);
  const [orientationMessage, setOrientationMessage] = useState(false);
  const orientationCleanup = useRef<(() => void) | null>(null);
  const [paused, setPaused] = useState(false);
  const [nudged, setNudged] = useState(false);
  const nudgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setMounted(true);
    const timer = setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 30_000);
    const visibility = () => setPaused(document.hidden);
    document.addEventListener("visibilitychange", visibility);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", visibility); orientationCleanup.current?.(); if (nudgeTimer.current) clearTimeout(nudgeTimer.current); };
  }, []);
  const nearest = useMemo(() => position ? places.map((place, order) => ({ place, order, meters: haversineMeters(position, place) }))
    .sort((a, b) => a.meters - b.meters || a.order - b.order).map(({ place }) => place) : [], [places, position]);
  const confirmation = nearest.find((place) => !rejectedIds.includes(place.id));
  const candidates = useMemo(() => source && position ? compassCandidates(places, source, position, vibe, now) : [], [places, source, position, vibe, now]);
  useEffect(() => { setIndex((current) => Math.min(current, Math.max(0, candidates.length - 1))); }, [candidates.length]);
  const destination = candidates[Math.min(index, Math.max(0, candidates.length - 1))];
  const destinationId = destination?.id;
  useEffect(() => { routeRequest.current?.abort(); setRoute(null); setRouteStatus("idle"); return () => routeRequest.current?.abort(); }, [destinationId, vibe]);
  useEffect(() => {
    if (route && (!position || haversineMeters(route.origin, position) > 50)) {
      setRoute(null);
      setRouteStatus("idle");
    }
  }, [position, route]);
  const estimate = position && destination ? estimateTravel(position, destination) : null;
  const carPreferred = (estimate?.walkMinutes ?? 0) > 10;
  const mode = carPreferred ? "car" : "foot";
  const bearing = position && destination ? bearingDegrees(position, destination) : 0;
  // Keep the angular delta short across north, rather than spinning 359 degrees.
  const angle = useRef(0);
  const targetAngle = bearing - (heading ?? 0);
  const delta = ((targetAngle - angle.current + 540) % 360 + 360) % 360 - 180;
  const displayedAngle = angle.current + delta;
  useEffect(() => { angle.current = displayedAngle; }, [displayedAngle]);
  function chooseVibe(next: "same" | "different" | "nearby") { setVibe(next); setIndex(0); setPhase("results"); }
  function reset() { setPhase("confirm"); setSource(null); setRejectedIds([]); setIndex(0); setRoute(null); }
  function nudge() { setNudged(false); requestAnimationFrame(() => setNudged(true)); if (nudgeTimer.current) clearTimeout(nudgeTimer.current); nudgeTimer.current = setTimeout(() => setNudged(false), 800); }
  async function enableCompass() {
    const OrientationEvent = window.DeviceOrientationEvent as typeof DeviceOrientationEvent & { requestPermission?: () => Promise<string> };
    if (!OrientationEvent) { setOrientationMessage(true); return; }
    try {
      if (OrientationEvent.requestPermission && await OrientationEvent.requestPermission() !== "granted") { setOrientationMessage(true); return; }
      orientationCleanup.current?.();
      const listener = (event: DeviceOrientationEvent) => {
        const reading = event as Orientation;
        if (typeof reading.webkitCompassHeading === "number" && (reading.webkitCompassAccuracy ?? 0) >= 0) setHeading(reading.webkitCompassHeading);
        else if (event.absolute && event.alpha !== null) setHeading((360 - event.alpha) % 360);
      };
      window.addEventListener("deviceorientationabsolute", listener);
      window.addEventListener("deviceorientation", listener);
      orientationCleanup.current = () => { window.removeEventListener("deviceorientationabsolute", listener); window.removeEventListener("deviceorientation", listener); };
      setOrientationMessage(true);
    } catch { setOrientationMessage(true); }
  }
  async function showRoute() {
    if (!position || !destination) return;
    routeRequest.current?.abort();
    const controller = new AbortController(); routeRequest.current = controller;
    setRouteStatus("loading");
    try {
      const response = await fetch("/api/travel/route", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ origin: { latitude: position.latitude, longitude: position.longitude }, destination: { latitude: destination.latitude, longitude: destination.longitude }, mode }), signal: controller.signal });
      const result = await response.json();
      if (!response.ok || !Array.isArray(result.coordinates) || !Number.isFinite(result.distance)) throw new Error("route");
      if (controller.signal.aborted) return;
      setRoute({ distance: result.distance, coordinates: result.coordinates, origin: position, mode }); setRouteStatus("idle");
    } catch { if (!controller.signal.aborted) setRouteStatus("error"); }
  }
  return <main className={styles.page}>
    <h1 className={styles.heading}>{t("next")}</h1>
    {!position ? <section className={styles.step}>
      <LocateFixed size={40} className="text-primary" aria-hidden="true" />
      <p className={styles.intro}>{t("locationIntro")}</p>
      <button className={styles.primary} type="button" disabled={!mounted || status === "loading"} onClick={requestLocation}><LocateFixed size={18} />{t(status === "loading" ? "locating" : "locate")}</button>
      {error ? <p role="status" className={styles.error}>{error}</p> : null}
    </section> : phase === "confirm" ? <section className={styles.step} key="confirm">
      <h2 className={styles.title}>{t("here")}</h2>
      <p className={styles.muted}>{t("nearest")}</p>
      {confirmation ? <>
        <div className={styles.place} key={confirmation.id}><MapPin size={22} className="mb-4 text-primary" /><h3 className={styles.name}>{confirmation.name}</h3><p className={styles.address}>{confirmation.address}</p>
          <p className={`${styles.muted} mt-4`}>≈ {estimateTravel(position, confirmation).walkMinutes} min {t("walk")}</p></div>
        <div className={styles.actions}><button type="button" className={styles.secondary} onClick={() => setRejectedIds((ids) => [...ids, confirmation.id])}>{t("no")}</button><button type="button" className={styles.primary} onClick={() => { setSource(confirmation); setPhase("vibe"); }}><Check size={18} />{t("yes")}</button></div>
      </> : <><p className={styles.intro}>{t(places.length ? "end" : "noPlaces")}</p><button type="button" className={styles.secondary} onClick={() => { setRejectedIds([]); router.refresh(); }}>{t("refresh")}</button></>}
    </section> : phase === "vibe" ? <section className={styles.step} key="vibe">
      <p className={styles.muted}>{source?.name}</p><h2 className={styles.title}>{t("vibe")}</h2>
      <button type="button" className={styles.choice} onClick={() => chooseVibe("same")}><Music2 size={27} /><span><strong>{t("same")}</strong><small>{t("sameHint")}</small></span></button>
      <button type="button" className={styles.choice} onClick={() => chooseVibe("different")}><Shuffle size={27} /><span><strong>{t("different")}</strong><small>{t("differentHint")}</small></span></button>
      {!source?.event ? <><p className={`${styles.muted} mt-5`}>{t("unknownVibe")}</p><button type="button" className={styles.textButton} onClick={() => chooseVibe("nearby")}>{t("nearby")}<ArrowRight size={14} /></button></> : !source.event.taxonomy.genres.length ? <p className={`${styles.muted} mt-5`}>{t("musicUnknown")}</p> : null}
      <button type="button" className={styles.textButton} onClick={reset}><ArrowLeft size={14} />{t("reset")}</button>
    </section> : <section className={styles.step} key="results">
      <div className={styles.footer}><span className={styles.muted}>{t(vibe)} · {t("nearest")}</span><button type="button" className={styles.textButton} onClick={() => setPhase("vibe")}>{t("change")}</button></div>
      {destination && estimate ? <>
        <div className={styles.resultTitle} key={destination.id}>
          <h2 className={styles.name}>{destination.name}</h2><p className={styles.address}>{destination.address}</p>
          <p className={styles.open}>{t("open")}{destination.hoursLabel ? ` · ${t("until")} ${destination.hoursLabel}` : ""}</p>
          <p className={styles.muted}>{destination.event?.title}</p>
          {destination.event?.taxonomy.genres.length ? <p className={styles.muted}>{destination.event.taxonomy.genres.map((key) => MUSIC_GENRES.find((genre) => genre.key === key)?.label).join(" · ")}</p> : null}
        </div>
        <div className={`${styles.compass} ${paused ? styles.paused : ""}`}>
          <span className={styles.north}>N</span><button className={styles.needleButton} type="button" onClick={nudge} aria-label={t("north")}>
            <svg className={styles.bearing} style={{ transform: `rotate(${displayedAngle}deg)` }} viewBox="0 0 85 104" aria-hidden="true"><g className={nudged ? styles.needleNudge : styles.needle}><path d="M42.5 5 72 88 42.5 73 13 88Z" fill="#D5F56B" /><path d="M42.5 5V73L13 88Z" fill="#C0DB69" /></g></svg>
          </button>
        </div>
        <div className={styles.bearingLabel}><button className={styles.textButton} type="button" onClick={enableCompass}><Compass size={14} />{t(heading === null ? "compass" : "compassOn")}</button></div>
        {orientationMessage && heading === null ? <p className={`${styles.muted} text-center`}>{t("compassUnavailable")}</p> : null}
        <div className={styles.eta}><span className={!carPreferred ? styles.preferred : ""}><Footprints size={18} />≈ {route?.mode === "foot" ? Math.max(1, Math.ceil(route.distance / 75)) : estimate.walkMinutes} min {t("walk")}</span><span className={carPreferred ? styles.preferred : ""}><CarFront size={18} />≈ {route?.mode === "car" ? Math.max(1, Math.ceil(route.distance / (20_000 / 60))) : estimate.driveMinutes} min {t("drive")}</span></div>
        <p className={`${styles.muted} text-center`}>{t("estimate")}</p>
        <div className={styles.actions}><button className={styles.primary} type="button" disabled={routeStatus === "loading"} onClick={showRoute}><Route size={18} />{t(routeStatus === "loading" ? "routeLoading" : "route")}</button><YandexTaxiButton latitude={destination.latitude} longitude={destination.longitude} venueName={destination.name} /></div>
        {route ? <div className={styles.route}><RouteMap origin={route.origin} destination={destination} coordinates={route.coordinates} /></div> : null}
        {routeStatus === "error" ? <p className={styles.error} role="status">{t("routeError")}</p> : null}
        {route || routeStatus === "error" ? <a className={styles.textButton} href={`https://www.google.com/maps/dir/?api=1&origin=${position.latitude},${position.longitude}&destination=${destination.latitude},${destination.longitude}&travelmode=${carPreferred ? "driving" : "walking"}`} target="_blank" rel="noopener noreferrer">{t("navigation")}<ArrowRight size={14} /></a> : null}
        <div className={styles.actions}><button type="button" className={styles.secondary} disabled={index === 0} onClick={() => setIndex((value) => value - 1)} aria-label={t("previous")}><ArrowLeft size={18} /></button><button type="button" className={styles.secondary} disabled={index >= candidates.length - 1} onClick={() => setIndex((value) => value + 1)}>{t("nextPlace")}<ArrowRight size={18} /></button><span className={`${styles.muted} self-center ml-auto`}>{Math.min(index + 1, candidates.length)} / {candidates.length}</span></div>
        {destination.event ? <Link href={localizeHref(`/events/${destination.event.id}`, locale)} className={styles.textButton}>{t("details")}</Link> : null}
      </> : <><h2 className={styles.title}>{t("empty")}</h2><p className={styles.intro}>{t("emptyHint")}</p><button className={styles.secondary} type="button" onClick={() => { setNow(Date.now()); router.refresh(); }}>{t("refresh")}</button>{vibe !== "nearby" ? <div><button type="button" className={styles.textButton} onClick={() => chooseVibe("nearby")}>{t("nearby")}<ArrowRight size={14} /></button></div> : null}</>}
      <div><button type="button" className={styles.textButton} onClick={reset}>{t("reset")}</button></div>
    </section>}
    {loadFailed ? <p role="status" className={styles.error}>{t("loadError")}</p> : null}
  </main>;
}
