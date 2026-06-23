import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { canAccessAdminSurface } from "@/lib/auth/admin";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  if (!(await canAccessAdminSurface())) {
    notFound();
  }

  return children;
}
