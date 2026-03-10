"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType } from "react";
import { useEffect, useState } from "react";
import { CalendarDays, Compass, House, ShieldCheck, Telescope, Warehouse } from "lucide-react";
import { cn } from "@/lib/utils";

type ToolbarItem = {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  match: "exact" | "prefix";
};

const TOOLBAR_ITEMS: ToolbarItem[] = [
  {
    href: "/",
    label: "Home",
    icon: House,
    match: "exact",
  },
  {
    href: "/events",
    label: "Events",
    icon: Compass,
    match: "prefix",
  },
  {
    href: "/calendar",
    label: "Calendar",
    icon: CalendarDays,
    match: "prefix",
  },
  {
    href: "/admin",
    label: "Moderation",
    icon: ShieldCheck,
    match: "exact",
  },
  {
    href: "/admin/scraper",
    label: "Scraper",
    icon: Telescope,
    match: "prefix",
  },
  {
    href: "/admin/venues",
    label: "Venues",
    icon: Warehouse,
    match: "prefix",
  },
];

function isActivePath(pathname: string, item: ToolbarItem): boolean {
  if (item.match === "exact") {
    return pathname === item.href;
  }
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

function isAuthRoute(pathname: string): boolean {
  return pathname.startsWith("/sign-in") || pathname.startsWith("/sign-up");
}

export function AppToolbar() {
  const pathname = usePathname();
  const [isHidden, setIsHidden] = useState(false);

  useEffect(() => {
    let lastScrollY = window.scrollY;

    function handleScroll() {
      const currentScrollY = window.scrollY;

      if (currentScrollY <= 24) {
        setIsHidden(false);
      } else if (currentScrollY > lastScrollY && currentScrollY > 96) {
        setIsHidden(true);
      } else if (currentScrollY < lastScrollY - 8) {
        setIsHidden(false);
      }

      lastScrollY = currentScrollY;
    }

    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  if (!pathname || isAuthRoute(pathname)) {
    return null;
  }

  return (
    <header
      className={cn(
        "sticky top-0 z-40 px-4 pt-3 transition duration-300 sm:px-6 lg:px-8",
        isHidden && "-translate-y-[calc(100%+1rem)] opacity-0",
      )}
    >
      <div className="mx-auto w-full max-w-7xl">
        <div className="hero-panel relative px-4 py-3 sm:px-5">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(56,189,248,0.18),_transparent_26%),radial-gradient(circle_at_top_right,_rgba(99,102,241,0.18),_transparent_28%)]" />
          <div className="relative flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <Link className="inline-flex items-center gap-2" href="/">
              <span className="app-chip border-primary/20 bg-primary/8 text-primary">
                Belgrade nightlife
              </span>
            </Link>
            <nav
              aria-label="Global"
              className="flex flex-wrap items-center gap-1.5 lg:justify-end"
            >
              {TOOLBAR_ITEMS.map((item) => {
                const Icon = item.icon;
                const active = isActivePath(pathname, item);

                return (
                  <Link
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "inline-flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-semibold sm:px-3.5 sm:text-sm",
                      active
                        ? "border-primary/30 bg-primary text-primary-foreground shadow-[0_16px_34px_-20px_rgba(79,70,229,0.75)]"
                        : "border-border/80 bg-background/82 text-foreground hover:border-primary/30 hover:bg-card",
                    )}
                    href={item.href}
                    key={item.href}
                  >
                    <Icon className="h-4 w-4" />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </nav>
          </div>
        </div>
      </div>
    </header>
  );
}
