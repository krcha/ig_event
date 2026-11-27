"use client";

import dynamic from "next/dynamic";
import { LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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

function useOutingPart<K extends OutingPart>(part: K, enabled: boolean, denied: boolean, attempt: number) {
  const [state, setState] = useState<{ value?: OutingParts[K]; error: boolean }>({ error: false });
  useEffect(() => {
    if (!enabled) {
      if (denied) setState({ error: false });
      return;
    }
    setState(previous => ({ ...previous, error: false }));
    return requestOutingPart(part,
      value => setState({ value, error: false }),
      () => setState({ error: true }));
  }, [enabled, denied, attempt, part]);
  return state;
}

export function CompassEntry() {
  const locale = useLocale();
  const { position, status } = useUserLocation();
  const hasLocation = Boolean(position);
  const [attempt, setAttempt] = useState(0);
  const directory = useOutingPart("places", hasLocation, status === "error", attempt);
  const lineup = useOutingPart("programmes", hasLocation, status === "error", attempt);
  useEffect(() => { if (hasLocation) void importFlow().catch(() => {}); }, [hasLocation]);
  const places = useMemo(() => {
    if (!directory.value) return;
    const byVenue = new Map(lineup.value?.map(group => [group.venueId, group.programmes]));
    return directory.value.map(place => ({ ...place, programmes: byVenue.get(place.id) ?? [] }));
  }, [directory.value, lineup.value]);

  const refresh = () => setAttempt(previous => previous + 1);
  if (places) return <CompassFlow places={places} programmesStatus={lineup.error ? "error" : lineup.value ? "ready" : "loading"} onRefresh={refresh} />;
  return <main className={styles.page} data-compass-phase={hasLocation ? "confirm" : "locate"}>
    <div className={styles.headingRow}><div><h1 className={styles.heading}>{travelText(locale, "next")}</h1></div></div>
    {!hasLocation ? <CompassLocationStep /> : directory.error ? <section className={styles.step}>
      <p role="status" className={styles.error}>{travelText(locale, "loadError")}</p>
      <button className={styles.secondary} type="button" onClick={refresh}>{travelText(locale, "refresh")}</button>
    </section> : <LoadingPlaces />}
  </main>;
}
