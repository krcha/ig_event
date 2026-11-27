"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { LocalizedLink } from "@/components/i18n/public-text";
import { localizeHref } from "@/i18n/config";
import { useLocale } from "@/i18n/client";
import { sendTravelMeasurement } from "@/lib/analytics/travel-client";
import { travelText } from "@/lib/travel/copy";

type Stage = "reference" | "recommendations";
let navigation: { path: string; start: number; sent: Set<string> } | undefined;

let listening = false;
let hiddenSince = -1;
function trackHistory() {
  if (listening) return;
  listening = true;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hiddenSince = performance.now();
  });
  // Browser back/forward is a new comparison visit with its own start.
  window.addEventListener("popstate", () => {
    navigation = /\/next\/event\/[^/]+\/?$/.test(location.pathname)
      ? { path: location.pathname, start: performance.now(), sent: new Set() } : undefined;
  });
}

export function CompareTravelLink({ href, children }: { href: string; children: ReactNode }) {
  const locale = useLocale();
  useEffect(trackHistory, []);
  return <LocalizedLink className="button-secondary min-h-10 gap-2 px-3" href={href} prefetch={false}
    onNavigate={() => { navigation = { path: localizeHref(href, locale), start: performance.now(), sent: new Set() }; }}>
    {children}
  </LocalizedLink>;
}

function compareClock() {
  trackHistory();
  const path = location.pathname;
  if (navigation?.path === path) return navigation;
  const entry = performance.getEntriesByType("navigation")[0];
  if (!entry || new URL(entry.name).pathname !== path) return;
  navigation = { path, start: entry.startTime, sent: new Set() };
  return navigation;
}

export function CompareTiming({ stage, failed = false }: { stage: Stage; failed?: boolean }) {
  const locale = useLocale();
  const [pending, setPending] = useState(false);
  const lastOutcome = useRef<string>("");
  useEffect(() => {
    const clock = compareClock();
    const key = stage + (failed ? "-error" : "-ready");
    if (lastOutcome.current === key || !clock || clock.sent.has(key)) return;
    lastOutcome.current = key;
    clock.sent.add(key);
    if (!failed && hiddenSince >= clock.start) return;
    sendTravelMeasurement(failed ? { kind: "travel", stage, outcome: "error" }
      : { kind: "travel", stage, outcome: "ready", ms: Math.round(performance.now() - clock.start) });
  }, [stage, failed]);
  if (!failed) return null;
  return <div><p role="status">{travelText(locale, pending ? "loadingProgrammes" : "loadError")}</p>
    <button className="button-secondary" type="button" disabled={pending} onClick={() => {
      sendTravelMeasurement({ kind: "travel", stage, outcome: "retry" });
      setPending(true);
      // Drop the failed RSC/Suspense tree as well as the request. A refresh of
      // the same boundary can preserve its error UI even after the server recovers.
      window.location.reload();
    }}>{travelText(locale, "refresh")}</button></div>;
}
