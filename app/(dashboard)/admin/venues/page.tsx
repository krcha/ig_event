import { VenueManager } from "@/components/admin/venue-manager";

export default function AdminVenuesPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-4 px-6 py-10">
      <h1 className="text-2xl font-semibold">Venue Manager</h1>
      <p className="text-sm text-muted-foreground">
        Add and maintain the Instagram accounts we monitor.
      </p>
      <VenueManager />
    </main>
  );
}
