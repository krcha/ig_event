import { getLocale as getMetadataLocale } from "@/i18n/server";
import { localizedMetadata, SITE_COPY } from "@/lib/i18n/seo";
import type { Metadata } from "next";
import { InstallGuide } from "@/components/install/install-guide";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getMetadataLocale();
  return localizedMetadata({ locale, path: "/install", title: SITE_COPY[locale].installTitle, description: SITE_COPY[locale].installDescription });
}

export default function InstallPage() {
  return <InstallGuide />;
}
