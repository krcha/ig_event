import Link from "next/link";

export default function CalendarPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Calendar</h1>
        <p className="text-sm text-muted-foreground">
          Monthly and weekly event views will live here.
        </p>
      </header>
      <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
        Calendar UI coming soon. We will prioritize the scraper pipeline next.
      </div>
      <Link className="text-sm text-primary underline" href="/events">
        Switch to list view
      </Link>
    </main>
  );
}
