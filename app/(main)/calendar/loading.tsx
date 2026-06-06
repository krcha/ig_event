export default function CalendarLoading() {
  return (
    <main className="app-page app-page-wide gap-4">
      <section className="hero-panel px-4 py-5 sm:px-5 sm:py-6">
        <div className="animate-pulse space-y-4">
          <div className="h-4 w-24 rounded-full bg-muted" />
          <div className="h-9 w-48 rounded-2xl bg-muted" />
          <div className="h-11 rounded-[1.2rem] bg-muted" />
        </div>
      </section>
      <section className="glass-panel px-4 py-4 lg:hidden">
        <div className="flex gap-2 overflow-hidden">
          {Array.from({ length: 5 }).map((_, index) => (
            <div className="h-24 min-w-[4.45rem] animate-pulse rounded-[1rem] bg-muted" key={index} />
          ))}
        </div>
        <div className="mt-4 h-72 animate-pulse rounded-[1.35rem] bg-muted" />
      </section>
      <section className="hidden overflow-hidden rounded-[1.5rem] border border-border/80 bg-card/95 lg:block">
        <div className="grid grid-cols-7">
          {Array.from({ length: 35 }).map((_, index) => (
            <div className="h-28 animate-pulse border-r border-b border-border/75 bg-muted/60" key={index} />
          ))}
        </div>
      </section>
    </main>
  );
}
