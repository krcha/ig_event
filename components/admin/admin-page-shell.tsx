"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { CalendarDays, MapPinned, ShieldCheck, Telescope } from "lucide-react";

type AdminSection = "overview" | "scraper" | "venues";

type AdminPageShellProps = {
  title: string;
  description: string;
  active: AdminSection;
  children: ReactNode;
};

const NAV_ITEMS: Array<{
  id: AdminSection;
  href: string;
  label: string;
  description: string;
  icon: typeof ShieldCheck;
}> = [
  {
    id: "overview",
    href: "/admin",
    label: "Moderation",
    description: "Review extracted events and approve or reject them.",
    icon: ShieldCheck,
  },
  {
    id: "scraper",
    href: "/admin/scraper",
    label: "Scraper",
    description: "Run ingestion jobs, re-output saved posts, and inspect results.",
    icon: Telescope,
  },
  {
    id: "venues",
    href: "/admin/venues",
    label: "Venues",
    description: "Maintain canonical venue names and Instagram handles.",
    icon: MapPinned,
  },
];

export function AdminPageShell(props: AdminPageShellProps) {
  return (
    <main className="app-page app-page-wide">
      <section className="hero-panel relative">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(14,165,233,0.16),_transparent_28%),radial-gradient(circle_at_top_right,_rgba(20,184,166,0.14),_transparent_26%)]" />
        <div className="relative border-b border-border/70 px-5 py-6 sm:px-8 sm:py-7">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
            <div className="max-w-3xl space-y-3">
              <p className="section-kicker">Admin Console</p>
              <h1 className="text-[2.1rem] font-semibold tracking-tight text-foreground sm:text-4xl">
                {props.title}
              </h1>
              <p className="max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base sm:leading-7">
                {props.description}
              </p>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              <Link className="button-secondary w-full gap-2 sm:w-auto" href="/events">
                <CalendarDays className="h-4 w-4" />
                Public events
              </Link>
              <Link className="button-secondary w-full sm:w-auto" href="/calendar">
                Calendar view
              </Link>
            </div>
          </div>
        </div>

        <div className="overflow-x-auto px-5 py-5 sm:px-8 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="flex gap-3 md:grid md:grid-cols-3">
            {NAV_ITEMS.map((item) => {
              const isActive = item.id === props.active;
              const Icon = item.icon;

              return (
                <Link
                  aria-current={isActive ? "page" : undefined}
                  className={
                    isActive
                      ? "glass-panel min-w-[16rem] flex-none border-primary/30 bg-primary/10 px-5 py-5 md:min-w-0"
                      : "glass-panel min-w-[16rem] flex-none px-5 py-5 hover:border-primary/25 hover:bg-card md:min-w-0"
                  }
                  href={item.href}
                  key={item.id}
                >
                  <div className="flex items-center gap-2">
                    <span className={isActive ? "app-chip border-primary/20 bg-primary/12 text-primary" : "app-chip"}>
                      <Icon className="h-4 w-4" />
                      {item.label}
                    </span>
                  </div>
                  <p className="mt-4 text-base font-semibold tracking-tight">{item.label}</p>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.description}</p>
                </Link>
              );
            })}
          </div>
        </div>
      </section>

      {props.children}
    </main>
  );
}
