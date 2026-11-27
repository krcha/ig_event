"use client";

import { LocateFixed } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocale } from "@/i18n/client";
import { travelText } from "@/lib/travel/copy";
import { useUserLocation } from "./user-location";
import styles from "./compass-flow.module.css";

export function CompassLocationStep() {
  const locale = useLocale();
  const { status, error, requestLocation } = useUserLocation();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  return <section className={styles.step}>
    <LocateFixed size={40} className="text-primary" aria-hidden="true" />
    <p className={styles.intro}>{travelText(locale, "locationIntro")}</p>
    <button className={styles.primary} type="button" disabled={!mounted || status === "loading"} onClick={requestLocation}><LocateFixed size={18} />{travelText(locale, status === "loading" ? "locating" : "locate")}</button>
    {error ? <p role="status" className={styles.error}>{error}</p> : null}
  </section>;
}
