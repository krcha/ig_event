import type { Metadata } from "next";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { canAccessAdminSurface } from "@/lib/auth/admin";

// Missing build-time auth configuration must not cache a permanent admin 404.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false },
};

export default async function AdminLayout({ children }: { children: ReactNode }) {
  if (!(await canAccessAdminSurface())) {
    notFound();
  }

  return children;
}
