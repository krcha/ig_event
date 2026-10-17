import { AdminPageShell } from "@/components/admin/admin-page-shell";
import { VenueManager } from "@/components/admin/venue-manager";

export default function AdminVenuesPage() {
  return (
    <AdminPageShell
      active="venues"
      compact
      title="Venues"
    >
      <VenueManager />
    </AdminPageShell>
  );
}
