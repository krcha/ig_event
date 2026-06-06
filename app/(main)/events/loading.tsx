export default function EventsLoading() {
  return (
    <main className="app-page gap-4">
      <section className="hero-panel px-4 py-5 sm:px-6 sm:py-6">
        <div className="animate-pulse space-y-4">
          <div className="h-4 w-36 rounded-full bg-muted" />
          <div className="h-9 w-52 rounded-2xl bg-muted" />
          <div className="h-12 rounded-full bg-muted" />
          <div className="flex gap-2">
            <div className="h-7 w-24 rounded-full bg-muted" />
            <div className="h-7 w-24 rounded-full bg-muted" />
          </div>
        </div>
      </section>
      <section className="glass-panel px-3 py-3 sm:px-5 sm:py-5">
        <div className="grid gap-3 lg:grid-cols-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <div className="h-44 animate-pulse rounded-[1.25rem] bg-muted" key={index} />
          ))}
        </div>
      </section>
    </main>
  );
}
