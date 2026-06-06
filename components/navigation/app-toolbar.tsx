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

const PUBLIC_TOOLBAR_ITEMS: ToolbarItem[] = [
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
];

const ADMIN_TOOLBAR_ITEMS: ToolbarItem[] = [
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

const MOBILE_ADMIN_TOOLBAR_ITEM: ToolbarItem = {
  href: "/admin",
  label: "Admin",
  icon: ShieldCheck,
  match: "prefix",
};

function isActivePath(pathname: string, item: ToolbarItem): boolean {
  if (item.match === "exact") {
    return pathname === item.href;
  }
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

function isAuthRoute(pathname: string): boolean {
  return pathname.startsWith("/sign-in") || pathname.startsWith("/sign-up");
}

type AppToolbarProps = {
  showAdminNavigation?: boolean;
};

export function AppToolbar({ showAdminNavigation = false }: AppToolbarProps) {
  const pathname = usePathname();
  const [isHidden, setIsHidden] = useState(false);
  const desktopToolbarItems = showAdminNavigation
    ? [...PUBLIC_TOOLBAR_ITEMS, ...ADMIN_TOOLBAR_ITEMS]
    : PUBLIC_TOOLBAR_ITEMS;
  const mobileToolbarItems = showAdminNavigation
    ? [...PUBLIC_TOOLBAR_ITEMS, MOBILE_ADMIN_TOOLBAR_ITEM]
    : PUBLIC_TOOLBAR_ITEMS;
  const currentSectionLabel =
    desktopToolbarItems.find((item) => isActivePath(pathname ?? "", item))?.label ?? "Explore";

  useEffect(() => {
    let lastScrollY = window.scrollY;

    function handleScroll() {
      const currentScrollY = window.scrollY;

      if (currentScrollY <= 24) {
        setIsHidden(false);
      } else if (currentScrollY > lastScrollY && currentScrollY > 120) {
        setIsHidden(true);
      } else if (currentScrollY < lastScrollY - 10) {
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
    <>
      <div className="mobile-topbar">
        <div className="glass-panel px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <Link className="inline-flex min-w-0 items-center gap-2" href="/">
              <span className="inline-flex h-9 items-center rounded-full bg-primary px-3 text-xs font-semibold text-primary-foreground">
                Belgrade nights
              </span>
            </Link>
            <span className="app-chip shrink-0 bg-card/95">{currentSectionLabel}</span>
          </div>
        </div>
      </div>

      <header
        className={cn(
          "sticky top-0 z-40 hidden px-4 pt-4 transition duration-300 md:block lg:px-8",
          isHidden && "-translate-y-[calc(100%+1rem)] opacity-0",
        )}
      >
        <div className="mx-auto w-full max-w-[88rem]">
          <div className="glass-panel px-4 py-3">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
              <Link className="inline-flex w-fit items-center gap-2" href="/">
                <span className="inline-flex h-9 items-center rounded-full bg-primary px-3.5 text-sm font-semibold text-primary-foreground shadow-[0_16px_34px_-22px_rgba(14,116,144,0.5)]">
                  Belgrade nights
                </span>
                <span className="hidden text-sm font-medium text-muted-foreground lg:inline">
                  night plans, live
                </span>
              </Link>
              <nav
                aria-label="Global"
                className="flex flex-wrap items-center gap-1.5 xl:justify-end"
              >
                {desktopToolbarItems.map((item) => {
                  const Icon = item.icon;
                  const active = isActivePath(pathname, item);

                  return (
                    <Link
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "inline-flex items-center gap-2 rounded-full border px-3.5 py-2 text-sm font-semibold",
                        active
                          ? "border-primary/30 bg-primary text-primary-foreground shadow-[0_16px_34px_-22px_rgba(14,116,144,0.52)]"
                          : "border-border/75 bg-background/86 text-foreground hover:border-primary/35 hover:bg-card",
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

      <nav className="mobile-nav-shell" aria-label="Mobile navigation">
        <div className="glass-panel bg-card/95 px-2 py-2 shadow-[0_-18px_48px_-34px_rgba(15,23,42,0.45)]">
          <div className="flex items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {mobileToolbarItems.map((item) => {
              const Icon = item.icon;
              const active = isActivePath(pathname, item);

              return (
                <Link
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex min-w-[4.7rem] flex-1 flex-col items-center gap-1 rounded-[1rem] px-3 py-2 text-[11px] font-semibold",
                    active
                      ? "bg-primary text-primary-foreground shadow-[0_16px_34px_-22px_rgba(14,116,144,0.52)]"
                      : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                  )}
                  href={item.href}
                  key={item.href}
                >
                  <Icon className="h-4 w-4" />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        </div>
      </nav>
    </>
  );
}
