export default function EventsLoading({ day }: { day?: string } = {}) {
  return (
    <main aria-busy="true" aria-label="Učitavanje događaja" className="app-page app-page-wide gap-4" data-calendar-loading-day={day ?? "today"} role="status">
      <span className="sr-only">Učitavanje događaja</span>
      <div aria-hidden="true" className="space-y-4 motion-safe:animate-pulse">
        <div className="h-10 w-52 rounded-xl bg-muted" />
        <div className="h-12 rounded-2xl border border-border bg-card" />
        <div className="grid grid-cols-7 gap-1">
          {Array.from({ length: 7 }, (_, index) => <div className="h-[68px] rounded-xl bg-muted" key={index} />)}
        </div>
        <div className="flex h-[52px] items-center gap-2 overflow-hidden">
          {Array.from({ length: 4 }, (_, index) => <div className="h-9 w-24 flex-none rounded-full bg-muted" key={index} />)}
        </div>
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, index) => <div className="h-[76px] rounded-2xl border border-border bg-card" key={index} />)}
        </div>
      </div>
    </main>
  );
}
