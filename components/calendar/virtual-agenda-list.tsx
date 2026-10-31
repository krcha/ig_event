"use client";

import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { Fragment, useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { virtualListRange } from "@/lib/events/virtual-list-range";
import { useCalendarEventPreview } from "./calendar-event-preview";

type Props<T> = {
  children: (item: T) => ReactNode;
  estimateSize?: number;
  getKey: (item: T) => string;
  containsEvent?: (item: T, eventId: string) => boolean;
  items: readonly T[];
};

/** Window scrolling, measured expanding rows, bounded SSR, and retained focus. */
export function VirtualAgendaList<T>({ children, items, getKey, containsEvent, estimateSize = 80 }: Props<T>) {
  const element = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const { activeId } = useCalendarEventPreview();
  const virtual = items.length > 20;
  const keys = useMemo(() => items.map(getKey), [getKey, items]);
  const focusedIndex = focusedKey === null ? -1 : keys.indexOf(focusedKey);
  const previewIndex = activeId === null ? -1 : items.findIndex((item, i) => containsEvent ? containsEvent(item, activeId) : keys[i] === activeId);
  const rangeExtractor = useCallback((range: Parameters<typeof virtualListRange>[0]) => virtualListRange(range, [focusedIndex, previewIndex]), [focusedIndex, previewIndex]);
  const getItemKey = useCallback((index: number) => keys[index], [keys]);
  const estimate = useCallback(() => estimateSize, [estimateSize]);
  const list = useWindowVirtualizer<HTMLDivElement>({
    count: items.length, enabled: virtual, estimateSize: estimate, getItemKey,
    gap: 6, overscan: 4, scrollMargin, rangeExtractor,
    initialRect: { width: 0, height: 400 }, useAnimationFrameWithResizeObserver: true,
  });
  const previousPreview = useRef<string | null>(null);
  useLayoutEffect(() => {
    const previous = previousPreview.current;
    const current = previewIndex >= 0 ? keys[previewIndex] : null;
    previousPreview.current = current;
    if (!virtual || !previous || previous === current) return;
    const index = keys.indexOf(previous);
    if (index < 0) return;
    const mounted = element.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    // An offscreen closed preview may unmount before ResizeObserver sees it.
    // Discard its expanded measurement so it cannot leave a large empty gap.
    list.resizeItem(index, mounted?.getBoundingClientRect().height ?? estimateSize);
  }, [estimateSize, keys, list, previewIndex, virtual]);

  useLayoutEffect(() => {
    if (!virtual) return;
    const update = () => {
      if (!element.current) return;
      const top = element.current.getBoundingClientRect().top + window.scrollY;
      setScrollMargin(previous => Math.abs(previous - top) > 0.5 ? top : previous);
    };
    update();
    const observer = new ResizeObserver(update);
    const scope = element.current?.closest("[data-calendar-agenda-scope]");
    if (scope) observer.observe(scope);
    window.addEventListener("resize", update, { passive: true });
    return () => { observer.disconnect(); window.removeEventListener("resize", update); };
  }, [virtual]);

  if (!virtual) return <div className="space-y-1.5">{items.map((item, i) => <Fragment key={keys[i]}>{children(item)}</Fragment>)}</div>;
  const rows = list.getVirtualItems();
  return <div
    data-calendar-virtual-list="true"
    data-calendar-total-items={items.length}
    data-calendar-mounted-items={rows.length}
    onFocusCapture={event => {
      const row = (event.target as HTMLElement).closest<HTMLElement>("[data-virtual-key]");
      if (row) setFocusedKey(row.dataset.virtualKey ?? null);
    }}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedKey(null); }}
    ref={element}
    role="list"
    style={{ height: list.getTotalSize(), position: "relative", overflowAnchor: "none" }}
  >{rows.map(row => <div
    aria-posinset={row.index + 1}
    aria-setsize={items.length}
    data-index={row.index}
    data-virtual-key={keys[row.index]}
    key={row.key}
    ref={list.measureElement}
    role="listitem"
    style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${row.start - scrollMargin}px)` }}
  >{children(items[row.index])}</div>)}</div>;
}
