"use client";

import dynamic from "next/dynamic";
import { LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sendTravelMeasurement } from "@/lib/analytics/travel-client";
import { useLocale } from "@/i18n/client";
import { requestOutingPart, type OutingPart, type OutingParts } from "@/lib/travel/outing-request";
import { travelText } from "@/lib/travel/copy";
import { CompassLocationStep } from "./compass-location-step";
import { useUserLocation } from "./user-location";
import styles from "./compass-flow.module.css";

const importFlow = () => import("./compass-flow");
const CompassFlow = dynamic(() => importFlow().then(module => module.CompassFlow), { loading: LoadingFlow });

function LoadingFlow() {
  const locale = useLocale();
  return <main className={styles.page} data-compass-phase="confirm">
    <div className={styles.headingRow}><div><h1 className={styles.heading}>{travelText(locale, "next")}</h1></div></div>
    <LoadingPlaces />
  </main>;
}

function LoadingPlaces() {
  const locale = useLocale();
  return <section className={styles.step} role="status"><LoaderCircle size={22} className="motion-safe:animate-spin" aria-hidden="true" />{travelText(locale, "loadingPlaces")}</section>;
}

function useOutingPart<K extends OutingPart>(part: K, enabled: boolean, denied: boolean) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ value?: OutingParts[K]; status: "loading" | "ready" | "error" }>({ status: "loading" });
  useEffect(() => {
    if (!enabled) {
      if (denied) setState({ status: "loading" });
      return;
    }
    setState(previous => ({ ...previous, status: "loading" }));
    return requestOutingPart(part, value => setState({ value, status: "ready" }), () => {
      sendTravelMeasurement({ kind: "travel", stage: part, outcome: "error" });
      setState({ status: "error" });
    });
  }, [enabled, denied, attempt, part]);
  const refresh = useCallback(() => {
    if (state.status === "error") sendTravelMeasurement({ kind: "travel", stage: part, outcome: "retry" });
    setAttempt(previous => previous + 1);
  }, [part, state.status]);
  return { ...state, refresh };
}

export function CompassEntry() {
  const locale = useLocale();
  const { position, status } = useUserLocation();
  const hasLocation = Boolean(position);
  const clock = useRef<{ start: number; reported: Set<OutingPart> } | null>(null);
  useEffect(() => {
    if (!hasLocation) { clock.current = null; return; }
    clock.current ??= { start: performance.now(), reported: new Set() };
  }, [hasLocation]);
  const markReady = useCallback((part: OutingPart) => {
    const visit = clock.current;
    if (!visit || visit.reported.has(part)) return;
    visit.reported.add(part);
    sendTravelMeasurement({ kind: "travel", stage: part, outcome: "ready", ms: Math.round(performance.now() - visit.start) });
  }, []);
  const directory = useOutingPart("places", hasLocation, status === "error");
  const lineup = useOutingPart("programmes", hasLocation, status === "error");
  useEffect(() => { if (hasLocation) void importFlow().catch(() => {}); }, [hasLocation]);
  useEffect(() => { if (hasLocation && lineup.status === "ready") markReady("programmes"); }, [hasLocation, lineup.status, markReady]);
  const places = useMemo(() => {
    if (!directory.value) return;
    const byVenue = new Map(lineup.value?.map(group => [group.venueId, group.programmes]));
    return directory.value.map(place => ({ ...place, programmes: byVenue.get(place.id) ?? [] }));
  }, [directory.value, lineup.value]);

  if (hasLocation && places) return <CompassFlow places={places} programmesStatus={lineup.status} onRetryDirectory={directory.refresh}
    onRetryProgrammes={lineup.refresh} onFirstPlace={markReady} />;
  return <main className={styles.page} data-compass-phase={hasLocation ? "confirm" : "locate"}>
    <div className={styles.headingRow}><div><h1 className={styles.heading}>{travelText(locale, "next")}</h1></div></div>
    {!hasLocation ? <CompassLocationStep /> : directory.status === "error" ? <section className={styles.step}>
      <p role="status" className={styles.error}>{travelText(locale, "placesLoadError")}</p>
      <button className={styles.secondary} type="button" onClick={directory.refresh}>{travelText(locale, "refresh")}</button>
    </section> : <LoadingPlaces />}
  </main>;
}
