"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { CompassLocationStep } from "./compass-location-step";
import { ArrowLeft, ArrowRight, CarFront, Check, Footprints, LoaderCircle, LocateFixed, MapPin, Music2, Route, Shuffle, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale } from "@/i18n/client";
import { localizeHref } from "@/i18n/config";
import { MUSIC_GENRES } from "@/lib/taxonomy/event-discovery";
import { compassCandidates, getCompassGenres, getCompassMusicBasis, getCompassSourceAt, getCompassSourceProgrammes, type CompassMusicProfile, type CompassPlace } from "@/lib/travel/compass";
import { compassVenueTypeText, travelText } from "@/lib/travel/copy";
import { getCompassView, type ProgrammeStatus } from "@/lib/travel/outing-request";
import { formatTravelDuration } from "@/lib/travel/duration";
import { bearingDegrees, estimateTravel, haversineMeters, type Coordinates } from "@/lib/travel/location";
import { CompassMatchSpectrum } from "./compass-match-spectrum";
import { useUserLocation } from "./user-location";
import { YandexTaxiButton } from "./yandex-taxi-button";
import styles from "./compass-flow.module.css";

const loadRouteMap = () => import("./route-map");
const RouteMap = dynamic(() => loadRouteMap().then((module) => module.RouteMap), { ssr: false, loading: RouteMapLoading });
function RouteMapLoading() {
  const locale = useLocale();
  return <p className={styles.mapLoading} role="status"><LoaderCircle size={17} className="motion-safe:animate-spin" aria-hidden="true" />{travelText(locale, "mapLoading")}</p>;
}
function warmRouteMap() { void loadRouteMap().then(module => module.preloadLeaflet()).catch(() => {}); }
const compassPreferenceKey = "eventzeka.compass-permission.v1";
function rememberCompassPermission(value: "granted" | "denied") {
  try { localStorage.setItem(compassPreferenceKey, value); } catch { /* Sensors do not require storage. */ }
}
function rememberedCompassPermission() {
  try { return localStorage.getItem(compassPreferenceKey); } catch { return null; }
}
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
    !Array.isArray(event.taxonomy.formats) || !event.taxonomy.formats.every(format => typeof format === "string") ||
    typeof event.taxonomy.primaryCategory !== "string" ||
    !Array.isArray(event.taxonomy.genres) || !event.taxonomy.genres.every(genre => musicGenreKeys.has(genre)))) throw new Error("Invalid programme context");
  return { musicProfile: profile, ...(event ? { event } : {}) };
}

export function CompassFlow({ places, programmesStatus, onRetryDirectory, onRetryProgrammes, onFirstPlace }: {
  places: CompassPlace[]; programmesStatus: ProgrammeStatus;
  onRetryDirectory: () => void; onRetryProgrammes: () => void; onFirstPlace: (part: "places") => void;
}) {
  const locale = useLocale();
  const t = (key: Parameters<typeof travelText>[1]) => travelText(locale, key);
  const { position } = useUserLocation();
  const [now, setNow] = useState(Date.now);
  const [phase, setPhase] = useState<"confirm" | "vibe" | "results">("confirm");
  const [rejectedIds, setRejectedIds] = useState<string[]>([]);
  const [manualVenueId, setManualVenueId] = useState("");
  const [confirmedPlace, setConfirmedPlace] = useState<CompassPlace | null>(null);
  const [sourceReference, setSourceReference] = useState("");
  const [sourceLookup, setSourceLookup] = useState<{
    key: string;
    status: "loading" | "ready" | "error";
    context?: SourceMusicContext;
  }>();
  const [sourceLookupAttempt, setSourceLookupAttempt] = useState(0);
  const [vibe, setVibe] = useState<"same" | "different" | "nearby">("same");
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
  const orientationState = useRef<"idle" | "pending" | "active" | "gesture" | "denied">("idle");
  const orientationGeneration = useRef(0);
  const orientationReading = useRef(false);
  const lastHeading = useRef<number | null>(null);
  const orientationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [paused, setPaused] = useState(false);
  const [nudged, setNudged] = useState(false);
  const nudgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 30_000);
    const visibility = () => setPaused(document.hidden);
    document.addEventListener("visibilitychange", visibility);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", visibility); if (nudgeTimer.current) clearTimeout(nudgeTimer.current); };
  }, []);
  const nearest = useMemo(() => position ? places.map((place, order) => ({ place, order, meters: haversineMeters(position, place) }))
    .sort((a, b) => a.meters - b.meters || a.order - b.order).map(({ place }) => place) : [], [places, position]);
  const venueOptions = useMemo(() => [...places].sort((a, b) => a.name.localeCompare(b.name, locale)), [places, locale]);
  const confirmation = (manualVenueId ? places.find(place => place.id === manualVenueId) : undefined)
    ?? nearest.find(place => !rejectedIds.includes(place.id));
  const hasFirstPlace = phase === "confirm" && Boolean(position && confirmation);
  useEffect(() => { if (hasFirstPlace) onFirstPlace("places"); }, [hasFirstPlace, onFirstPlace]);
  const sourcePlace = confirmedPlace && (places.find(place => place.id === confirmedPlace.id) ?? confirmedPlace);
  const sourceProgrammes = useMemo(() => sourcePlace ? getCompassSourceProgrammes(sourcePlace, now) : [], [sourcePlace, now]);
  const currentReference = sourceReference === "venue" || sourceProgrammes.some(event => event.id === sourceReference) ? sourceReference : "";
  const resolvedSource = useMemo(() => sourcePlace ? getCompassSourceAt(sourcePlace, now,
    currentReference === "venue" ? "venue" : currentReference ? { eventId: currentReference } : undefined) : undefined,
  [sourcePlace, now, currentReference]);
  const sourceVenueId = resolvedSource?.id;
  const sourceLookupKey = position && programmesStatus === "ready" && resolvedSource && !currentReference && (!resolvedSource.venueType || resolvedSource.event) && !getCompassGenres(resolvedSource).length
    ? `${resolvedSource.id}/${resolvedSource.event?.id ?? ""}` : undefined;
  const lookup = sourceLookup?.key === sourceLookupKey ? sourceLookup : undefined;
  const sourceLookupLoading = Boolean(sourceLookupKey && (!lookup || lookup.status === "loading"));
  const sourceLookupFailed = lookup?.status === "error";
  useEffect(() => {
    if (!sourceVenueId || !sourceLookupKey) return;
    const controller = new AbortController();
    let cancelled = false;
    let timedOut = false;
    setSourceLookup({ key: sourceLookupKey, status: "loading" });
    const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, 8_000);
    void fetch(`/api/travel/music-profile/${encodeURIComponent(sourceVenueId)}`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error("Music context unavailable");
        const context = readSourceMusicContext(await response.json());
        if (cancelled || controller.signal.aborted) return;
        setSourceLookup({ key: sourceLookupKey, status: "ready", context });
      }).catch(() => {
        if (!cancelled && (!controller.signal.aborted || timedOut)) setSourceLookup({ key: sourceLookupKey, status: "error" });
      }).finally(() => clearTimeout(deadline));
    return () => { cancelled = true; clearTimeout(deadline); controller.abort(); };
  }, [sourceVenueId, sourceLookupKey, sourceLookupAttempt]);
  const source = useMemo(() => {
    const context = lookup?.context;
    if (!resolvedSource || !context || !context.musicProfile.genres.length) return resolvedSource;
    if (context.musicProfile.basis === "recent" && sourcePlace) {
      return getCompassSourceAt({ ...sourcePlace, recentMusicProfile: context.musicProfile }, now);
    }
    return context.event && context.event.id === resolvedSource.event?.id
      ? { ...resolvedSource, musicProfile: context.musicProfile } : resolvedSource;
  }, [lookup, now, resolvedSource, sourcePlace]);
  const sourceGenres = source ? getCompassGenres(source) : [];
  const sourceVenueType = source?.venueType && compassVenueTypeText(locale, source.venueType);
  const sourceHasCategory = source?.event?.taxonomy.categories.some(category => category !== "other") ?? false;
  const sourceContextUsable = Boolean(source?.venueType || sourceGenres.length || sourceHasCategory);
  const view = getCompassView(phase, programmesStatus, vibe !== "nearby" && sourceLookupLoading && !sourceContextUsable);
  const candidates = useMemo(() => view === "results" && source && position ? compassCandidates(places, source, position, vibe, now) : [], [view, places, source, position, vibe, now]);
  useEffect(() => { setIndex((current) => Math.min(current, Math.max(0, candidates.length - 1))); }, [candidates.length]);
  const destination = candidates[Math.min(index, Math.max(0, candidates.length - 1))];
  const destinationEvent = destination?.recommendation.basis === "venue" ? undefined : destination?.event;
  const destinationGenres = destinationEvent && destination ? getCompassGenres(destination) : [];
  const destinationVenueType = destination?.venueType && compassVenueTypeText(locale, destination.venueType);
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
  const walkMinutes = estimate ? route?.mode === "foot" ? Math.max(1, Math.ceil(route.distance / 75)) : estimate.walkMinutes : 0;
  const driveMinutes = estimate ? route?.mode === "car" ? Math.max(1, Math.ceil(route.distance / (20_000 / 60))) : estimate.driveMinutes : 0;
  const carPreferred = (estimate?.walkMinutes ?? 0) > 10;
  const mode = carPreferred ? "car" : "foot";
  const bearing = position && destination ? bearingDegrees(position, destination) : 0;
  // Keep the angular delta short across north, rather than spinning 359 degrees.
  const angle = useRef(0);
  const targetAngle = bearing - (heading ?? 0);
  const delta = ((targetAngle - angle.current + 540) % 360 + 360) % 360 - 180;
  const displayedAngle = angle.current + delta;
  useEffect(() => { angle.current = displayedAngle; }, [displayedAngle]);
  function chooseVibe(next: "same" | "different" | "nearby") { void enableCompass(true); routeRequest.current?.abort(); setNow(Date.now()); setRouteStatus("idle"); setRouteVisible(false); setVibe(next); setIndex(0); setPhase("results"); }
  function reset() { routeRequest.current?.abort(); setRouteStatus("idle"); setPhase("confirm"); setConfirmedPlace(null); setSourceReference(""); setSourceLookup(undefined); setManualVenueId(""); setRejectedIds([]); setIndex(0); setRoute(null); setRouteVisible(false); }
  function hideRoute() { void enableCompass(true); routeRequest.current?.abort(); setRouteStatus("idle"); setRouteVisible(false); requestAnimationFrame(() => routeButton.current?.focus({ preventScroll: true })); }
  function nudge() { setNudged(false); requestAnimationFrame(() => setNudged(true)); if (nudgeTimer.current) clearTimeout(nudgeTimer.current); nudgeTimer.current = setTimeout(() => setNudged(false), 800); }
  const stopCompass = useCallback(() => {
    orientationGeneration.current++;
    orientationCleanup.current?.();
    orientationCleanup.current = null;
    if (orientationTimer.current) clearTimeout(orientationTimer.current);
    orientationTimer.current = null;
    lastHeading.current = null;
    orientationState.current = "idle";
  }, []);
  const enableCompass = useCallback(async (fromGesture = false, retryDenied = false) => {
    if (document.hidden || orientationState.current === "active" || orientationState.current === "pending") return;
    if (rememberedCompassPermission() === "denied" && !retryDenied) { orientationState.current = "denied"; setOrientationMessage(true); return; }
    const OrientationEvent = window.DeviceOrientationEvent as typeof DeviceOrientationEvent & { requestPermission?: (absolute?: boolean) => Promise<string> };
    if (!OrientationEvent) { setOrientationMessage(true); return; }
    const generation = ++orientationGeneration.current;
    orientationState.current = "pending";
    try {
      if (OrientationEvent.requestPermission) {
        // iOS needs an existing user gesture on the first grant, even though the sensor is on by default.
        if (!fromGesture && rememberedCompassPermission() !== "granted") { orientationState.current = "gesture"; return; }
        const permission = await OrientationEvent.requestPermission(true);
        if (generation !== orientationGeneration.current) return;
        if (permission !== "granted") { rememberCompassPermission("denied"); orientationState.current = "denied"; setOrientationMessage(true); return; }
        rememberCompassPermission("granted");
      }
      if (generation !== orientationGeneration.current || document.hidden) return;
      orientationCleanup.current?.();
      orientationReading.current = false;
      const listener = (event: DeviceOrientationEvent) => {
        const reading = event as Orientation;
        const value = typeof reading.webkitCompassHeading === "number" && (reading.webkitCompassAccuracy ?? 0) >= 0 ? reading.webkitCompassHeading
          : event.absolute && event.alpha !== null ? (360 - event.alpha) % 360 : null;
        if (value === null || !Number.isFinite(value)) return;
        if (!orientationReading.current) rememberCompassPermission("granted");
        orientationReading.current = true;
        const normalized = ((value % 360) + 360) % 360;
        const previous = lastHeading.current;
        if (previous === null || Math.abs(((normalized - previous + 540) % 360) - 180) >= 1) {
          lastHeading.current = normalized;
          setHeading(normalized);
        }
        setOrientationMessage(false);
      };
      window.addEventListener("deviceorientationabsolute", listener);
      window.addEventListener("deviceorientation", listener);
      orientationCleanup.current = () => { window.removeEventListener("deviceorientationabsolute", listener); window.removeEventListener("deviceorientation", listener); };
      orientationState.current = "active";
      orientationTimer.current = setTimeout(() => { if (!orientationReading.current) setOrientationMessage(true); }, 2_000);
    } catch {
      if (generation !== orientationGeneration.current) return;
      // A missing gesture is not a denial. Retry within the next Yes / vibe tap.
      orientationState.current = "gesture";
      if (fromGesture) setOrientationMessage(true);
    }
  }, []);
  useEffect(() => {
    void enableCompass();
    const visibility = () => {
      if (document.hidden) { stopCompass(); setHeading(null); }
      else void enableCompass();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => { stopCompass(); document.removeEventListener("visibilitychange", visibility); };
  }, [enableCompass, stopCompass]);
  async function showRoute() {
    if (!position || !destination) return;
    void enableCompass(true);
    if (route && route.mode === mode && haversineMeters(route.origin, position) <= 50) { setRouteVisible(true); return; }
    routeRequest.current?.abort();
    const controller = new AbortController(); routeRequest.current = controller;
    warmRouteMap();
    setRouteStatus("loading");
    setRouteVisible(true);
    try {
      const response = await fetch("/api/travel/route", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ origin: { latitude: position.latitude, longitude: position.longitude }, destination: { latitude: destination.latitude, longitude: destination.longitude }, mode }), signal: controller.signal });
      const result = await response.json();
      if (!response.ok || !Array.isArray(result.coordinates) || !Number.isFinite(result.distance)) throw new Error("route");
      if (controller.signal.aborted) return;
      setRoute({ distance: result.distance, coordinates: result.coordinates, origin: position, mode }); setRouteVisible(true); setRouteStatus("idle");
    } catch { if (!controller.signal.aborted) { setRouteStatus("error"); setRouteVisible(false); } }
  }
  const programmeStatus = programmesStatus !== "ready" ? <div role="status">
    {programmesStatus === "error" ? <><p className={styles.error}>{t("programmeLoadError")}</p>
      <button className={styles.secondary} type="button" onClick={onRetryProgrammes}>{t("refresh")}</button></>
      : <p><LoaderCircle size={20} className="inline motion-safe:animate-spin" aria-hidden="true" /> {t("loadingProgrammes")}</p>}
  </div> : null;
  return <main className={styles.page} data-compass-phase={!position ? "locate" : phase}>
    <div className={styles.headingRow}>
      <div><h1 className={styles.heading}>{t("next")}</h1>{position && phase === "results" ? <p className={styles.modeLabel}>{t(vibe === "same" ? "same" : vibe === "different" ? "different" : "nearby")}<small>{vibe === "nearby" ? t("nearest") : source?.event?.title ?? source?.name}</small></p> : null}</div>
      {position && phase === "results" ? <button type="button" className={styles.textButton} onClick={() => { routeRequest.current?.abort(); setRouteStatus("idle"); setPhase("vibe"); }}>{t("change")}</button> : position && phase === "vibe" ? <button className={styles.resetButton} type="button" onClick={reset} aria-label={t("reset")} title={t("reset")}><LocateFixed size={18} aria-hidden="true" /></button> : null}
    </div>
    {!position ? <CompassLocationStep /> : view === "confirm" ? <section className={`${styles.step} ${styles.confirm}`} key="confirm">
      <h2 className={styles.title}>{t("here")}</h2>
      {!manualVenueId ? <p className={styles.muted}>{t("nearest")}</p> : null}
      {confirmation ? <>
        <div className={styles.place} key={confirmation.id}><MapPin size={24} className="text-primary" aria-hidden="true" /><h3 className={styles.name}>{confirmation.name}</h3><p className={styles.address}>{confirmation.address}</p>
          <p className={styles.muted}>≈ {formatTravelDuration(estimateTravel(position, confirmation).walkMinutes, locale)} {t("walk")}</p></div>
        <div className={styles.actions}><button type="button" className={styles.secondary} onClick={() => { setManualVenueId(""); setRejectedIds(ids => [...ids, confirmation.id]); }}>{t("no")}</button><button type="button" className={styles.primary} onClick={() => { void enableCompass(true); setNow(Date.now()); setConfirmedPlace(confirmation); setPhase("vibe"); }}><Check size={18} aria-hidden="true" />{t("yes")}</button></div>
      </> : <><p className={styles.intro}>{t(places.length ? "end" : "noPlaces")}</p><button type="button" className={styles.secondary} onClick={() => { setRejectedIds([]); onRetryDirectory(); }}>{t("refresh")}</button></>}
      {venueOptions.length ? <details className={styles.manualVenue}>
        <summary className={styles.textButton}>{t("chooseAnotherVenue")}</summary>
        <label className={styles.sourceReference}>
          <span>{t("venueName")}</span>
          <select value={manualVenueId} onChange={event => setManualVenueId(event.target.value)}>
            <option value="">{t("nearestVenue")}</option>
            {venueOptions.map(place => <option key={place.id} value={place.id}>{place.name}{place.address ? ` · ${place.address}` : ""}</option>)}
          </select>
        </label>
      </details> : null}
    </section> : view === "vibe" ? <section className={`${styles.step} ${styles.vibe}`} key="vibe">
      {programmeStatus}
      <p className={styles.muted}>{source?.name}{sourceVenueType ? ` · ${sourceVenueType}` : null}</p>
      {programmesStatus === "ready" && sourceProgrammes.length ? <label className={styles.sourceReference}>
        <span>{t("sourceReference")}</span>
        <select value={currentReference} onChange={event => setSourceReference(event.target.value)}>
          <option value="">{t("sourceAutomatic")}</option>
          <option value="venue">{t("sourceVenue")}</option>
          {sourceProgrammes.map(event => <option key={event.id} value={event.id}>{event.title}{event.time ? ` · ${event.time}` : ""}</option>)}
        </select>
      </label> : null}
      {source?.event && !currentReference ? <p className={styles.sourceEvent}>{source.event.title}</p> : null}
      {source && sourceGenres.length ? <p className={`${styles.muted} ${styles.musicSummary}`}>{genreLabel(sourceGenres)}<span className={styles.musicBasis}>{musicBasisLabel(source)}</span></p> : null}
      <h2 className={styles.title}>{t("vibe")}</h2>
      {sourceLookupLoading ? <p className={styles.lookupStatus} role="status"><LoaderCircle size={14} className="motion-safe:animate-spin" aria-hidden="true" /><span>{t("musicLookup")}</span></p> : null}
      <button type="button" className={styles.choice} disabled={sourceLookupLoading && !sourceContextUsable} onClick={() => chooseVibe("same")}><Music2 size={27} aria-hidden="true" /><span><strong>{t("same")}</strong><small>{t("sameHint")}</small></span></button>
      <button type="button" className={styles.choice} disabled={sourceLookupLoading && !sourceContextUsable} onClick={() => chooseVibe("different")}><Shuffle size={27} aria-hidden="true" /><span><strong>{t("different")}</strong><small>{t("differentHint")}</small></span></button>
      {sourceLookupFailed ? <p className={`${styles.muted} ${styles.vibeNote}`} role="status">{t("musicLookupFailed")}</p>
        : programmesStatus === "ready" && !sourceLookupLoading && !sourceContextUsable ? <p className={`${styles.muted} ${styles.vibeNote}`}>{t("unknownVibe")}</p>
          : !sourceLookupLoading && source?.event && !sourceGenres.length ? <p className={`${styles.muted} ${styles.vibeNote}`}>{t("musicUnknown")}</p> : null}
      <div className={styles.lookupActions}>
        <button type="button" className={styles.textButton} onClick={() => chooseVibe("nearby")}>{t("nearby")}<ArrowRight size={14} aria-hidden="true" /></button>
        {sourceLookupFailed ? <button type="button" className={styles.textButton} onClick={() => setSourceLookupAttempt(attempt => attempt + 1)}>{t("refresh")}</button> : null}
      </div>
    </section> : view === "programme-status" ? <section className={styles.step}>{programmeStatus}</section>
      : view === "music-status" ? <section className={styles.step} role="status">{t("musicLookup")}</section>
      : <section className={`${styles.step} ${styles.results}`} key="results">
      <div className={styles.footer}>
        {destination ? <Link href={localizeHref(destinationEvent ? `/events/${destinationEvent.id}` : `/venues/${destination.id}`, locale)} className={styles.eventLink}>{t(destinationEvent ? "details" : "venueDetails")}<ArrowRight size={13} aria-hidden="true" /></Link> : <span />}
        <button type="button" className={styles.textButton} onClick={reset}>{t("reset")}</button>
      </div>
      {destination && estimate ? <>
        <div className={styles.resultTitle} aria-live="polite" aria-atomic="true">
          <h2 className={styles.name}>{destination.name}</h2><p className={styles.address}>{destination.address}</p>
          <p className={styles.open}>{destinationVenueType ? `${destinationVenueType} · ` : ""}{t(destination.openNow ? "open" : "openAtArrival")}{destination.hoursLabel ? ` · ${t("until")} ${destination.hoursLabel}` : ""}</p>
          {destinationEvent ? <p className={styles.eventTitle}>{destinationEvent.title}{destination.recommendation.programmeTiming === "unknown-start" ? <span className={styles.musicBasis}>{t("unknownStart")}</span> : null}</p> : null}
          {destinationGenres.length ? <p className={`${styles.muted} ${styles.genreLabel}`}>{genreLabel(destinationGenres)}<span className={styles.musicBasis}>{musicBasisLabel(destination)}</span></p> : null}
          <CompassMatchSpectrum locale={locale} score={destination.recommendation.score} reason={destination.recommendation.reason} />
        </div>
        <div className={styles.directionArea} data-compass-direction="true" data-compass-status={orientationUnavailable || routeStatus === "error" ? "true" : undefined} id="where-next-direction">
          {routeVisible ? <div className={styles.route} aria-busy={routeStatus === "loading"}>
            <RouteMap origin={route?.origin ?? position} destination={destination} coordinates={route?.coordinates} routePending={routeStatus === "loading"} />
            <button className={styles.closeRoute} type="button" onClick={hideRoute} aria-label={t("backToCompass")} title={t("backToCompass")}><X size={17} aria-hidden="true" /></button>
            <a className={styles.mapNavigation} href={`https://www.google.com/maps/dir/?api=1&origin=${position.latitude},${position.longitude}&destination=${destination.latitude},${destination.longitude}&travelmode=${carPreferred ? "driving" : "walking"}`} target="_blank" rel="noopener noreferrer">{t("navigation")}<ArrowRight size={14} aria-hidden="true" /></a>
          </div> : <>
            <div className={`${styles.compass} ${paused ? styles.paused : ""}`}>
              <span className={styles.north}>N</span><button className={styles.needleButton} type="button" onClick={() => { nudge(); void enableCompass(true, true); }} aria-label={t("north")}>
                <svg className={styles.bearing} style={{ transform: `rotate(${displayedAngle}deg)` }} viewBox="0 0 85 104" aria-hidden="true"><g className={nudged ? styles.needleNudge : styles.needle}><path d="M42.5 5 72 88 42.5 73 13 88Z" fill="#D5F56B" /><path d="M42.5 5V73L13 88Z" fill="#C0DB69" /></g></svg>
              </button>
            </div>
            <div className={styles.bearingLabel}>
              {heading !== null ? <span className="sr-only" role="status">{t("compassOn")}</span> : null}
              {orientationUnavailable ? <p className={`${styles.muted} ${styles.orientationStatus}`} role="status">{t("compassUnavailable")}</p> : null}
              {routeStatus === "error" ? <p className={styles.routeError} role="status"><a className={styles.routeErrorLink} href={`https://www.google.com/maps/dir/?api=1&origin=${position.latitude},${position.longitude}&destination=${destination.latitude},${destination.longitude}&travelmode=${carPreferred ? "driving" : "walking"}`} target="_blank" rel="noopener noreferrer">{t("routeError")}<ArrowRight size={13} aria-hidden="true" /></a></p> : null}
            </div>
          </>}
        </div>
        <div className={styles.travelInfo}>
          <div className={styles.eta} data-long-duration={walkMinutes > 60 || driveMinutes > 60 ? "true" : undefined}><span className={!carPreferred ? styles.preferred : ""}><Footprints size={16} aria-hidden="true" />≈ {formatTravelDuration(walkMinutes, locale)} {t("walk")}</span><span className={carPreferred ? styles.preferred : ""}><CarFront size={16} aria-hidden="true" />≈ {formatTravelDuration(driveMinutes, locale)} {t("drive")}</span></div>
          <p className={styles.estimate}>{t("estimate")}</p>
        </div>
        <div className={`${styles.actions} ${styles.routeActions}`}><button className={styles.primary} type="button" disabled={routeStatus === "loading"} onClick={showRoute} onFocus={warmRouteMap} onPointerEnter={warmRouteMap} onPointerDown={warmRouteMap} ref={routeButton} aria-controls="where-next-direction" aria-expanded={routeVisible}><Route size={17} aria-hidden="true" />{t(routeStatus === "loading" ? "routeLoading" : "route")}</button><YandexTaxiButton latitude={destination.latitude} longitude={destination.longitude} venueName={destination.name} /></div>
        <div className={styles.pagination}><button type="button" className={styles.secondary} disabled={index === 0} onClick={() => { void enableCompass(true); setIndex((value) => value - 1); }} aria-label={t("previous")}><ArrowLeft size={17} aria-hidden="true" /></button><button type="button" className={styles.secondary} disabled={index >= candidates.length - 1} onClick={() => { void enableCompass(true); setIndex((value) => value + 1); }}>{t("nextPlace")}<ArrowRight size={17} aria-hidden="true" /></button><span className={styles.muted}>{Math.min(index + 1, candidates.length)} / {candidates.length}</span></div>
      </> : <><h2 className={styles.title}>{t("empty")}</h2><p className={styles.intro}>{t("emptyHint")}</p><button className={styles.secondary} type="button" onClick={() => { setNow(Date.now()); onRetryProgrammes(); }}>{t("refresh")}</button>{vibe !== "nearby" ? <div><button type="button" className={styles.textButton} onClick={() => chooseVibe("nearby")}>{t("nearby")}<ArrowRight size={14} /></button></div> : null}</>}
    </section>}
  </main>;
}
