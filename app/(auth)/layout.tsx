import { getLocale as getMetadataLocale } from "@/i18n/server";
import { SITE_COPY } from "@/lib/i18n/seo";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getMetadataLocale();
  return { title: SITE_COPY[locale].accountTitle, robots: { index: false, follow: false } };
}

export default function AuthLayout({ children }: { children: ReactNode }) {
  return children;
}
