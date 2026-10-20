import { AdminPageShell } from "@/components/admin/admin-page-shell";
import { VenueManager } from "@/components/admin/venue-manager";

export default function AdminVenuesPage() {
  return (
    <AdminPageShell
      active="venues"
      description="Keep canonical venue names and Instagram handles clean so AI output stays consistent."
      title="Venue Manager"
    >
      <VenueManager />
    </AdminPageShell>
  );
}
