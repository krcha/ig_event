import type { Metadata } from "next";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { canAccessAdminSurface } from "@/lib/auth/admin";

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
