import Link from "next/link";
import { ArrowRight, CalendarDays, ShieldCheck, Sparkles } from "lucide-react";
import { isViewerAdmin } from "@/lib/auth/admin";

const HOME_ACTIONS = [
  {
    href: "/events",
    label: "Browse events",
    description: "Scan the live list of approved upcoming events.",
    icon: Sparkles,
  },
  {
    href: "/calendar",
    label: "Open calendar",
    description: "Jump into the month view and filter by venue or type.",
    icon: CalendarDays,
  },
  {
    href: "/admin",
    label: "Open admin",
    description: "Review moderation, ingestion quality, and venue data.",
    icon: ShieldCheck,
  },
] as const;

export default async function HomePage() {
  const showAdminActions = await isViewerAdmin();
  const homeActions = showAdminActions
    ? HOME_ACTIONS
    : HOME_ACTIONS.filter((action) => action.href !== "/admin");

  return (
    <main className="app-page justify-center">
      <section className="hero-panel relative px-7 py-10 sm:px-10 sm:py-12">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(56,189,248,0.16),_transparent_28%),radial-gradient(circle_at_bottom_right,_rgba(99,102,241,0.15),_transparent_26%)]" />
        <div className="relative grid gap-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)] lg:items-end">
          <div className="max-w-3xl space-y-5">
            <span className="app-chip border-primary/20 bg-primary/10 text-primary">
              Nightlife Event Aggregator
            </span>
            <div className="space-y-4">
              <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
                Centralize nightlife events from Instagram into a cleaner calendar workflow.
              </h1>
              <p className="max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
                The app now gives you one navigation layer for discovery, calendar browsing, and
                moderation operations so public pages and admin tooling feel like the same product.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link className="button-primary gap-2" href="/events">
                Start with events
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link className="button-secondary" href="/calendar">
                Explore calendar
              </Link>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
            <div className="metric-card">
              <p className="section-kicker">Discovery</p>
              <p className="mt-3 text-2xl font-semibold tracking-tight">Public views</p>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Upcoming events and monthly calendar pages share the same visual language now.
              </p>
            </div>
            <div className="metric-card">
              <p className="section-kicker">Operations</p>
              <p className="mt-3 text-2xl font-semibold tracking-tight">Admin tools</p>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Moderation, scraper runs, and venue maintenance remain one click away.
              </p>
            </div>
            <div className="metric-card">
              <p className="section-kicker">Quality</p>
              <p className="mt-3 text-2xl font-semibold tracking-tight">Shared confidence</p>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                UI decisions, duplicate penalties, and auto-approval rules stay aligned.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        {homeActions.map((action) => {
          const Icon = action.icon;

          return (
            <Link
              className="glass-panel group flex min-h-44 flex-col justify-between px-6 py-6"
              href={action.href}
              key={action.href}
            >
              <div className="space-y-4">
                <span className="app-chip w-fit">{action.label}</span>
                <div>
                  <Icon className="h-5 w-5 text-primary" />
                  <p className="mt-4 text-xl font-semibold tracking-tight">{action.label}</p>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    {action.description}
                  </p>
                </div>
              </div>
              <span className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-foreground">
                Open page
                <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" />
              </span>
            </Link>
          );
        })}
      </section>
    </main>
  );
}
