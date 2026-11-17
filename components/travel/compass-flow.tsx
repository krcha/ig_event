"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, CarFront, Check, Compass, Footprints, LoaderCircle, LocateFixed, MapPin, Music2, Route, Shuffle, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocale } from "@/i18n/client";
import { localizeHref } from "@/i18n/config";
import { MUSIC_GENRES } from "@/lib/taxonomy/event-discovery";
import { compassCandidates, getCompassGenres, getCompassMusicBasis, type CompassMusicProfile, type CompassPlace } from "@/lib/travel/compass";
import { travelText } from "@/lib/travel/copy";
import { bearingDegrees, estimateTravel, haversineMeters, type Coordinates } from "@/lib/travel/location";
import { useUserLocation } from "./user-location";
import { YandexTaxiButton } from "./yandex-taxi-button";
import styles from "./compass-flow.module.css";

const RouteMap = dynamic(() => import("./route-map").then((module) => module.RouteMap), { ssr: false });
type StreetRoute = { distance: number; coordinates: [number, number][]; origin: Coordinates; mode: "foot" | "car" };
type Orientation = DeviceOrientationEvent & { webkitCompassHeading?: number; webkitCompassAccuracy?: number };
type SourceMusicContext = { musicProfile: CompassMusicProfile; event?: CompassPlace["event"] };
const musicGenreKeys = new Set<string>(MUSIC_GENRES.map(genre => genre.key));

function readSourceMusicContext(value: unknown): SourceMusicContext {
  if (!value || typeof value !== "object") throw new Error("Invalid music context");
  const context = value as SourceMusicContext;
  const profile = context.musicProfile;
  if (!profile || !Array.isArray(profile.genres) || !profile.genres.every(genre => musicGenreKeys.has(genre)) ||
    !["programme", "recent"].includes(profile.basis) || !["announcement", "research", "estimate", "unknown"].includes(profile.evidence) ||
    !Number.isInteger(profile.eventCount) || profile.eventCount < 0) throw new Error("Invalid music context");
  const event = context.event;
  if (event != null && (typeof event.id !== "string" || typeof event.title !== "string" || typeof event.date !== "string" ||
    !event.taxonomy || !Array.isArray(event.taxonomy.categories) || !event.taxonomy.categories.every(category => typeof category === "string") ||
    !Array.isArray(event.taxonomy.genres) || !event.taxonomy.genres.every(genre => musicGenreKeys.has(genre)))) throw new Error("Invalid programme context");
  return { musicProfile: profile, ...(event ? { event } : {}) };
}

export function CompassFlow({ places, initialNow, loadFailed }: { places: CompassPlace[]; initialNow: number; loadFailed: boolean }) {
  const locale = useLocale();
  const t = (key: Parameters<typeof travelText>[1]) => travelText(locale, key);
  const router = useRouter();
  const { position, status, error, requestLocation } = useUserLocation();
  const [now, setNow] = useState(initialNow);
  const [phase, setPhase] = useState<"confirm" | "vibe" | "results">("confirm");
  const [rejectedIds, setRejectedIds] = useState<string[]>([]);
  const [source, setSource] = useState<CompassPlace | null>(null);
  const [sourceLookup, setSourceLookup] = useState<{ venueId: string | null; status: "loading" | "ready" | "error" }>({ venueId: null, status: "ready" });
  const [sourceLookupAttempt, setSourceLookupAttempt] = useState(0);
  const [vibe, setVibe] = useState<"same" | "different" | "nearby">("same");
  const [mounted, setMounted] = useState(false);
  const [index, setIndex] = useState(0);
  const [route, setRoute] = useState<StreetRoute | null>(null);
  const [routeVisible, setRouteVisible] = useState(false);
  const [routeStatus, setRouteStatus] = useState<"idle" | "loading" | "error">("idle");
  const routeRequest = useRef<AbortController | null>(null);
  const routeButton = useRef<HTMLButtonElement>(null);
  const [heading, setHeading] = useState<number | null>(null);
  const [orientationMessage, setOrientationMessage] = useState(false);
  const orientationUnavailable = orientationMessage && heading === null;
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
  const sourceGenres = source ? getCompassGenres(source) : [];
  const sourceVenueId = source?.id;
  const sourceHasGenres = sourceGenres.length > 0;
  const sourceLookupLoading = Boolean(source && !sourceHasGenres && (sourceLookup.venueId !== source.id || sourceLookup.status === "loading"));
  const sourceLookupFailed = Boolean(source && !sourceHasGenres && sourceLookup.venueId === source.id && sourceLookup.status === "error");
  useEffect(() => {
    if (!sourceVenueId || sourceHasGenres) return;
    const controller = new AbortController();
    let cancelled = false;
    let timedOut = false;
    setSourceLookup({ venueId: sourceVenueId, status: "loading" });
    const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, 8_000);
    void fetch(`/api/travel/music-profile/${encodeURIComponent(sourceVenueId)}`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error("Music context unavailable");
        const context = readSourceMusicContext(await response.json());
        if (cancelled || controller.signal.aborted) return;
        setSource(current => current?.id === sourceVenueId ? { ...current, musicProfile: context.musicProfile, ...(context.event ? { event: context.event } : {}) } : current);
        setSourceLookup({ venueId: sourceVenueId, status: "ready" });
      }).catch(() => {
        if (!cancelled && (!controller.signal.aborted || timedOut)) setSourceLookup({ venueId: sourceVenueId, status: "error" });
      }).finally(() => clearTimeout(deadline));
    return () => { cancelled = true; clearTimeout(deadline); controller.abort(); };
  }, [sourceVenueId, sourceHasGenres, sourceLookupAttempt]);
  const destinationGenres = destination ? getCompassGenres(destination) : [];
  const sourceHasCategory = source?.event?.taxonomy.categories.some(category => category !== "other") ?? false;
  const genreLabel = (genres: ReturnType<typeof getCompassGenres>) => genres.map(key => MUSIC_GENRES.find(genre => genre.key === key)?.label).join(" · ");
  const musicBasisLabel = (place: CompassPlace) => t(getCompassMusicBasis(place) === "recent" ? "musicRecent"
    : place.musicProfile?.evidence === "estimate" ? "musicEstimated"
      : place.musicProfile?.evidence === "research" ? "musicResearch" : "musicProgramme");
  const destinationId = destination?.id;
  useEffect(() => { routeRequest.current?.abort(); setRoute(null); setRouteVisible(false); setRouteStatus("idle"); return () => routeRequest.current?.abort(); }, [destinationId, vibe]);
  useEffect(() => {
    if (route && (!position || haversineMeters(route.origin, position) > 50)) {
      setRoute(null);
      setRouteVisible(false);
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
  function chooseVibe(next: "same" | "different" | "nearby") { routeRequest.current?.abort(); setRouteStatus("idle"); setRouteVisible(false); setVibe(next); setIndex(0); setPhase("results"); }
  function reset() { routeRequest.current?.abort(); setRouteStatus("idle"); setPhase("confirm"); setSource(null); setRejectedIds([]); setIndex(0); setRoute(null); setRouteVisible(false); }
  function hideRoute() { setRouteVisible(false); requestAnimationFrame(() => routeButton.current?.focus({ preventScroll: true })); }
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
    if (route && route.mode === mode && haversineMeters(route.origin, position) <= 50) { setRouteVisible(true); return; }
    routeRequest.current?.abort();
    const controller = new AbortController(); routeRequest.current = controller;
    setRouteStatus("loading");
    try {
      const response = await fetch("/api/travel/route", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ origin: { latitude: position.latitude, longitude: position.longitude }, destination: { latitude: destination.latitude, longitude: destination.longitude }, mode }), signal: controller.signal });
      const result = await response.json();
      if (!response.ok || !Array.isArray(result.coordinates) || !Number.isFinite(result.distance)) throw new Error("route");
      if (controller.signal.aborted) return;
      setRoute({ distance: result.distance, coordinates: result.coordinates, origin: position, mode }); setRouteVisible(true); setRouteStatus("idle");
    } catch { if (!controller.signal.aborted) setRouteStatus("error"); }
  }
  return <main className={styles.page} data-compass-phase={!position ? "locate" : phase}>
    <div className={styles.headingRow}>
      <h1 className={styles.heading}>{t("next")}</h1>
      {position && phase !== "confirm" ? <button className={styles.resetButton} type="button" onClick={reset} aria-label={t("reset")} title={t("reset")}><LocateFixed size={18} aria-hidden="true" /></button> : null}
    </div>
    {!position ? <section className={styles.step}>
      <LocateFixed size={40} className="text-primary" aria-hidden="true" />
      <p className={styles.intro}>{t("locationIntro")}</p>
      <button className={styles.primary} type="button" disabled={!mounted || status === "loading"} onClick={requestLocation}><LocateFixed size={18} />{t(status === "loading" ? "locating" : "locate")}</button>
      {error ? <p role="status" className={styles.error}>{error}</p> : null}
    </section> : phase === "confirm" ? <section className={`${styles.step} ${styles.confirm}`} key="confirm">
      <h2 className={styles.title}>{t("here")}</h2>
      <p className={styles.muted}>{t("nearest")}</p>
      {confirmation ? <>
        <div className={styles.place} key={confirmation.id}><MapPin size={24} className="text-primary" aria-hidden="true" /><h3 className={styles.name}>{confirmation.name}</h3><p className={styles.address}>{confirmation.address}</p>
          <p className={styles.muted}>≈ {estimateTravel(position, confirmation).walkMinutes} min {t("walk")}</p></div>
        <div className={styles.actions}><button type="button" className={styles.secondary} onClick={() => setRejectedIds((ids) => [...ids, confirmation.id])}>{t("no")}</button><button type="button" className={styles.primary} onClick={() => { setSource(confirmation); setPhase("vibe"); }}><Check size={18} />{t("yes")}</button></div>
      </> : <><p className={styles.intro}>{t(places.length ? "end" : "noPlaces")}</p><button type="button" className={styles.secondary} onClick={() => { setRejectedIds([]); router.refresh(); }}>{t("refresh")}</button></>}
    </section> : phase === "vibe" ? <section className={`${styles.step} ${styles.vibe}`} key="vibe">
      <p className={styles.muted}>{source?.name}</p>
      {source && sourceGenres.length ? <p className={`${styles.muted} ${styles.musicSummary}`}>{genreLabel(sourceGenres)}<span className={styles.musicBasis}>{musicBasisLabel(source)}</span></p> : null}
      <h2 className={styles.title}>{t("vibe")}</h2>
      {sourceLookupLoading ? <p className={styles.lookupStatus} role="status"><LoaderCircle size={14} className="motion-safe:animate-spin" aria-hidden="true" /><span>{t("musicLookup")}</span></p> : null}
      <button type="button" className={styles.choice} disabled={sourceLookupLoading} onClick={() => chooseVibe("same")}><Music2 size={27} /><span><strong>{t("same")}</strong><small>{t("sameHint")}</small></span></button>
      <button type="button" className={styles.choice} disabled={sourceLookupLoading} onClick={() => chooseVibe("different")}><Shuffle size={27} /><span><strong>{t("different")}</strong><small>{t("differentHint")}</small></span></button>
      {sourceLookupFailed ? <>
        <p className={`${styles.muted} ${styles.vibeNote}`} role="status">{t("musicLookupFailed")}</p>
        <div className={styles.lookupActions}><button type="button" className={styles.textButton} onClick={() => setSourceLookupAttempt(attempt => attempt + 1)}>{t("refresh")}</button><button type="button" className={styles.textButton} onClick={() => chooseVibe("nearby")}>{t("nearby")}<ArrowRight size={14} /></button></div>
      </> : sourceLookupLoading ? <button type="button" className={styles.textButton} onClick={() => chooseVibe("nearby")}>{t("nearby")}<ArrowRight size={14} /></button>
        : !sourceGenres.length && !sourceHasCategory ? <><p className={`${styles.muted} ${styles.vibeNote}`}>{t("unknownVibe")}</p><button type="button" className={styles.textButton} onClick={() => chooseVibe("nearby")}>{t("nearby")}<ArrowRight size={14} /></button></>
          : !sourceGenres.length ? <p className={`${styles.muted} ${styles.vibeNote}`}>{t("musicUnknown")}</p> : null}
    </section> : <section className={`${styles.step} ${styles.results}`} key="results">
      <div className={styles.footer}><span className={styles.modeLabel}><span>{t(vibe)}</span><small>{t("nearest")}</small></span><button type="button" className={styles.textButton} onClick={() => setPhase("vibe")}>{t("change")}</button></div>
      {destination && estimate ? <>
        <div className={styles.resultTitle} key={destination.id}>
          <h2 className={styles.name}>{destination.name}</h2><p className={styles.address}>{destination.address}</p>
          <p className={styles.open}>{t("open")}{destination.hoursLabel ? ` · ${t("until")} ${destination.hoursLabel}` : ""}</p>
          {destination.event ? <Link href={localizeHref(`/events/${destination.event.id}`, locale)} className={styles.eventLink} title={t("details")}>{destination.event.title}<ArrowRight size={13} aria-hidden="true" /></Link> : null}
          {destinationGenres.length ? <p className={`${styles.muted} ${styles.genreLabel}`}>{genreLabel(destinationGenres)}<span className={styles.musicBasis}>{musicBasisLabel(destination)}</span></p> : null}
        </div>
        <div className={styles.directionArea} data-compass-direction="true" data-compass-status={orientationUnavailable || routeStatus === "error" ? "true" : undefined} id="where-next-direction">
          {routeVisible && route ? <div className={styles.route}>
            <RouteMap origin={route.origin} destination={destination} coordinates={route.coordinates} />
            <button className={styles.closeRoute} type="button" onClick={hideRoute} aria-label={t("backToCompass")} title={t("backToCompass")}><X size={17} aria-hidden="true" /></button>
            <a className={styles.mapNavigation} href={`https://www.google.com/maps/dir/?api=1&origin=${position.latitude},${position.longitude}&destination=${destination.latitude},${destination.longitude}&travelmode=${carPreferred ? "driving" : "walking"}`} target="_blank" rel="noopener noreferrer">{t("navigation")}<ArrowRight size={14} aria-hidden="true" /></a>
          </div> : <>
            <div className={`${styles.compass} ${paused ? styles.paused : ""}`}>
              <span className={styles.north}>N</span><button className={styles.needleButton} type="button" onClick={orientationUnavailable ? enableCompass : nudge} aria-label={t(orientationUnavailable ? "compass" : "north")}>
                <svg className={styles.bearing} style={{ transform: `rotate(${displayedAngle}deg)` }} viewBox="0 0 85 104" aria-hidden="true"><g className={nudged ? styles.needleNudge : styles.needle}><path d="M42.5 5 72 88 42.5 73 13 88Z" fill="#D5F56B" /><path d="M42.5 5V73L13 88Z" fill="#C0DB69" /></g></svg>
              </button>
            </div>
            <div className={styles.bearingLabel}>
              {!orientationUnavailable ? <button className={styles.textButton} type="button" onClick={enableCompass}><Compass size={15} aria-hidden="true" />{t(heading === null ? "compass" : "compassOn")}</button> : null}
              {orientationUnavailable ? <p className={`${styles.muted} ${styles.orientationStatus}`} role="status">{t("compassUnavailable")}</p> : null}
              {routeStatus === "error" ? <p className={styles.routeError} role="status"><a className={styles.routeErrorLink} href={`https://www.google.com/maps/dir/?api=1&origin=${position.latitude},${position.longitude}&destination=${destination.latitude},${destination.longitude}&travelmode=${carPreferred ? "driving" : "walking"}`} target="_blank" rel="noopener noreferrer">{t("routeError")}<ArrowRight size={13} aria-hidden="true" /></a></p> : null}
            </div>
          </>}
        </div>
        <div className={styles.travelInfo}>
          <div className={styles.eta}><span className={!carPreferred ? styles.preferred : ""}><Footprints size={16} aria-hidden="true" />≈ {route?.mode === "foot" ? Math.max(1, Math.ceil(route.distance / 75)) : estimate.walkMinutes} min {t("walk")}</span><span className={carPreferred ? styles.preferred : ""}><CarFront size={16} aria-hidden="true" />≈ {route?.mode === "car" ? Math.max(1, Math.ceil(route.distance / (20_000 / 60))) : estimate.driveMinutes} min {t("drive")}</span></div>
          <p className={styles.estimate}>{t("estimate")}</p>
        </div>
        <div className={`${styles.actions} ${styles.routeActions}`}><button className={styles.primary} type="button" disabled={routeStatus === "loading"} onClick={showRoute} ref={routeButton} aria-controls="where-next-direction" aria-expanded={routeVisible}><Route size={17} aria-hidden="true" />{t(routeStatus === "loading" ? "routeLoading" : "route")}</button><YandexTaxiButton latitude={destination.latitude} longitude={destination.longitude} venueName={destination.name} /></div>
        <div className={styles.pagination}><button type="button" className={styles.secondary} disabled={index === 0} onClick={() => setIndex((value) => value - 1)} aria-label={t("previous")}><ArrowLeft size={17} aria-hidden="true" /></button><button type="button" className={styles.secondary} disabled={index >= candidates.length - 1} onClick={() => setIndex((value) => value + 1)}>{t("nextPlace")}<ArrowRight size={17} aria-hidden="true" /></button><span className={styles.muted}>{Math.min(index + 1, candidates.length)} / {candidates.length}</span></div>
      </> : <><h2 className={styles.title}>{t("empty")}</h2><p className={styles.intro}>{t("emptyHint")}</p><button className={styles.secondary} type="button" onClick={() => { setNow(Date.now()); router.refresh(); }}>{t("refresh")}</button>{vibe !== "nearby" ? <div><button type="button" className={styles.textButton} onClick={() => chooseVibe("nearby")}>{t("nearby")}<ArrowRight size={14} /></button></div> : null}</>}
    </section>}
    {loadFailed ? <p role="status" className={styles.error}>{t("loadError")}</p> : null}
  </main>;
}
