import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { ClerkProvider } from "@clerk/nextjs";
import { AppToolbar } from "@/components/navigation/app-toolbar";
import { NavigationFeedback } from "@/components/navigation/navigation-feedback";
import { AuthUserProvider } from "@/components/providers/auth-user-provider";
import { ConvexClientProvider } from "@/components/providers/convex-client-provider";
import { UserLibraryProvider } from "@/components/providers/user-library-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Belgrade Events — Nightlife calendar",
  description: "A dark, mobile-first calendar for Belgrade nightlife, concerts, club nights, and culture.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#050609",
};

const clerkPublishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

const clerkAppearance = {
  variables: {
    borderRadius: "1rem",
    colorBackground: "#0B0D12",
    colorDanger: "#fb7185",
    colorInputBackground: "#11141B",
    colorInputText: "#F7F8F8",
    colorPrimary: "#8B86FB",
    colorText: "#F7F8F8",
    colorTextSecondary: "#939AA7",
  },
  elements: {
    cardBox: "bg-[#0B0D12] text-[#F7F8F8] shadow-[0_34px_90px_-58px_rgba(0,0,0,0.9)]",
    footerActionLink: "text-[#8B86FB] hover:text-[#A6A2FF]",
    formButtonPrimary: "bg-[#8B86FB] text-[#080A17] hover:bg-[#A6A2FF]",
    modalBackdrop: "bg-black/70 backdrop-blur-sm",
  },
};

function AppDocument({
  authEnabled = false,
  children,
}: {
  authEnabled?: boolean;
  children: React.ReactNode;
}) {
  const appContent = (
    <ConvexClientProvider authEnabled={authEnabled}>
      <div className="min-h-screen">
        <Suspense fallback={null}>
          <NavigationFeedback />
        </Suspense>
        <AppToolbar />
        {children}
      </div>
    </ConvexClientProvider>
  );

  return (
    <html className="dark" lang="en">
      <body className="min-h-screen bg-background text-foreground antialiased">
        {authEnabled ? (
          <AuthUserProvider>
            <UserLibraryProvider>{appContent}</UserLibraryProvider>
          </AuthUserProvider>
        ) : (
          appContent
        )}
      </body>
    </html>
  );
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  if (!clerkPublishableKey) {
    return <AppDocument>{children}</AppDocument>;
  }

  return (
    <ClerkProvider appearance={clerkAppearance} publishableKey={clerkPublishableKey}>
      <AppDocument authEnabled>{children}</AppDocument>
    </ClerkProvider>
  );
}
