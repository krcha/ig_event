"use client";

import { useId, useState } from "react";
import type { AnalyticsPoint, AnalyticsRow } from "@/lib/analytics/model";
import styles from "./analytics.module.css";

const number = new Intl.NumberFormat("en-GB");
const colors = ["#a59bff", "#63b8d2", "#67c8a5", "#e3b56f", "#df91b3", "#8d99ae"];

export function TrafficChart({ points, label, activity = false }: { points: AnalyticsPoint[]; label: string; activity?: boolean }) {
  const id = useId().replace(/:/g, "");
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(4, ...points.map((point) => Math.max(point.views, point.clicks)));
  const ceiling = Math.ceil(max / 4) * 4;
  const width = 900;
  const height = activity ? 135 : 205;
  const left = 43;
  const bottom = height - 23;
  const x = (index: number) => points.length === 1 ? (left + width - 12) / 2 : left + (width - left - 12) * index / Math.max(1, points.length - 1);
  const y = (value: number) => bottom - (bottom - 10) * value / ceiling;
  const line = (kind: "views" | "clicks") => points.map((point, index) => `${x(index)},${y(point[kind])}`).join(" ");
  const pointLabel = (key: string) => {
    if (activity) return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Belgrade", hour: "2-digit", minute: "2-digit" }).format(Number(key));
    if (key.includes(" ")) return key.slice(11);
    const date = new Date(`${key.length === 7 ? `${key}-01` : key}T12:00:00Z`);
    return new Intl.DateTimeFormat("en-GB", key.length === 7 ? { month: "short", year: "2-digit" } : { day: "numeric", month: "short" }).format(date);
  };
  const selected = hover === null ? null : points[hover];
  return (
    <div className={styles.chart}>
      <svg aria-label={label} role="img" viewBox={`0 0 ${width} ${height}`} className={activity ? styles.activityChart : styles.trendChart} onMouseLeave={() => setHover(null)}>
        <title>{label}</title>
        <defs>
          <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#a59bff" stopOpacity="0.16" />
            <stop offset="100%" stopColor="#a59bff" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3, 4].map((step) => (
          <g key={step}>
            <line x1={left} x2={width - 12} y1={y(ceiling * step / 4)} y2={y(ceiling * step / 4)} stroke="currentColor" strokeOpacity="0.14" strokeDasharray="2 5" />
            <text x={left - 9} y={y(ceiling * step / 4) + 4} textAnchor="end" className={styles.axis}>{number.format(ceiling * step / 4)}</text>
          </g>
        ))}
        {points.length > 1 && <>
          <polygon points={`${left},${bottom} ${line("views")} ${x(points.length - 1)},${bottom}`} fill={`url(#${id}-fill)`} />
          <polyline points={line("views")} fill="none" stroke={colors[0]} strokeWidth="2.25" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          <polyline points={line("clicks")} fill="none" stroke={colors[1]} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        </>}
        {points.length === 1 && <>
          <circle cx={x(0)} cy={y(points[0].views)} r="4" fill={colors[0]} />
          <circle cx={x(0)} cy={y(points[0].clicks)} r="3.5" fill={colors[1]} />
        </>}
        {points.map((point, index) => {
          const spacing = (width - left - 12) / Math.max(1, points.length - 1);
          const showLabel = index === 0 || index === points.length - 1 || (index % Math.max(1, Math.ceil(points.length / 6)) === 0 && index < points.length - Math.ceil(points.length / 12));
          return (
            <g key={point.key}>
              {showLabel && <text x={x(index)} y={height - 3} textAnchor={index === points.length - 1 ? "end" : index === 0 ? "start" : "middle"} className={styles.axis}>{pointLabel(point.key)}</text>}
              <rect x={Math.max(left, x(index) - spacing / 2)} y="0" width={Math.max(2, spacing)} height={bottom + 2} fill="transparent" onMouseEnter={() => setHover(index)} onFocus={() => setHover(index)} onBlur={() => setHover(null)} tabIndex={index === 0 ? 0 : -1} role="button" aria-label={`${point.key}: ${point.views} views, ${point.clicks} clicks`} onKeyDown={(event) => {
                if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                  event.preventDefault();
                  setHover(Math.max(0, Math.min(points.length - 1, (hover ?? 0) + (event.key === "ArrowRight" ? 1 : -1))));
                }
              }} />
            </g>
          );
        })}
        {hover !== null && points[hover] && <>
          <line x1={x(hover)} x2={x(hover)} y1="6" y2={bottom} stroke={colors[0]} strokeOpacity="0.4" />
          <circle cx={x(hover)} cy={y(points[hover].views)} r="4" fill={colors[0]} />
          <circle cx={x(hover)} cy={y(points[hover].clicks)} r="3.5" fill={colors[1]} />
        </>}
      </svg>
      {selected && <div className={styles.chartTooltip} role="status"><strong>{activity ? pointLabel(selected.key) : selected.key}</strong><span>{number.format(selected.views)} views · {number.format(selected.clicks)} clicks</span></div>}
      <div className={styles.legend}><span><i style={{ background: colors[0] }} />Views</span><span><i style={{ background: colors[1] }} />Clicks</span></div>
    </div>
  );
}

export function DeviceBreakdown({ title, rows, total }: { title: string; rows: AnalyticsRow[]; total: number }) {
  let offset = 0;
  const items = rows.slice(0, 5);
  if (rows.length > 5) items.push({ name: "Other", views: rows.slice(5).reduce((sum, row) => sum + row.views, 0), clicks: 0, visitors: 0 });
  return (
    <div className={styles.deviceBlock}>
      <h3>{title}</h3>
      <div className={styles.donut}>
        <svg viewBox="0 0 120 120" role="img" aria-label={`${title}: ${rows.map((row) => `${row.name} ${row.views} views`).join(", ") || "No visits yet"}`}>
          <circle cx="60" cy="60" r="45" fill="none" stroke="var(--border)" strokeWidth="13" />
          {items.map((row, index) => {
            const share = total ? row.views / total * 100 : 0;
            const start = offset;
            offset += share;
            return <circle key={row.name} cx="60" cy="60" r="45" fill="none" stroke={colors[index]} strokeWidth="13" pathLength="100" strokeDasharray={`${share} ${100 - share}`} strokeDashoffset={-start} transform="rotate(-90 60 60)" />;
          })}
        </svg>
        <div><strong>{number.format(total)}</strong><span>views</span></div>
      </div>
      <ul className={styles.deviceList}>
        {items.length ? items.map((row, index) => <li key={row.name}><span><i style={{ background: colors[index] }} />{row.name}</span><span>{number.format(row.views)}<small>{total ? (row.views / total * 100).toFixed(1) : "0"}%</small></span></li>) : <li className={styles.muted}>No device data yet</li>}
      </ul>
    </div>
  );
}
