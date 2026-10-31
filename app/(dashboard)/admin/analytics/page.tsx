import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { AdminPageShell } from "@/components/admin/admin-page-shell";
import { AnalyticsDashboard } from "@/components/admin/analytics-dashboard";
import { isAnalyticsOwner } from "@/lib/analytics/access";
import { hasClerkEnv } from "@/lib/utils/env";

export const metadata: Metadata = { title: "Visitor analytics" };

export default async function AnalyticsPage() {
  if (!hasClerkEnv()) notFound();
  const { userId } = await auth();
  if (!isAnalyticsOwner(userId, process.env)) notFound();
  return (
    <AdminPageShell active="analytics" compact title="Visitor analytics">
      <AnalyticsDashboard />
    </AdminPageShell>
  );
}
