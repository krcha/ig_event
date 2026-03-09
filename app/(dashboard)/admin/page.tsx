import Link from "next/link";
import { ModerationDashboard } from "@/components/admin/moderation-dashboard";

export default function AdminPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-4 px-6 py-10">
      <h1 className="text-2xl font-semibold">Admin Dashboard</h1>
      <p className="text-sm text-muted-foreground">
        Manage venues, trigger scrapes, and review extracted events.
      </p>
      <div className="flex flex-wrap gap-4 text-sm">
        <Link className="text-primary underline" href="/admin/scraper">
          Scraper controls
        </Link>
        <Link className="text-primary underline" href="/admin/venues">
          Venue management
        </Link>
      </div>
      <ModerationDashboard />
    </main>
  );
}
