"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";

const EventsUiContext = createContext<{ filtersOpen: boolean; setFiltersOpen: (open: boolean) => void } | null>(null);

/** Disclosure survives a selected-day loading boundary, but starts closed on a new visit. */
export function EventsUiProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [filtersOpen, setFiltersOpen] = useState(false);
  useEffect(() => { if (!["/", "/calendar", "/events"].includes(pathname ?? "")) setFiltersOpen(false); }, [pathname]);
  return <EventsUiContext.Provider value={{ filtersOpen, setFiltersOpen }}>{children}</EventsUiContext.Provider>;
}

export function useEventsUi() {
  const context = useContext(EventsUiContext);
  if (!context) throw new Error("Events controls require their UI provider.");
  return context;
}
