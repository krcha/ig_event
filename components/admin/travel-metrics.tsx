"use client";

import { useEffect, useState } from "react";
import { type summarizeTravelTimings } from "@/lib/analytics/travel-metrics";
import styles from "./analytics.module.css";

const names = { places: "First venue", programmes: "Programme ready", reference: "Comparison title", recommendations: "Comparison results" };
type Rows = ReturnType<typeof summarizeTravelTimings>;

export function TravelMetrics({ start, end, refresh }: { start: string; end: string; refresh: number }) {
  const [data, setData] = useState<Rows | "error" | null>(null);
  const tooLong = Date.parse(end) - Date.parse(start) > 30 * 86_400_000;
  useEffect(() => {
    if (tooLong) return;
    const controller = new AbortController();
    setData(null);
    void fetch("/api/admin/analytics?" + new URLSearchParams({ view: "travel", start, end }), { signal: controller.signal, cache: "no-store" })
      .then(async r => {
        if (!r.ok) throw new Error("Travel metrics unavailable");
        const rows: Rows = await r.json();
        if (!controller.signal.aborted) setData(rows);
      }).catch(() => { if (!controller.signal.aborted) setData("error"); });
    return () => controller.abort();
  }, [start, end, refresh, tooLong]);
  return <section className={styles.panel}>
    <div className={styles.panelHeading}><h2>Where next? · Mobile performance</h2></div>
    {tooLong ? <p>Select up to 31 days for mobile timings.</p>
      : data === "error" ? <p>Mobile timings could not be loaded.</p>
      : !data ? <p role="status">Loading mobile timings…</p>
      : <div className={styles.tableScroll}><table className={styles.table}>
        <thead><tr><th scope="col">Stage</th><th scope="col">p75</th><th scope="col">Ready samples</th><th scope="col">Errors</th><th scope="col">Retries</th></tr></thead>
        <tbody>{data.map(row => <tr key={row.stage}><th scope="row">{names[row.stage]}</th>
          <td>{row.overflow ? ">120 s" : row.p75Ms === null ? "—" : `${row.p75Ms / 1000} s`}</td>
          <td>{row.samples}</td><td>{row.errors}</td><td>{row.retries}</td></tr>)}</tbody>
      </table></div>}
    <p className={styles.footnote}>Venue and programme timings start when location is available. Comparison timings start at navigation. p75 is rounded up to 250 ms.</p>
  </section>;
}
