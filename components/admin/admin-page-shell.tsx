"use client";

import Link from "next/link";
import type { ReactNode } from "react";

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
}> = [
  {
    id: "overview",
    href: "/admin",
    label: "Moderation",
    description: "Review extracted events and approve or reject them.",
  },
  {
    id: "scraper",
    href: "/admin/scraper",
    label: "Scraper",
    description: "Run ingestion jobs, re-output saved posts, and inspect results.",
  },
  {
    id: "venues",
    href: "/admin/venues",
    label: "Venues",
    description: "Maintain canonical venue names and Instagram handles.",
  },
];

export function AdminPageShell(props: AdminPageShellProps) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-6 px-6 py-8">
      <section className="overflow-hidden rounded-3xl border border-border bg-card">
        <div className="border-b border-border bg-[radial-gradient(circle_at_top_left,_rgba(20,184,166,0.14),_transparent_45%),radial-gradient(circle_at_top_right,_rgba(59,130,246,0.14),_transparent_40%)] p-6">
          <div className="max-w-3xl space-y-2">
            <p className="text-xs font-medium uppercase tracking-[0.28em] text-muted-foreground">
              Admin Console
            </p>
            <h1 className="text-3xl font-semibold tracking-tight">{props.title}</h1>
            <p className="text-sm text-muted-foreground">{props.description}</p>
          </div>
        </div>

        <div className="grid gap-3 border-b border-border p-4 md:grid-cols-3">
          {NAV_ITEMS.map((item) => {
            const isActive = item.id === props.active;
            return (
              <Link
                className={`rounded-2xl border p-4 transition ${
                  isActive
                    ? "border-primary bg-primary/10 shadow-sm"
                    : "border-border bg-background/70 hover:border-primary/40 hover:bg-background"
                }`}
                href={item.href}
                key={item.id}
              >
                <p className="text-sm font-semibold">{item.label}</p>
                <p className="mt-1 text-xs text-muted-foreground">{item.description}</p>
              </Link>
            );
          })}
        </div>
      </section>

      {props.children}
    </main>
  );
}
