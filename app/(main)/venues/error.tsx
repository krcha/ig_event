"use client";

import { useEffect } from "react";

type VenueErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function VenueError({ error, reset }: VenueErrorProps) {
  useEffect(() => {
    console.error("Venue route error", error);
  }, [error]);

  return (
    <main className="app-page">
      <section className="hero-panel mx-auto w-full max-w-xl px-4 py-10 text-center sm:px-6">
        <p className="section-kicker">Belgrade venues</p>
        <h1 className="mt-3 text-2xl font-semibold text-foreground">Venues could not load</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Refresh to load the latest venue information.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <button className="button-primary" onClick={reset} type="button">
            Try again
          </button>
          <a className="button-secondary" href="/">
            Browse calendar
          </a>
        </div>
      </section>
    </main>
  );
}
