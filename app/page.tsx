import Link from "next/link";

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-background px-6 py-16 text-center">
      <div className="flex max-w-2xl flex-col gap-4">
        <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
          Nightlife Event Aggregator
        </p>
        <h1 className="text-3xl font-semibold sm:text-4xl">
          Centralize nightlife events from Instagram into one calendar.
        </h1>
        <p className="text-sm text-muted-foreground sm:text-base">
          We are wiring the Instagram → AI → Convex pipeline first. UI polish
          and filters will follow once data starts flowing.
        </p>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Link
          className="rounded-full bg-primary px-5 py-2 text-sm font-medium text-primary-foreground"
          href="/events"
        >
          Browse events
        </Link>
        <Link
          className="rounded-full border border-border px-5 py-2 text-sm font-medium"
          href="/calendar"
        >
          Open calendar
        </Link>
      </div>
    </main>
  );
}
