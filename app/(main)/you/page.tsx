import type { Metadata } from "next";
import { Download } from "lucide-react";
import { YouProfilePanel } from "@/components/auth/you-profile-panel";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Your profile",
  robots: { index: false, follow: false },
};

export default function YouPage() {
  const installLink = (
    <a className="button-secondary mx-auto gap-2" href="/install#install-guide-title" lang="sr-Latn">
      <Download aria-hidden="true" className="h-4 w-4" />
      Instaliraj EventZeka App
    </a>
  );

  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    return (
      <main className="app-page gap-3 sm:gap-4" lang="sr-Latn">
        <section className="hero-panel px-4 py-8 text-center sm:px-6">
          <h1 className="text-2xl font-semibold tracking-[-0.025em] sm:text-4xl">
            Prijava trenutno nije dostupna
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
            Pokušaj ponovo kasnije. Sačuvani događaji na ovom uređaju ostaju dostupni u Saved.
          </p>
          <Link className="button-secondary mt-4 min-h-11 px-4" href="/">Nazad na događaje</Link>
        </section>
        {installLink}
      </main>
    );
  }

  return (
    <main className="app-page gap-3 pb-[calc(7.5rem+env(safe-area-inset-bottom))] sm:gap-4 md:pb-9">
      <YouProfilePanel />
      {installLink}
    </main>
  );
}
