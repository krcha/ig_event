"use client";

import { useState } from "react";
import countries from "@/lib/analytics/world-map.json";
import type { AnalyticsRow } from "@/lib/analytics/model";
import styles from "./analytics.module.css";

export function AnalyticsWorldMap({ countries: rows }: { countries: AnalyticsRow[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const counts = new Map(rows.map((row) => [row.name, row.views]));
  const max = Math.max(1, ...rows.filter((row) => row.name !== "Unknown").map((row) => row.views));
  const selectedCountry = countries.find((country) => country.code === selected);
  const tones = ["#39344e", "#5c507f", "#806bb3", "#aa91ed"];
  return (
    <div className={styles.map}>
      <svg viewBox="0 0 720 315" aria-label="World map showing page views by country. Exact values are listed in Top countries." role="img" onMouseLeave={() => setSelected(null)}>
        <title>Visitor countries</title>
        {countries.map((country) => {
          const views = counts.get(country.code) ?? 0;
          return <path key={country.code} d={country.path} fill={views ? tones[Math.min(3, Math.floor(views / max * 3))] : "#242531"} stroke={selected === country.code ? "#ede8ff" : "#11131c"} strokeWidth={selected === country.code ? 1 : .5} onMouseEnter={() => setSelected(country.code)} onFocus={() => setSelected(country.code)} onBlur={() => setSelected(null)} tabIndex={views ? 0 : undefined} aria-label={`${country.name}: ${views} views`}><title>{country.name}: {views.toLocaleString("en-GB")} views</title></path>;
        })}
      </svg>
      {selectedCountry && <div className={styles.mapTooltip}>{selectedCountry.name} · {(counts.get(selectedCountry.code) ?? 0).toLocaleString("en-GB")} views</div>}
      <div className={styles.mapLegend}><span>Fewer {tones.map((tone) => <i key={tone} style={{ background: tone }} />)} More views</span><span>Hover or focus a country</span></div>
    </div>
  );
}
