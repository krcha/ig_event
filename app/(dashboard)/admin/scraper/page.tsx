import { ScraperDashboard } from "@/components/admin/scraper-dashboard";

export default function AdminScraperPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-4 px-6 py-10">
      <h1 className="text-2xl font-semibold">Scraper Dashboard</h1>
      <p className="text-sm text-muted-foreground">
        Trigger manual scrapes and monitor pipeline status.
      </p>
      <ScraperDashboard />
    </main>
  );
}
