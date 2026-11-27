import type { TravelMeasurement } from "./travel-metrics";

export function sendTravelMeasurement(sample: TravelMeasurement) {
  try {
    if (document.hidden || navigator.doNotTrack === "1" || (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl) return;
    if (!window.matchMedia("(any-pointer: coarse)").matches) return;
    void fetch("/api/analytics", { method: "POST", keepalive: true, credentials: "omit", referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(sample) }).catch(() => {});
  } catch { /* Timing collection never interrupts the journey. */ }
}
