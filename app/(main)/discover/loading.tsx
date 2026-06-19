export default function DiscoverLoading() {
  return (
    <main className="app-page gap-3 sm:gap-4">
      <div className="mx-auto flex w-full max-w-[38rem] flex-col gap-3 sm:gap-4">
        <header className="px-1 py-1 sm:px-0">
          <div className="animate-pulse space-y-4">
            <div className="h-4 w-32 rounded-full bg-muted" />
            <div className="h-10 w-44 rounded-2xl bg-muted" />
            <div className="h-4 w-56 rounded-full bg-muted" />
          </div>
        </header>
        {Array.from({ length: 3 }).map((_, index) => (
          <section
            className="overflow-hidden rounded-[1.25rem] border border-border/75 bg-card/70"
            key={index}
          >
            <div className="flex items-center gap-3 border-b border-border/70 px-3 py-3">
              <div className="h-10 w-10 animate-pulse rounded-full bg-muted" />
              <div className="space-y-2">
                <div className="h-4 w-32 animate-pulse rounded-full bg-muted" />
                <div className="h-3 w-24 animate-pulse rounded-full bg-muted" />
              </div>
            </div>
            <div className="aspect-[4/5] animate-pulse bg-muted" />
            <div className="space-y-3 px-3 py-4">
              <div className="flex items-center justify-between">
                <div className="h-10 w-24 animate-pulse rounded-full bg-muted" />
                <div className="h-10 w-10 animate-pulse rounded-full bg-muted" />
              </div>
              <div className="h-4 w-11/12 animate-pulse rounded-full bg-muted" />
              <div className="h-4 w-2/3 animate-pulse rounded-full bg-muted" />
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
