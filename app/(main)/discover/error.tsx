"use client";
import { LocalizedElement } from "@/components/i18n/public-text";

import { PublicText } from "@/components/i18n/public-text";


import { useEffect } from "react";

type DiscoverErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function DiscoverError({ error, reset }: DiscoverErrorProps) {
  useEffect(() => {
    console.error("Discover route error", error);
  }, [error]);

  return (
    <main className="app-page gap-3 sm:gap-4">
      <section className="hero-panel mx-auto w-full max-w-xl px-4 py-10 text-center sm:px-6">
        <p className="section-kicker"><PublicText text={"Discover"} /></p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-foreground"><PublicText text={"The feed needs a quick refresh"} /></h1>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground"><PublicText text={"Event Zeka could not finish loading this set of picks. Retry it here or reload a clean copy of the page."} /></p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <button className="button-primary min-h-10 px-4 py-0" onClick={reset} type="button"><PublicText text={"Try again"} /></button>
          <LocalizedElement as="a" className="button-secondary min-h-10 px-4 py-0" href="/discover"><PublicText text={"Reload Discover"} /></LocalizedElement>
        </div>
      </section>
    </main>
  );
}
