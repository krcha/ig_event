import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { ClerkProvider } from "@clerk/nextjs";
import { AppToolbar } from "@/components/navigation/app-toolbar";
import { NavigationFeedback } from "@/components/navigation/navigation-feedback";
import { VisitorTracker } from "@/components/analytics/visitor-tracker";
import { AuthUserProvider } from "@/components/providers/auth-user-provider";
import { UserLibraryProvider } from "@/components/providers/user-library-provider";
import { SITE_ORIGIN } from "@/lib/seo/site";
import { SITE_COPY, OG_LOCALES, localizedAbsoluteUrl } from "@/lib/i18n/seo";
import { EventsUiProvider } from "@/components/calendar/events-ui-provider";
import { InstallPrompt } from "@/components/install/install-prompt";
import { LocaleProvider } from "@/i18n/client";
import { LOCALE_LANGUAGE_TAGS, type Locale } from "@/i18n/config";
import { getLocale } from "@/i18n/server";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const copy = SITE_COPY[locale];
  return {
  metadataBase: new URL(SITE_ORIGIN),
  applicationName: "Event Zeka",
  title: {
    default: `${copy.calendarTitle} | Event Zeka`,
    template: "%s | Event Zeka",
  },
  description: copy.description,
  category: "events",
  formatDetection: {
    address: false,
    email: false,
    telephone: false,
  },
  manifest: `/api/manifest?locale=${locale}`,
  openGraph: {
    type: "website",
    locale: OG_LOCALES[locale],

    siteName: "Event Zeka",
    title: `${copy.calendarTitle} | Event Zeka`,
    description: copy.description,
    url: localizedAbsoluteUrl("/", locale),
    images: [{ url: `${SITE_ORIGIN}/api/og?locale=${locale}`, width: 1200, height: 630, alt: copy.calendarTitle }],
  },
  twitter: {
    card: "summary_large_image",
    title: `${copy.calendarTitle} | Event Zeka`,
    description: copy.description,
    images: [`${SITE_ORIGIN}/api/og?locale=${locale}`],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
};
}


export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#10141F",
};

const clerkPublishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

const clerkAppearance = {
  variables: {
    borderRadius: "1rem",
    colorBackground: "#1B2233",
    colorDanger: "#fb7185",
    colorInputBackground: "#10141F",
    colorInputText: "#F4F2EB",
    colorPrimary: "#D5F56B",
    colorText: "#F4F2EB",
    colorTextSecondary: "#A8B0C2",
  },
  elements: {
    cardBox: "bg-[#1B2233] text-[#F4F2EB] shadow-[0_34px_90px_-58px_rgba(0,0,0,0.9)]",
    footerActionLink: "text-[#D5F56B] hover:text-[#C9EB58]",
    formButtonPrimary: "bg-[#D5F56B] text-[#10141F] hover:bg-[#C9EB58]",
    modalBackdrop: "bg-black/70 backdrop-blur-sm",
  },
};

function AppDocument({
  authEnabled = false,
  locale,
  children,
}: {
  authEnabled?: boolean;
  locale: Locale;
  children: React.ReactNode;
}) {
  const appContent = (
    <div className="min-h-screen">
      <Suspense fallback={null}>
        <NavigationFeedback />
        <VisitorTracker />
      </Suspense>
      <Suspense fallback={null}>
        <AppToolbar />
      </Suspense>
      <EventsUiProvider>
        {children}
        <Suspense fallback={null}>
          <InstallPrompt />
        </Suspense>
      </EventsUiProvider>
    </div>
  );

  return (
    <html className="dark" lang={LOCALE_LANGUAGE_TAGS[locale]}>
      <head><link rel="preload" href="/fonts/space-grotesk-400.woff2" as="font" type="font/woff2" crossOrigin="anonymous" /><link rel="preload" href="/fonts/space-grotesk-700.woff2" as="font" type="font/woff2" crossOrigin="anonymous" /></head>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <LocaleProvider locale={locale}>
          {authEnabled ? (
            <AuthUserProvider>
              <UserLibraryProvider>{appContent}</UserLibraryProvider>
            </AuthUserProvider>
          ) : (
            <UserLibraryProvider authEnabled={false}>{appContent}</UserLibraryProvider>
          )}
        </LocaleProvider>
      </body>
    </html>
  );
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  if (!clerkPublishableKey) {
    return <AppDocument locale={locale}>{children}</AppDocument>;
  }

  return (
    <ClerkProvider appearance={clerkAppearance} clerkJSVariant="headless" publishableKey={clerkPublishableKey}>
      <AppDocument authEnabled locale={locale}>{children}</AppDocument>
    </ClerkProvider>
  );
}
