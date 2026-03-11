import { AdminPageShell } from "@/components/admin/admin-page-shell";
import { ScraperDashboard } from "@/components/admin/scraper-dashboard";

export default function AdminScraperPage() {
  return (
    <AdminPageShell
      active="scraper"
      description="Start the venue ingestion pipeline from a fresh Apify scrape, recent Apify run data, or saved posts already in Convex."
      title="Scraper Operations"
    >
      <ScraperDashboard />
    </AdminPageShell>
  );
}
