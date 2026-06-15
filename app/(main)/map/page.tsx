import { CalendarDays, Map } from "lucide-react";

export default function MapPage() {
  return (
    <main className="app-page gap-3 sm:gap-4">
      <section className="hero-panel px-4 py-6 sm:px-6 lg:px-8">
        <div className="flex items-start gap-3">
          <span className="inline-flex h-11 w-11 flex-none items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-[0_18px_44px_-28px_rgba(139,134,251,0.85)]">
            <Map className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="section-kicker">Map</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              Tonight on the map
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
              A map view for tonight&apos;s events is coming soon. For now, use Events to browse by date and Saved to keep plans.
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-[1.5rem] border border-dashed border-border/80 bg-card/70 px-4 py-10 text-center sm:px-6">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-white/[0.04] text-primary">
          <CalendarDays className="h-6 w-6" />
        </div>
        <h2 className="mt-4 text-lg font-semibold text-foreground">Coming soon</h2>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
          This tab is reserved for plotted events near you, starting with tonight&apos;s approved listings.
        </p>
      </section>
    </main>
  );
}
