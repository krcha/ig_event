"use client";

import { useEffect, useId, useState } from "react";
import { Activity, ArrowDownToLine, ArrowDownRight, ArrowUpRight, CalendarDays, Globe2, LockKeyhole, MonitorSmartphone, MousePointer2, RefreshCw } from "lucide-react";
import { DeviceBreakdown, TrafficChart } from "./analytics-charts";
import { AnalyticsWorldMap } from "./analytics-world-map";
import { getAnalyticsRange, localDay, shiftDay, type AnalyticsGroup, type AnalyticsReport, type AnalyticsRow } from "@/lib/analytics/model";
import styles from "./analytics.module.css";

const number = new Intl.NumberFormat("en-GB");
type Range = { start: string; end: string };
function presetRange(preset: string): Range {
  const today = localDay(Date.now());
  return {
    start: preset === "today" ? today : preset === "7d" ? shiftDay(today, -6) : preset === "30d" ? shiftDay(today, -29) : preset === "year" ? `${today.slice(0, 4)}-01-01` : `${today.slice(0, 7)}-01`,
    end: today,
  };
}

function Change({ value, previous }: { value: number; previous: number }) {
  if (!previous) return <span className={styles.comparison}>No previous data</span>;
  const change = (value - previous) / previous * 100;
  const Icon = change >= 0 ? ArrowUpRight : ArrowDownRight;
  return <span className={styles.comparison}><Icon aria-hidden="true" size={13} />{change >= 0 ? "+" : ""}{change.toFixed(1)}% vs previous period</span>;
}

function DataTable({ title, rows, metric = "views", total, firstColumn, showClicks = false }: { title: string; rows: AnalyticsRow[]; metric?: "views" | "clicks"; total: number; firstColumn: string; showClicks?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const items = expanded ? rows : rows.slice(0, 8);
  return (
    <section className={styles.panel} aria-labelledby={id}>
      <div className={styles.panelHeading}><h2 id={id}>{title}</h2><span>{number.format(rows.length)} {firstColumn.toLowerCase()}</span></div>
      <div className={styles.tableScroll}>
        <table className={styles.table}>
          <thead><tr><th scope="col">{firstColumn}</th><th scope="col">{metric === "views" ? "Views" : "Clicks"}</th>{showClicks && <th scope="col">Clicks</th>}<th scope="col">Unique</th><th scope="col">Share</th></tr></thead>
          <tbody>{items.map((row) => <tr key={row.name}><th scope="row" title={row.name}>{row.name}</th><td>{number.format(row[metric])}</td>{showClicks && <td>{number.format(row.clicks)}</td>}<td>{number.format(row.visitors)}</td><td>{total ? (row[metric] / total * 100).toFixed(1) : "0"}%</td></tr>)}</tbody>
        </table>
        {!items.length && <p className={styles.tableEmpty}>Data will appear after the first {metric === "views" ? "visit" : "click"}.</p>}
      </div>
      {rows.length > 8 && <button className={styles.showMore} onClick={() => setExpanded(!expanded)}>{expanded ? "Show fewer" : `Show all ${number.format(rows.length)}`}</button>}
    </section>
  );
}

function exportReport(report: AnalyticsReport) {
  const cell = (value: string | number) => `"${String(value).replace(/"/g, '""').replace(/^[=+@\-\t\r]/, "'$&")}"`;
  const rows: Array<Array<string | number>> = [["Period", report.start, report.end], ["Timezone", report.timezone], ["Metric", "Value"], ...Object.entries(report.totals), [], ["Period", "Views", "Clicks", "Visitors"], ...report.series.map((point) => [point.key, point.views, point.clicks, point.visitors])];
  for (const [section, values] of [["Countries", report.countries], ["Devices", report.devices], ["Browsers", report.browsers], ["Operating systems", report.operatingSystems], ["Sources", report.sources], ["Pages", report.pages], ["Buttons", report.buttons]] as const) {
    rows.push([], [section, "Views", "Clicks", "Unique"], ...values.map((row) => [row.name, row.views, row.clicks, row.visitors]));
  }
  const url = URL.createObjectURL(new Blob(["\ufeff", rows.map((row) => row.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url; link.download = `eventzeka-analytics-${report.start}-${report.end}.csv`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function AnalyticsDashboard() {
  const [preset, setPreset] = useState("month");
  const [range, setRange] = useState<Range>(() => presetRange("month"));
  const [draft, setDraft] = useState(range);
  const [group, setGroup] = useState<AnalyticsGroup>("day");
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [error, setError] = useState("");
  const [rangeError, setRangeError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const today = localDay(Date.now());

  useEffect(() => {
    if (preset === "custom") return;
    const updateDate = () => {
      const next = presetRange(preset);
      if (range.start === next.start && range.end === next.end) return;
      setRange(next);
      setDraft(next);
      if ((Date.parse(next.end) - Date.parse(next.start)) / 86_400_000 >= 14) setGroup((currentGroup) => currentGroup === "hour" ? "day" : currentGroup);
    };
    const interval = setInterval(updateDate, 60_000);
    return () => clearInterval(interval);
  }, [preset, range.start, range.end]);

  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    setReport(null);
    const load = async () => {
      if (inFlight || controller.signal.aborted) return;
      inFlight = true;
      setLoading(true); setError("");
      try {
        const response = await fetch(`/api/admin/analytics?${new URLSearchParams({ ...range, group })}`, { signal: controller.signal, cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Analytics could not be loaded. Please try again.");
        if (!controller.signal.aborted) setReport(data);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Analytics could not be loaded.");
      } finally {
        inFlight = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    const interval = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 60_000);
    return () => { controller.abort(); clearInterval(interval); };
  }, [range, group, refresh]);

  function applyRange(next: Range) {
    try {
      const valid = getAnalyticsRange(next.start, next.end, group === "hour" ? "day" : group);
      if (group === "hour" && valid.days > 14) setGroup("day");
      setRange(next); setDraft(next); setRangeError("");
    } catch (failure) { setRangeError(failure instanceof Error ? failure.message : "Choose a valid date range."); }
  }
  const totals = report?.totals;
  const countries = report?.countries ?? [];
  const located = countries.filter((row) => row.name !== "Unknown").reduce((sum, row) => sum + row.views, 0);
  const countryName = (code: string) => {
    if (code === "Unknown") return "Unknown location";
    try { return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code; } catch { return code; }
  };
  const hourlyAllowed = (Date.parse(range.end) - Date.parse(range.start)) / 86_400_000 < 14;

  return (
    <div className={styles.dashboard}>
      <div className={styles.intro}>
        <p>Understand who visits Event Zeka and how they find it.</p>
        <span className={styles.private}><LockKeyhole size={13} aria-hidden="true" />Only you can view this</span>
      </div>
      <div className={styles.toolbar}>
        <div className={styles.presets} aria-label="Date range presets">
          {[["today", "Today"], ["7d", "7 days"], ["30d", "30 days"], ["month", "This month"], ["year", "This year"]].map(([value, label]) => <button key={value} aria-pressed={preset === value} onClick={() => { setPreset(value); applyRange(presetRange(value)); }}>{label}</button>)}
        </div>
        <div className={styles.actions}>
          <button aria-label="Refresh analytics" title="Refresh analytics" className={styles.iconButton} disabled={loading} onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={16} aria-hidden="true" className={loading ? styles.spin : ""} /></button>
          <button className={styles.export} disabled={!report || loading || Boolean(error)} onClick={() => report && exportReport(report)}><ArrowDownToLine size={15} aria-hidden="true" />Export CSV</button>
        </div>
      </div>
      <form className={styles.dateForm} onSubmit={(event) => { event.preventDefault(); setPreset("custom"); applyRange(draft); }}>
        <CalendarDays size={15} aria-hidden="true" />
        <label>From<input type="date" required aria-describedby={rangeError ? "analytics-range-error" : undefined} max={draft.end || today} value={draft.start} onChange={(event) => setDraft({ ...draft, start: event.target.value })} /></label>
        <label>To<input type="date" required min={draft.start} max={today} value={draft.end} onChange={(event) => setDraft({ ...draft, end: event.target.value })} /></label>
        <button type="submit">Apply</button>
        <span className={styles.timezone}>Europe/Belgrade</span>
      </form>
      {rangeError && <p id="analytics-range-error" className={styles.error} role="alert">{rangeError}</p>}
      {error && <div className={styles.error} role="alert"><span>{error}</span><button onClick={() => setRefresh((value) => value + 1)}>Try again</button></div>}
      {!report && loading && <div className={styles.loading} role="status"><RefreshCw size={20} className={styles.spin} />Loading visitor analytics…</div>}
      {report && totals && <>
        <section className={styles.metrics} aria-label="Traffic summary">
          <div><span>Unique visitors</span><strong>{number.format(totals.visitors)}</strong><Change value={totals.visitors} previous={report.previous.visitors} /></div>
          <div><span>Page views</span><strong>{number.format(totals.views)}</strong><Change value={totals.views} previous={report.previous.views} /></div>
          <div><span>Total clicks</span><strong>{number.format(totals.clicks)}</strong><Change value={totals.clicks} previous={report.previous.clicks} /></div>
          <div><span>Visitor click rate</span><strong>{totals.conversion.toFixed(1)}<small>%</small></strong><span className={styles.comparison}>{number.format(totals.clickers)} visitors clicked · {number.format(totals.sessions)} sessions</span></div>
        </section>
        {totals.views === 0 && <div className={styles.empty}><Activity size={20} aria-hidden="true" /><div><strong>No visits recorded in this period</strong><p>New public page visits will appear here automatically. Tracking starts when analytics is deployed.</p></div></div>}
        <section className={styles.panel}>
          <div className={styles.panelHeading}><h2><Activity size={16} aria-hidden="true" />Activity <span>Last hour</span></h2><span className={styles.live}><i />{number.format(report.activeVisitors)} active in the last 5 min</span></div>
          <div className={styles.activityStats}><div><span>Total activity</span><strong>{number.format(report.activity.reduce((sum, point) => sum + point.views + point.clicks, 0))}</strong></div><div><span>Views</span><strong>{number.format(report.activity.reduce((sum, point) => sum + point.views, 0))}</strong></div><div><span>Clicks</span><strong>{number.format(report.activity.reduce((sum, point) => sum + point.clicks, 0))}</strong></div></div>
          <TrafficChart activity points={report.activity} label="Views and clicks in five-minute intervals over the last hour" />
        </section>
        <section className={styles.panel}>
          <div className={styles.panelHeading}><div><h2>Traffic overview</h2><p>{range.start} — {range.end} · Views and clicks</p></div><label className={styles.groupSelect}>Group by<select value={group} onChange={(event) => setGroup(event.target.value as AnalyticsGroup)}><option value="hour" disabled={!hourlyAllowed}>Hourly</option><option value="day">Daily</option><option value="month">Monthly</option></select></label></div>
          <TrafficChart points={report.series} label={`${group === "hour" ? "Hourly" : group === "month" ? "Monthly" : "Daily"} views and clicks from ${range.start} to ${range.end}`} />
          {!hourlyAllowed && <p className={styles.footnote}>Hourly detail is available for ranges up to 14 days.</p>}
        </section>
        <div className={styles.geoGrid}>
          <section className={styles.panel}><div className={styles.panelHeading}><h2><Globe2 size={16} aria-hidden="true" />Geographic distribution</h2><span>{totals.views ? (located / totals.views * 100).toFixed(0) : "0"}% of views located</span></div><AnalyticsWorldMap countries={countries} /><p className={styles.footnote}>Approximate country from the visitor connection. Unknown locations remain in the totals.</p></section>
          <section className={styles.panel}><div className={styles.panelHeading}><h2>Top countries</h2><span>By views</span></div><ol className={styles.countries}>{countries.slice(0, 7).map((row) => <li key={row.name}><div><span>{countryName(row.name)}</span><span>{number.format(row.views)}<small>{totals.views ? (row.views / totals.views * 100).toFixed(1) : "0"}%</small></span></div><div className={styles.track}><div style={{ width: `${totals.views ? row.views / totals.views * 100 : 0}%` }} /></div></li>)}</ol>{!countries.length && <p className={styles.tableEmpty}>Countries will appear after the first visit.</p>}</section>
        </div>
        <section className={styles.panel}><div className={styles.panelHeading}><h2><MonitorSmartphone size={16} aria-hidden="true" />Devices & browsers</h2><span>By page views</span></div><div className={styles.devices}><DeviceBreakdown title="Device type" rows={report.devices} total={totals.views} /><DeviceBreakdown title="Browsers" rows={report.browsers} total={totals.views} /><DeviceBreakdown title="Operating systems" rows={report.operatingSystems} total={totals.views} /></div><p className={styles.footnote}>Estimated from browser information. Unique visitors are counted once across the selected period.</p></section>
        <div className={styles.tablesGrid}><DataTable title="Traffic sources" rows={report.sources} total={totals.views} firstColumn="Source / campaign" showClicks /><DataTable title="Top pages" rows={report.pages} total={totals.views} firstColumn="Page" showClicks /></div>
        <DataTable title="Link & button performance" rows={report.buttons} metric="clicks" total={totals.clicks} firstColumn="Link / button" />
        <footer className={styles.footer}><span><MousePointer2 size={13} aria-hidden="true" />Visitor statistics · 400-day retention</span><span aria-live="polite">{loading ? "Refreshing…" : `Updated ${new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Belgrade", hour: "2-digit", minute: "2-digit" }).format(report.generatedAt)} · refreshes every minute`}</span></footer>
      </>}
    </div>
  );
}
