export default function Loading() {
  return (
    <main className="app-page justify-center">
      <section className="hero-panel px-4 py-5 sm:px-6 sm:py-6">
        <div className="animate-pulse space-y-4">
          <div className="h-5 w-32 rounded-full bg-muted" />
          <div className="h-10 w-4/5 max-w-2xl rounded-2xl bg-muted" />
          <div className="h-4 w-3/5 rounded-full bg-muted" />
          <div className="grid gap-3 pt-3 sm:grid-cols-3">
            <div className="h-28 rounded-[1.15rem] bg-muted" />
            <div className="h-28 rounded-[1.15rem] bg-muted" />
            <div className="h-28 rounded-[1.15rem] bg-muted" />
          </div>
        </div>
      </section>
    </main>
  );
}
