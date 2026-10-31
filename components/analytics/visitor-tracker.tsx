"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { cleanLabel, isPublicAnalyticsPath } from "@/lib/analytics/model";

const VISITOR_KEY = "eventzeka.analytics.visitor";
const SESSION_KEY = "eventzeka.analytics.session";
const SESSION_IDLE_MS = 30 * 60_000;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Session = { id: string; lastSeen: number; source: string; medium: string; campaign: string };
let memoryVisitor: { id: string; expires: number } | null = null;
let memorySession: Session | null = null;

function identity(search: URLSearchParams) {
  const now = Date.now();
  try {
    const stored = JSON.parse(localStorage.getItem(VISITOR_KEY) ?? "null");
    if (stored && typeof stored.id === "string" && ID_PATTERN.test(stored.id) && Number.isFinite(stored.expires)) memoryVisitor = stored;
  } catch { /* Storage may be disabled; keep the in-memory identity. */ }
  if (!memoryVisitor?.id || memoryVisitor.expires <= now) memoryVisitor = { id: crypto.randomUUID(), expires: now + 365 * 86_400_000 };
  try { localStorage.setItem(VISITOR_KEY, JSON.stringify(memoryVisitor)); } catch { /* Use in-memory identity for this tab. */ }
  try {
    const stored = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "null");
    if (stored && typeof stored.id === "string" && ID_PATTERN.test(stored.id) && Number.isFinite(stored.lastSeen) &&
      [stored.source, stored.medium, stored.campaign].every((value) => typeof value === "string")) memorySession = stored;
  } catch { /* Use in-memory session. */ }
  if (!memorySession?.id || now - memorySession.lastSeen > SESSION_IDLE_MS) {
    let referrer = "";
    try { const url = new URL(document.referrer); if (url.origin !== location.origin) referrer = url.hostname; } catch { /* Direct visit. */ }
    memorySession = {
      id: crypto.randomUUID(), lastSeen: now,
      source: cleanLabel(search.get("utm_source")) || referrer || "Direct",
      medium: cleanLabel(search.get("utm_medium"), 80), campaign: cleanLabel(search.get("utm_campaign")),
    };
  }
  memorySession.lastSeen = now;
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(memorySession)); } catch { /* In-memory session remains available. */ }
  return { visitorId: memoryVisitor.id, sessionId: memorySession.id, source: memorySession.source, medium: memorySession.medium, campaign: memorySession.campaign };
}

export function VisitorTracker() {
  const path = usePathname();
  const search = useSearchParams();
  const lastPage = useRef("");
  useEffect(() => {
    if (!isPublicAnalyticsPath(path)) { lastPage.current = ""; return; }
    if (navigator.doNotTrack === "1" || (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl) return;
    const send = (kind: "pageview" | "click", target = "") => {
      try {
        void fetch("/api/analytics", {
          method: "POST", headers: { "Content-Type": "application/json" }, keepalive: true,
          body: JSON.stringify({ ...identity(search), eventId: crypto.randomUUID(), kind, path, target }),
        }).catch(() => { /* Analytics never blocks browsing. */ });
      } catch { /* Unsupported browser features must not affect the public site. */ }
    };
    if (lastPage.current !== path) { lastPage.current = path; send("pageview"); }
    const click = (event: MouseEvent) => {
      const element = event.target instanceof Element ? event.target.closest("a[href],button") : null;
      if (!element || element.closest("[data-analytics-ignore]") || element.hasAttribute("disabled")) return;
      let target = "";
      if (element instanceof HTMLAnchorElement) {
        try {
          const url = new URL(element.href);
          if (!["http:", "https:"].includes(url.protocol)) return;
          if (url.origin === location.origin && !isPublicAnalyticsPath(url.pathname)) return;
          target = url.origin === location.origin ? url.pathname : url.hostname + url.pathname;
        } catch { return; }
      } else {
        target = cleanLabel(element.getAttribute("data-analytics") || element.getAttribute("aria-label") || element.textContent, 100);
      }
      if (target) send("click", target);
    };
    document.addEventListener("click", click, { capture: true });
    return () => document.removeEventListener("click", click, { capture: true });
  }, [path, search]);
  return null;
}
