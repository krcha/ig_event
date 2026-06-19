export default function DiscoverLoading() {
  return (
    <main className="app-page app-page-wide gap-4">
      <section className="hero-panel px-4 py-5 sm:px-6 sm:py-6">
        <div className="animate-pulse space-y-4">
          <div className="h-4 w-32 rounded-full bg-muted" />
          <div className="h-10 w-44 rounded-2xl bg-muted" />
          <div className="h-4 w-56 rounded-full bg-muted" />
        </div>
      </section>
      <section className="h-[31rem] animate-pulse rounded-[1.4rem] border border-border/75 bg-muted" />
      <section className="space-y-3">
        <div className="h-6 w-36 rounded-full bg-muted" />
        <div className="flex gap-3 overflow-hidden">
          {Array.from({ length: 4 }).map((_, index) => (
            <div
              className="aspect-[4/5] w-[72vw] max-w-[18rem] flex-none animate-pulse rounded-[1.15rem] bg-muted sm:w-64"
              key={index}
            />
          ))}
        </div>
      </section>
    </main>
  );
}
