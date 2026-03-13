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

const PRODUCT_NOTES = [
  {
    label: "Discover fast",
    description: "Cards, spacing, and actions are tuned to be thumb-friendly before they scale up.",
  },
  {
    label: "Browse by month",
    description: "Calendar exploration stays useful on a phone instead of collapsing into a tiny desktop grid.",
  },
  {
    label: "Keep ops close",
    description: "Moderation and scraper tools still live inside the same product shell for admins.",
  },
] as const;

export default async function HomePage() {
  const showAdminActions = await isViewerAdmin();
  const homeActions = showAdminActions
    ? HOME_ACTIONS
    : HOME_ACTIONS.filter((action) => action.href !== "/admin");

  return (
    <main className="app-page justify-center">
      <section className="hero-panel relative px-5 py-6 sm:px-8 sm:py-8">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(14,165,233,0.16),_transparent_28%),radial-gradient(circle_at_bottom_right,_rgba(20,184,166,0.14),_transparent_26%)]" />
        <div className="relative grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(18rem,0.85fr)] xl:items-end">
          <div className="max-w-3xl space-y-5">
            <span className="app-chip border-primary/20 bg-primary/10 text-primary">
              Mobile-first nightlife product
            </span>
            <div className="space-y-3">
              <h1 className="max-w-3xl text-[2.45rem] font-semibold tracking-tight text-foreground sm:text-5xl">
                Discover Belgrade events in a product flow that feels built for your phone first.
              </h1>
              <p className="max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base sm:leading-7">
                Browse upcoming events, switch into a month view, and jump into moderation without
                the experience falling back to a cramped desktop layout.
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Link className="button-primary w-full gap-2 sm:w-auto" href="/events">
                Start with events
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link className="button-secondary w-full sm:w-auto" href="/calendar">
                Explore calendar
              </Link>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="metric-card">
                <p className="section-kicker">Default</p>
                <p className="mt-3 text-2xl font-semibold tracking-tight">Cards first</p>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Primary browsing surfaces start stacked, readable, and tappable.
                </p>
              </div>
              <div className="metric-card">
                <p className="section-kicker">Calendar</p>
                <p className="mt-3 text-2xl font-semibold tracking-tight">Day focus</p>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Mobile browsing keeps the month useful with a selected-day agenda.
                </p>
              </div>
              <div className="metric-card">
                <p className="section-kicker">Shared shell</p>
                <p className="mt-3 text-2xl font-semibold tracking-tight">One product</p>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Public discovery and admin operations stay visually connected.
                </p>
              </div>
            </div>
          </div>

          <div className="glass-panel px-4 py-4 sm:px-5 sm:py-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="section-kicker">Product pulse</p>
                <h2 className="mt-1 text-xl font-semibold tracking-tight">What the redesign optimizes</h2>
              </div>
              <span className="app-chip border-primary/20 bg-primary/8 text-primary">
                Touch-first
              </span>
            </div>

            <div className="mt-4 space-y-3">
              {PRODUCT_NOTES.map((note, index) => (
                <div
                  className="rounded-[1.35rem] border border-border/75 bg-card/88 px-4 py-4 shadow-[0_18px_36px_-30px_rgba(15,23,42,0.2)]"
                  key={note.label}
                >
                  <div className="flex items-start gap-3">
                    <div className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-primary/[0.1] text-sm font-semibold text-primary">
                      {index + 1}
                    </div>
                    <div>
                      <p className="text-sm font-semibold tracking-tight text-foreground">
                        {note.label}
                      </p>
                      <p className="mt-1 text-sm leading-6 text-muted-foreground">
                        {note.description}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 rounded-[1.35rem] border border-primary/15 bg-primary/[0.07] px-4 py-4">
              <p className="section-kicker text-primary">Quick start</p>
              <p className="mt-2 text-base font-semibold tracking-tight text-foreground">
                Open events if you want the fastest path into the refreshed browsing flow.
              </p>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Calendar is better for date-led exploration, while admin remains available when you
                need to review ingestion quality.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-3 lg:grid-cols-3">
        {homeActions.map((action) => {
          const Icon = action.icon;

          return (
            <Link
              className="glass-panel group flex min-h-44 flex-col justify-between px-5 py-5 sm:px-6 sm:py-6"
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
