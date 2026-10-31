"use client";

import Link from "next/link";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition, type CSSProperties, type MouseEvent } from "react";
import { getMobileWeekFill } from "@/lib/events/mobile-week";
import type { EventPrimaryCategory } from "@/lib/taxonomy/event-categories";
import styles from "./mobile-week-calendar.module.css";
import { useCalendarOverviewDays } from "./calendar-overview";

export type MobileWeekDay = {
  dayKey: string;
  href: string;
  label: string;
  eventCount: number;
  categoryCounts: Record<EventPrimaryCategory, number>;
  isWeekend: boolean;
  countsPending?: boolean;
};

type Props = {
  days: MobileWeekDay[];
  monthDays: Array<{ dayKey: string; eventCount: number }>;
  selectedDayKey: string;
  todayKey: string;
};

export function MobileWeekCalendar({ days: initialDays, monthDays: initialMonthDays, selectedDayKey, todayKey }: Props) {
  const days = useCalendarOverviewDays(initialDays);
  const monthDays = useCalendarOverviewDays(initialMonthDays);
  const router = useRouter();
  const [, startTransition] = useTransition();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [month, setMonth] = useState(selectedDayKey.slice(0, 7));
  const [isOpen, setIsOpen] = useState(false);
  const maxCount = Math.max(1, ...days.map((day) => day.eventCount));

  useEffect(() => { setMonth(selectedDayKey.slice(0, 7)); }, [selectedDayKey]);
  useEffect(() => {
    if (!isOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [isOpen]);

  function closeCalendar() {
    dialogRef.current?.close();
    setIsOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  }

  function navigate(href: string) {
    const url = new URL(href, window.location.origin);
    const current = new URL(window.location.href);
    // Category chips can update the current URL before new server props arrive.
    const hidden = current.searchParams.get("hide");
    if (hidden) url.searchParams.set("hide", hidden);
    else url.searchParams.delete("hide");
    url.searchParams.delete("category");
    url.searchParams.delete("open");
    if (dialogRef.current?.open) closeCalendar();
    startTransition(() => router.push(`${url.pathname}${url.search}`, { scroll: false }));
  }

  function selectDay(event: MouseEvent<HTMLAnchorElement>, href: string) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    navigate(href);
  }

  function hrefForDate(dayKey: string) {
    const url = new URL(days[0].href, window.location.origin);
    url.searchParams.set("day", dayKey);
    url.searchParams.set("month", dayKey.slice(0, 7));
    return `${url.pathname}${url.search}`;
  }

  const [year, monthNumber] = month.split("-").map(Number);
  const monthDate = new Date(Date.UTC(year, monthNumber - 1, 1, 12));
  const monthLabel = new Intl.DateTimeFormat("sr-Latn-RS", { month: "long", year: "numeric", timeZone: "UTC" }).format(monthDate);
  const monthLength = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const leadingEmptyDays = (monthDate.getUTCDay() + 6) % 7;
  const countByDate = new Map([...monthDays, ...days].map((day) => [day.dayKey, day.eventCount]));

  function moveMonth(offset: number) {
    const date = new Date(Date.UTC(year, monthNumber - 1 + offset, 1, 12));
    setMonth(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`);
  }

  return (
    <div className={styles.weekWrap}>
      <nav aria-label="Izaberi dan" className={styles.week} data-calendar-week="true">
        {days.map((day) => (
          <Link
            aria-current={day.dayKey === selectedDayKey ? "date" : undefined}
            aria-label={`${day.label}, ${Number(day.dayKey.slice(8))}, ${day.eventCount} događaja`}
            className={styles.day}
            data-calendar-date={day.dayKey}
            data-calendar-client-navigation="true"
            data-calendar-date-event-count={day.eventCount}
            data-calendar-date-kind-counts={JSON.stringify(day.categoryCounts)}
            data-calendar-date-selected={day.dayKey === selectedDayKey ? "true" : undefined}
            data-calendar-date-stat-scope="week"
            data-calendar-date-upcoming="true"
            data-calendar-date-weekend={day.isWeekend ? "true" : undefined}
            data-calendar-week-date="true"
            href={day.href}
            key={day.dayKey}
            onClick={(event) => selectDay(event, day.href)}
            prefetch={false}
            scroll={false}
          >
            <span aria-hidden="true" className={styles.water} data-calendar-week-water="true" style={{ "--week-fill": `${getMobileWeekFill(day.eventCount, maxCount)}%` } as CSSProperties} />
            <span className={styles.label}>{day.label}</span>
            <span className={styles.date}>{Number(day.dayKey.slice(8))}</span>
            <span aria-busy={day.countsPending || undefined} className={styles.count} data-calendar-date-visible-event-count="true">{day.countsPending ? "\u00b7" : day.eventCount}</span>
          </Link>
        ))}
      </nav>
      <button
        aria-haspopup="dialog"
        aria-label="Otvori mesečni kalendar"
        className={styles.calendarTrigger}
        onClick={() => { dialogRef.current?.showModal(); setIsOpen(true); }}
        ref={triggerRef}
        type="button"
      ><CalendarDays className="h-[17px] w-[17px]" /></button>
      <dialog
        aria-labelledby={titleId}
        className={styles.dialog}
        onClick={(event) => { if (event.target === event.currentTarget) closeCalendar(); }}
        onClose={() => { setIsOpen(false); }}
        ref={dialogRef}
      >
        <div className={styles.dialogHeader}>
          <h2 className={styles.dialogTitle} id={titleId}>{monthLabel}</h2>
          <div className="flex items-center gap-1">
            <button aria-label="Prethodni mesec" className={styles.iconButton} disabled={month <= todayKey.slice(0, 7)} onClick={() => moveMonth(-1)} type="button"><ChevronLeft className="h-4 w-4" /></button>
            <button aria-label="Sledeći mesec" className={styles.iconButton} onClick={() => moveMonth(1)} type="button"><ChevronRight className="h-4 w-4" /></button>
            <button aria-label="Zatvori kalendar" className={styles.iconButton} onClick={closeCalendar} type="button"><X className="h-4 w-4" /></button>
          </div>
        </div>
        <div className={styles.monthGrid}>
          {["Pon", "Uto", "Sre", "Čet", "Pet", "Sub", "Ned"].map((label) => <span className={styles.weekday} key={label}>{label}</span>)}
          {Array.from({ length: leadingEmptyDays }, (_, index) => <span aria-hidden="true" key={`empty-${index}`} />)}
          {Array.from({ length: monthLength }, (_, index) => {
            const dayKey = `${month}-${String(index + 1).padStart(2, "0")}`;
            return <button aria-current={dayKey === selectedDayKey ? "date" : undefined} aria-label={dayKey} className={styles.monthDay} disabled={dayKey < todayKey} key={dayKey} onClick={() => navigate(hrefForDate(dayKey))} type="button"><span>{index + 1}</span>{countByDate.has(dayKey) ? <small>{countByDate.get(dayKey)}</small> : null}</button>;
          })}
        </div>
      </dialog>
    </div>
  );
}
