import { AdminPageShell } from "@/components/admin/admin-page-shell";
import { ModerationDashboard } from "@/components/admin/moderation-dashboard";

export default function AdminPage() {
  return (
    <AdminPageShell
      active="overview"
      description="Review extracted events, inspect AI evidence, and resolve edge cases quickly."
      title="Moderation Dashboard"
    >
      <ModerationDashboard />
    </AdminPageShell>
  );
}
