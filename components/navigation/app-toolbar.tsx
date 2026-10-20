"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType } from "react";
import { useEffect, useState } from "react";
import {
  Bookmark,
  CalendarDays,
  ShieldCheck,
  Sparkles,
  Telescope,
  Warehouse,
} from "lucide-react";
import { EventZekaBrand } from "@/components/brand/event-zeka-brand";
import { ProfileAvatarLink } from "@/components/navigation/profile-avatar-link";
import { useUserLibrary } from "@/components/providers/user-library-provider";
import { cn } from "@/lib/utils";

type ToolbarItem = {
  activePrefixes?: string[];
  badge?: "upcomingSavedEvents";
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  match: "exact" | "prefix";
};

const PUBLIC_TOOLBAR_ITEMS: ToolbarItem[] = [
  {
    href: "/",
    label: "Events",
    icon: CalendarDays,
    match: "exact",
    activePrefixes: ["/calendar", "/events"],
  },
  {
    href: "/discover",
    label: "Discover",
    icon: Sparkles,
    match: "prefix",
  },
  {
    href: "/venues",
    label: "Venues",
    icon: Warehouse,
    match: "prefix",
  },
  {
    href: "/saved",
    label: "Saved",
    icon: Bookmark,
    match: "prefix",
    badge: "upcomingSavedEvents",
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
  if (
    item.activePrefixes?.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    )
  ) {
    return true;
  }

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
  const { upcomingSavedEventCount } = useUserLibrary();
  const [isHidden, setIsHidden] = useState(false);
  const desktopToolbarItems = showAdminNavigation
    ? [...PUBLIC_TOOLBAR_ITEMS, ...ADMIN_TOOLBAR_ITEMS]
    : PUBLIC_TOOLBAR_ITEMS;
  const mobileToolbarItems = showAdminNavigation
    ? [...PUBLIC_TOOLBAR_ITEMS, MOBILE_ADMIN_TOOLBAR_ITEM]
    : PUBLIC_TOOLBAR_ITEMS;
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

  function getBadgeCount(item: ToolbarItem): number {
    return item.badge === "upcomingSavedEvents" ? upcomingSavedEventCount : 0;
  }

  return (
    <>
      <div className="mobile-topbar">
        <div className="glass-panel px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <Link aria-label="Event Zeka home" className="inline-flex min-w-0" href="/">
              <EventZekaBrand compact />
            </Link>
            <ProfileAvatarLink />
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
              <Link aria-label="Event Zeka home" className="inline-flex w-fit" href="/">
                <EventZekaBrand showTagline />
              </Link>
              <div className="flex flex-wrap items-center gap-2 xl:justify-end">
                <nav
                  aria-label="Global"
                  className="flex flex-wrap items-center gap-1.5"
                >
                  {desktopToolbarItems.map((item) => {
                    const Icon = item.icon;
                    const active = isActivePath(pathname, item);
                    const badgeCount = getBadgeCount(item);

                    return (
                      <a
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "inline-flex items-center gap-2 rounded-full border px-3.5 py-2 text-sm font-semibold",
                          active
                            ? "border-primary/30 bg-primary text-primary-foreground shadow-[0_16px_34px_-22px_rgba(14,116,144,0.52)]"
                            : "border-border/75 bg-background/86 text-foreground hover:border-primary/35 hover:bg-card",
                        )}
                        href={item.href}
                        key={item.href}
                        data-global-navigation="document"
                      >
                        <span className="relative inline-flex">
                          <Icon className="h-4 w-4" />
                          {badgeCount > 0 ? (
                            <span className="absolute -right-2.5 -top-2 inline-flex min-w-4 items-center justify-center rounded-full bg-primary-foreground px-1 text-[9px] font-bold leading-4 text-primary shadow-[0_8px_18px_-10px_rgba(139,134,251,0.9)]">
                              {badgeCount > 99 ? "99+" : badgeCount}
                            </span>
                          ) : null}
                        </span>
                        <span>{item.label}</span>
                      </a>
                    );
                  })}
                </nav>
                <ProfileAvatarLink isActive={pathname === "/you"} variant="desktop" />
              </div>
            </div>
          </div>
        </div>
      </header>

      <nav className="mobile-nav-shell" aria-label="Mobile navigation">
        <div className="glass-panel bg-card/95 px-2 py-2 shadow-[0_-18px_48px_-34px_rgba(15,23,42,0.45)]">
          <div className="flex w-full items-center gap-1 overflow-hidden">
            {mobileToolbarItems.map((item) => {
              const Icon = item.icon;
              const active = isActivePath(pathname, item);
              const badgeCount = getBadgeCount(item);

              return (
                <a
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex min-w-0 flex-1 flex-col items-center gap-1 rounded-[1rem] px-2 py-2 text-[11px] font-semibold",
                    active
                      ? "bg-primary text-primary-foreground shadow-[0_16px_34px_-22px_rgba(14,116,144,0.52)]"
                      : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                  )}
                  href={item.href}
                  key={item.href}
                  data-global-navigation="document"
                >
                  <span className="relative inline-flex">
                    <Icon className="h-4 w-4" />
                    {badgeCount > 0 ? (
                      <span
                        className={cn(
                          "absolute -right-3 -top-2 inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-bold leading-4 shadow-[0_8px_18px_-10px_rgba(139,134,251,0.9)]",
                          active
                            ? "bg-primary-foreground text-primary"
                            : "bg-primary text-primary-foreground",
                        )}
                      >
                        {badgeCount > 99 ? "99+" : badgeCount}
                      </span>
                    ) : null}
                  </span>
                  <span className="max-w-full truncate">{item.label}</span>
                </a>
              );
            })}
          </div>
        </div>
      </nav>
    </>
  );
}
