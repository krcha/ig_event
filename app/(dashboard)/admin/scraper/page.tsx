import { AdminPageShell } from "@/components/admin/admin-page-shell";
import { ScraperDashboard } from "@/components/admin/scraper-dashboard";

export default function AdminScraperPage() {
  return (
    <AdminPageShell
      active="scraper"
      description="Run fresh scrapes, import recent Apify history, reprocess saved posts, and inspect ingestion health."
      title="Scraper Operations"
    >
      <ScraperDashboard />
    </AdminPageShell>
  );
}
