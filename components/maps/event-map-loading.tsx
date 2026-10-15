import "./event-calendar-map.css";

export function EventMapLoading() {
  return (
    <main aria-busy="true" aria-label="Loading event map" className="app-page event-calendar-page gap-4">
      <section className="hero-panel hidden px-4 py-5 sm:px-6 lg:block">
        <div className="animate-pulse space-y-4">
          <div className="h-4 w-24 rounded-full bg-muted" />
          <div className="h-9 w-60 rounded-2xl bg-muted" />
          <div className="h-16 rounded-[1rem] bg-muted" />
        </div>
      </section>
      <div className="event-calendar-layout grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="h-full animate-pulse rounded-[1.5rem] border border-border/75 bg-muted/60 lg:h-[38rem]" />
        <div className="hidden space-y-3 lg:block">
          {Array.from({ length: 3 }, (_, index) => (
            <div className="h-28 animate-pulse rounded-[1rem] bg-muted/60" key={index} />
          ))}
        </div>
      </div>
    </main>
  );
}
