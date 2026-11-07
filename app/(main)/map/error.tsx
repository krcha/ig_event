"use client";
import { LocalizedElement } from "@/components/i18n/public-text";

import { PublicText } from "@/components/i18n/public-text";


import { useEffect } from "react";

type EventMapErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function EventMapError({ error, reset }: EventMapErrorProps) {
  useEffect(() => {
    console.error("Event map route error", error);
  }, [error]);

  return (
    <main className="app-page">
      <section className="hero-panel mx-auto w-full max-w-xl px-4 py-10 text-center sm:px-6">
        <p className="section-kicker"><PublicText text={"Belgrade event map"} /></p>
        <h1 className="mt-3 text-2xl font-semibold text-foreground"><PublicText text={"The event map could not load"} /></h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground"><PublicText text={"Refresh to load the latest events and their locations."} /></p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <button className="button-primary" onClick={reset} type="button"><PublicText text={"Try again"} /></button>
          <LocalizedElement as="a" className="button-secondary" href="/"><PublicText text={"Browse calendar"} /></LocalizedElement>
        </div>
      </section>
    </main>
  );
}
