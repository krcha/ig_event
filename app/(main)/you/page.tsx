import { YouProfilePanel } from "@/components/auth/you-profile-panel";

export default function YouPage() {
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    return (
      <main className="app-page gap-3 sm:gap-4">
        <section className="hero-panel px-4 py-8 text-center sm:px-6">
          <p className="section-kicker">Profile</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-[-0.045em] sm:text-4xl">
            Profiles are unavailable right now.
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
            Sign-in is temporarily offline, so saved events and followed places cannot load.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="app-page gap-3 pb-[calc(7.5rem+env(safe-area-inset-bottom))] sm:gap-4 md:pb-9">
      <YouProfilePanel />
    </main>
  );
}
