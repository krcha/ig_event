"use client";

import { useEffect, useId, useRef } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import styles from "./mobile-week-calendar.module.css";

type Props = {
  month: string;
  selectedDayKey: string;
  todayKey: string;
  counts: Array<{ dayKey: string; eventCount: number }>;
  onMonthChange: (month: string) => void;
  onSelect: (day: string) => void;
  onClose: () => void;
};

/** This module and its month grid are loaded only when the picker is opened. */
export default function MobileCalendarDialog({ month, selectedDayKey, todayKey, counts, onMonthChange, onSelect, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog?.showModal();
    return () => { dialog?.close(); document.body.style.overflow = previous; };
  }, []);
  const [year, monthNumber] = month.split("-").map(Number);
  const monthDate = new Date(Date.UTC(year, monthNumber - 1, 1, 12));
  const monthLabel = new Intl.DateTimeFormat("sr-Latn-RS", { month: "long", year: "numeric", timeZone: "UTC" }).format(monthDate);
  const monthLength = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const leadingEmptyDays = (monthDate.getUTCDay() + 6) % 7;
  const countByDate = new Map(counts.map(day => [day.dayKey, day.eventCount]));
  function moveMonth(offset: number) {
    const date = new Date(Date.UTC(year, monthNumber - 1 + offset, 1, 12));
    onMonthChange(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  function closeDialog() { dialogRef.current?.close(); onClose(); }
  return <dialog aria-labelledby={titleId} className={styles.dialog} ref={dialogRef}
    onCancel={event => { event.preventDefault(); closeDialog(); }}
    onClick={event => { if (event.target === event.currentTarget) closeDialog(); }}>
    <div className={styles.dialogHeader}>
      <h2 className={styles.dialogTitle} id={titleId}>{monthLabel}</h2>
      <div className="flex items-center gap-1">
        <button aria-label="Prethodni mesec" className={styles.iconButton} disabled={month <= todayKey.slice(0, 7)} onClick={() => moveMonth(-1)} type="button"><ChevronLeft className="h-4 w-4" /></button>
        <button aria-label="Sledeći mesec" className={styles.iconButton} onClick={() => moveMonth(1)} type="button"><ChevronRight className="h-4 w-4" /></button>
        <button aria-label="Zatvori kalendar" className={styles.iconButton} onClick={closeDialog} type="button"><X className="h-4 w-4" /></button>
      </div>
    </div>
    <div className={styles.monthGrid}>
      {["Pon", "Uto", "Sre", "Čet", "Pet", "Sub", "Ned"].map(label => <span className={styles.weekday} key={label}>{label}</span>)}
      {Array.from({ length: leadingEmptyDays }, (_, index) => <span aria-hidden="true" key={`empty-${index}`} />)}
      {Array.from({ length: monthLength }, (_, index) => {
        const dayKey = `${month}-${String(index + 1).padStart(2, "0")}`;
        return <button aria-current={dayKey === selectedDayKey ? "date" : undefined} aria-label={dayKey} className={styles.monthDay} disabled={dayKey < todayKey} key={dayKey} onClick={() => { dialogRef.current?.close(); onSelect(dayKey); }} type="button"><span>{index + 1}</span>{countByDate.has(dayKey) ? <small>{countByDate.get(dayKey)}</small> : null}</button>;
      })}
    </div>
  </dialog>;
}
